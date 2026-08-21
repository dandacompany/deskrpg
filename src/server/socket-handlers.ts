import { Server, Socket } from "socket.io";
import type { NpcAdapter } from "../lib/adapters/types";
import { jwtVerify } from "jose";
import { eq, and } from "drizzle-orm";
import {
  db,
  channels,
  npcs,
  channelMembers,
  tasks,
  npcReports,
  characters,
  groupMembers,
  meetingMinutes,
  jsonForDb,
} from "../db";
import { extractFileContent, buildFilePromptSection, buildAttachments, isAllowedFileType, FILE_LIMITS } from "@/lib/file-extractor";
import type { ExtractedFile, OpenClawAttachment } from "@/lib/file-extractor";

const DEBUG_CHAT = process.env.DEBUG_CHAT === "1" || process.env.DEBUG_CHAT === "true";
function chatLog(...args: unknown[]) { if (DEBUG_CHAT) console.log("[npc:chat]", ...args); }

import { parseDbObject } from "../lib/db-json";
import { getGatewayRuntimeConfigForChannel } from "../lib/gateway-resources";
import {
  buildChannelAccessDeniedPayload,
  type ChannelAccessDeniedReason,
  summarizeChannelParticipationAccess,
} from "../lib/rbac/channel-access";
import {
  type NpcResponseMessageCode,
  type NpcResponsePayload,
} from "../lib/npc-response-messages";
import {
  buildAutoExecutionPrompt,
  buildCompletionReportRow,
  buildResumeTaskExecutionPrompt,
  buildTaskActionStartMessage,
  buildQueuedReportRow,
  buildManualTaskReportPrompt,
  enqueueCompletionReport,
  getReportsByTaskId,
  enqueueQueuedReport,
  getProgressNudgeCutoff,
  getPendingReportsForUserAndChannel,
  getTaskAutomationConfig,
  markReportConsumed,
  markReportDelivered,
  shouldDeliverCompletionReport,
  toReportReadyPayload,
} from "../lib/task-reporting";
import {
  deliverMeetingNpcAnswer,
  emitMeetingNpcStream,
  registerMeetingSocketHandlers,
} from "./meeting-socket";
import { registerMeetingDiscussionHandlers } from "./meeting-discussion";
import { AdapterRegistry } from "../lib/adapters/types.js";
import { OpenClawAdapter } from "../lib/adapters/openclaw-adapter.js";
import { ClaudeAdapter } from "../lib/adapters/claude-adapter.js";
import { CodexAdapter } from "../lib/adapters/codex-adapter.js";
import { GeminiAdapter } from "../lib/adapters/gemini-adapter.js";
import { OpencodeAdapter as OpenCodeAdapter } from "../lib/adapters/opencode-adapter.js";
import { dmHub } from "../lib/adapters/dm-hub.js";
import {
  classifyNpcDispatch,
  clearHermesRun,
  createHermesAdapterForNpc,
  deriveHermesContextKey,
  persistHermesSessionRef,
  registerHermesRun,
} from "./hermes-dispatch";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { OpenClawGateway } = require("../lib/openclaw-gateway.js") as { OpenClawGateway: new () => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseNpcResponse, isValidTaskAction } = require("../lib/task-parser.js") as typeof import("../lib/task-parser.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeNpcResponseText } = require("../lib/task-block-utils.js") as typeof import("../lib/task-block-utils.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TaskManager } = require("../lib/task-manager.js") as { TaskManager: new (db: typeof import("../db").db, schema: { tasks: typeof tasks; npcs: typeof npcs }) => { handleTaskAction: (...args: unknown[]) => Promise<unknown>; getTasksByNpc: (npcId: string) => Promise<unknown[]>; getTasksByChannel: (channelId: string) => Promise<unknown[]>; deleteTask: (taskId: string, channelId: string) => Promise<unknown>; getStaleInProgressTasks: (channelId: string, olderThanIso: string) => Promise<unknown[]>; markTaskNudged: (taskId: string, channelId: string) => Promise<unknown>; markTaskStalled: (taskId: string, channelId: string, reason: string) => Promise<unknown>; resumeTask: (taskId: string, channelId: string) => Promise<unknown>; completeTask: (taskId: string, channelId: string) => Promise<unknown>; createBacklogTask: (channelId: string, assignerId: string, title: string, summary: string | null) => Promise<unknown>; moveTask: (taskId: string, channelId: string, toStatus: string, npcId: string | null, options?: { expectedFromStatus?: string }) => Promise<unknown>; getTaskById: (taskId: string, channelId: string) => Promise<unknown>; getTaskByNpcTaskId: (npcId: string, npcTaskId: string) => Promise<unknown>; hasInProgressTask: (npcId: string, channelId: string) => Promise<boolean>; getNextPendingTask: (npcId: string, channelId: string) => Promise<ManagedTask | null>; }; };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withTaskReminder, normalizeTaskPromptLocale, buildTaskSessionPrompt } = require("../lib/task-prompt.js") as typeof import("../lib/task-prompt.js");

const adapterRegistry = new AdapterRegistry();
const openclawAdapter = new OpenClawAdapter();
adapterRegistry.register(openclawAdapter);

// Register CLI adapters when the corresponding local CLI is installed.
for (const AdapterClass of [ClaudeAdapter, CodexAdapter, GeminiAdapter, OpenCodeAdapter]) {
  const adapter = new AdapterClass();
  void adapter.testConnection({}).then((result) => {
    if (result.status === "ok") {
      adapterRegistry.register(adapter);
      console.log("[adapters] Registered", adapter.type, "adapter (", result.version, ")");
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerState {
  id: string; // socket.id
  userId: string;
  characterId: string;
  characterName: string;
  appearance: unknown;
  mapId: string;
  x: number;
  y: number;
  direction: string;
  animation: string;
}

interface ChannelChatMessage {
  id: string;
  sender: string;
  senderId: string;
  content: string;
  timestamp: number;
}

interface NpcConfig {
  id: string;
  name: string;
  agentId: string | null;
  sessionKeyPrefix: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  hermesProfileId: string | null;
  _channelId: string;
  _name: string;
  role?: string | null;
  passPolicy?: string | null;
}

// ---------------------------------------------------------------------------
// Meeting room types
// ---------------------------------------------------------------------------

interface MeetingMessage {
  id: string;
  sender: string;
  senderId: string;
  senderType: "user" | "npc";
  content: string;
  timestamp: number;
}

interface MeetingRoom {
  participants: Set<string>;
  messages: MeetingMessage[];
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const players = new Map<string, PlayerState>();

// Rate limit: socketId -> last message timestamp
const lastChatTime = new Map<string, number>();

// Channel chat history: channelId -> message[] (kept for session lifetime)
const channelChatHistory = new Map<string, ChannelChatMessage[]>();

// Meeting rooms: channelId -> MeetingRoom
const meetingRooms = new Map<string, MeetingRoom>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeBrokers = new Map<string, any>();
const discussionInitiators = new Map<string, string>();

// NPC chat history: `${channelId}:${npcId}` -> [{ role, content, timestamp }]
const npcChatHistory = new Map<string, { role: "player" | "npc"; content: string; timestamp: number }[]>();

// OpenClaw gateway connections: gatewayId -> gateway instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const channelGateways = new Map<string, any>();

const CHAT_COOLDOWN_MS = 2000;
const PROGRESS_NUDGE_SCAN_MS = 60_000;
const taskManager = new TaskManager(db, { tasks, npcs });
const progressNudgeInFlight = new Set<string>();
const progressNudgeCooldowns = new Map<string, number>();
let progressNudgeTimer: NodeJS.Timeout | null = null;

function getSocketLocale(socket: Socket) {
  const cookieHeader = socket.handshake.headers.cookie || "";
  const localeMatch = cookieHeader.match(/(?:^|;\s*)deskrpg-locale=([^;]+)/);
  return normalizeTaskPromptLocale(localeMatch?.[1]);
}

type ManagedTask = {
  id: string;
  channelId: string;
  npcId: string;
  assignerId: string;
  npcTaskId: string;
  title: string;
  summary?: string | null;
  status: string;
  autoNudgeCount?: number | null;
  autoNudgeMax?: number | null;
};

function emitNpcSystemResponse(
  socket: Socket,
  npcId: string,
  messageCode: NpcResponseMessageCode,
) {
  const payload: NpcResponsePayload = {
    npcId,
    chunk: "",
    done: true,
    messageCode,
  };
  socket.emit("npc:response", payload);
}

function getJoinedSocketsForUserAndChannel(
  io: Server,
  userId: string,
  channelId: string,
) {
  return Array.from(players.values())
    .filter((player) => player.userId === userId && player.mapId === channelId)
    .map((player) => io.sockets.sockets.get(player.id))
    .filter((joinedSocket): joinedSocket is Socket => Boolean(joinedSocket));
}

// ---------------------------------------------------------------------------
// Cross-process bridge accessors (read-only)
//
// server.js runs Socket.io's connection handling entirely inside this
// module now, so its `players` map is private to this file. The internal
// HTTP bridges in server.js (loopback endpoints on SOCKET_PORT, used by
// Next.js API routes running in the same process) still need to answer
// "who is in this room" and "which socket(s) belong to this user" without
// server.js owning a second, permanently-empty copy of player state.
// ---------------------------------------------------------------------------

/** User IDs of players currently joined to a Socket.io room (channel). */
export function getRoomUserIds(io: Server, channelId: string): string[] {
  const roomSockets = io.sockets.adapter.rooms.get(channelId);
  if (!roomSockets) return [];

  const userIds: string[] = [];
  for (const socketId of roomSockets) {
    const player = players.get(socketId);
    if (player?.userId) userIds.push(player.userId);
  }
  return userIds;
}

/** Socket IDs currently associated with a given user (across all channels). */
export function getSocketIdsForUser(userId: string): string[] {
  const socketIds: string[] = [];
  for (const player of players.values()) {
    if (player.userId === userId) socketIds.push(player.id);
  }
  return socketIds;
}

/**
 * Given all socket ids currently associated with a user and the socket id
 * that is joining right now, return the ids of prior sessions that must be
 * kicked to enforce single-session-per-user. Excludes the joining socket
 * itself (a socket must never kick its own connection).
 */
export function getSocketIdsToKick(existingSocketIds: string[], joiningSocketId: string): string[] {
  return existingSocketIds.filter((id) => id !== joiningSocketId);
}

function appendNpcHistoryMessage(channelId: string, npcId: string, content: string) {
  const sanitizedContent = sanitizeNpcResponseText(content);
  if (!sanitizedContent.trim()) return null;
  const historyKey = `${channelId}:${npcId}`;
  const history = npcChatHistory.get(historyKey) || [];
  history.push({ role: "npc", content: sanitizedContent, timestamp: Date.now() });
  npcChatHistory.set(historyKey, history);
  return sanitizedContent;
}

function appendNpcHistoryMessageForUser(
  io: Server,
  userId: string,
  channelId: string,
  npcId: string,
  content: string,
) {
  const sanitizedContent = appendNpcHistoryMessage(channelId, npcId, content);
  if (!sanitizedContent) return;

  const joinedSockets = getJoinedSocketsForUserAndChannel(io, userId, channelId);
  for (const joinedSocket of joinedSockets) {
    joinedSocket.emit("npc:history-append", { npcId, message: sanitizedContent });
  }
}

async function deliverPendingReportsToSocket(
  socket: Socket,
  userId: string,
  channelId: string,
) {
  const pendingReports = await getPendingReportsForUserAndChannel(
    db,
    { npcReports },
    { userId, channelId },
  );

  for (const report of pendingReports) {
    const npcConfig = await getNpcConfig(report.npcId);
    socket.emit("npc:report-ready", toReportReadyPayload(report, npcConfig?._name));
    await markReportDelivered(db, { npcReports }, report.id);
  }
}

async function getAssignerUserId(assignerId: string) {
  const rows = await db
    .select({ userId: characters.userId })
    .from(characters)
    .where(eq(characters.id, assignerId))
    .limit(1);

  return rows[0]?.userId ?? null;
}

async function getChannelTaskAutomation(channelId: string) {
  const rows = await db
    .select({ gatewayConfig: channels.gatewayConfig })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return getTaskAutomationConfig(rows[0]?.gatewayConfig ?? null);
}

async function processNpcTaskActions(
  io: Server,
  parsed: { message: string; tasks: unknown[] },
  input: {
    channelId: string;
    npcId: string;
    npcName: string;
    assignerCharacterId: string;
    targetUserId: string;
  },
) {
  const taskAutomation = await getChannelTaskAutomation(input.channelId);

  for (const taskAction of parsed.tasks) {
    if (!isValidTaskAction(taskAction)) {
      console.warn("[TaskManager] Invalid task action:", taskAction);
      continue;
    }

    try {
      const task = await taskManager.handleTaskAction(
        taskAction,
        input.channelId,
        input.npcId,
        input.assignerCharacterId,
        { autoNudgeMax: taskAutomation.autoProgressNudgeMax },
      ) as ManagedTask | null;

      if (!task) continue;

      const action = (taskAction as { action: string }).action;
      io.to(input.channelId).emit("task:updated", { task, action });

      // Emit task lifecycle events for client-side task cards
      if (action === "create") {
        io.to(input.channelId).emit("npc:task-created", {
          npcId: input.npcId,
          task: { id: task.id, npcTaskId: task.npcTaskId, title: task.title, status: task.status },
        });
      }
      if (action === "complete") {
        io.to(input.channelId).emit("npc:task-completed", {
          npcId: input.npcId,
          npcName: input.npcName,
          taskId: task.npcTaskId,
          title: task.title,
          summary: (task as Record<string, unknown>).summary as string || "",
        });

        // Auto-promote next pending task for the same NPC (FIFO)
        const nextTask = await taskManager.getNextPendingTask(input.npcId, input.channelId);
        if (nextTask) {
          const promoted = await taskManager.moveTask(nextTask.id, input.channelId, "in_progress", input.npcId, { expectedFromStatus: "pending" }) as (ManagedTask & { _fromStatus?: string }) | null;
          if (promoted) {
            const { _fromStatus, ...promotedTask } = promoted;
            io.to(input.channelId).emit("task:updated", { task: promotedTask, action: "move_pending_in_progress" });
          }
        }
      }

      if (shouldDeliverCompletionReport(taskAction as { action?: string })) {
        appendNpcHistoryMessage(input.channelId, input.npcId, parsed.message);
        const report = await enqueueCompletionReport(
          db,
          { npcReports },
          buildCompletionReportRow({
            channelId: input.channelId,
            npcId: input.npcId,
            taskId: task.id,
            targetUserId: input.targetUserId,
            message: parsed.message,
          }),
        );

        if (report) {
          const joinedSockets = getJoinedSocketsForUserAndChannel(
            io,
            input.targetUserId,
            input.channelId,
          );

          if (joinedSockets.length > 0) {
            const payload = toReportReadyPayload(report, input.npcName);
            for (const joinedSocket of joinedSockets) {
              joinedSocket.emit("npc:report-ready", payload);
            }
            await markReportDelivered(db, { npcReports }, report.id);
          }
        }
      }
    } catch (err) {
      console.error("[TaskManager] Error handling task action:", err);
    }
  }
}

async function runProgressNudgeForTask(
  io: Server,
  task: ManagedTask,
  promptOverride?: string,
  reportKind = "progress",
) {
  if (progressNudgeInFlight.has(task.id)) return;

  progressNudgeInFlight.add(task.id);

  try {
    const npcConfig = await getNpcConfig(task.npcId);
    if (!npcConfig) return;

    const targetUserId = await getAssignerUserId(task.assignerId);
    if (!targetUserId) return;

    const sessionKey = `${npcConfig.sessionKeyPrefix || task.npcId}-task-${task.npcTaskId || task.id}`;
    const prompt = withTaskReminder(promptOverride ?? buildAutoExecutionPrompt(task));
    let response = "";

    if (npcConfig.adapterType === openclawAdapter.type) {
      if (!npcConfig.agentId) return;

      const gateway = await getOrConnectGateway(task.channelId);
      if (!gateway) return;

      await taskManager.markTaskNudged(task.id, task.channelId);
      ({ response } = await openclawAdapter.executeWithGateway(
        gateway,
        { sessionKey, prompt },
        npcConfig.agentId,
      ));
    } else if (adapterRegistry.has(npcConfig.adapterType)) {
      const adapter = adapterRegistry.get(npcConfig.adapterType);

      await taskManager.markTaskNudged(task.id, task.channelId);
      ({ response } = await adapter.execute({
        sessionKey,
        prompt,
        model: typeof npcConfig.adapterConfig.model === "string"
          ? npcConfig.adapterConfig.model
          : undefined,
      }));
    } else {
      console.warn(
        `[task-nudge] Unhandled adapterType "${npcConfig.adapterType}" for npc=${task.npcId} task=${task.id} — task stalled, no automation dispatched.`,
      );
      return;
    }

    const parsed = parseNpcResponse(response);
    const summary = (parsed.message || "").trim().slice(0, 500);
    if (summary) {
      await dmHub.updateSessionSummary(task.npcId, targetUserId, `task-${task.npcTaskId || task.id}`, summary);
    }

    await processNpcTaskActions(io, parsed, {
      channelId: task.channelId,
      npcId: task.npcId,
      npcName: npcConfig._name,
      assignerCharacterId: task.assignerId,
      targetUserId,
    });

    const preview = (parsed.message || "").trim() || `${task.title} 진행 상황을 보고했습니다.`;
    appendNpcHistoryMessage(task.channelId, task.npcId, preview);

    const report = await enqueueQueuedReport(
      db,
      { npcReports },
      buildQueuedReportRow({
        channelId: task.channelId,
        npcId: task.npcId,
        taskId: task.id,
        targetUserId,
        message: preview,
        kind: reportKind,
      }),
    );

    if (report) {
      const joinedSockets = getJoinedSocketsForUserAndChannel(io, targetUserId, task.channelId);
      if (joinedSockets.length > 0) {
        const payload = toReportReadyPayload(report, npcConfig._name);
        for (const joinedSocket of joinedSockets) {
          joinedSocket.emit("npc:report-ready", payload);
        }
        await markReportDelivered(db, { npcReports }, report.id);
      }
    }
  } catch (err) {
    console.error("[task-reporting] Progress nudge failed:", err);
  } finally {
    progressNudgeInFlight.delete(task.id);
  }
}

async function scanProgressNudges(io: Server) {
  try {
    const channelRows = await db
      .select({ id: channels.id, gatewayConfig: channels.gatewayConfig })
      .from(channels);

    for (const channelRow of channelRows) {
      const taskAutomation = getTaskAutomationConfig(channelRow.gatewayConfig);
      if (!taskAutomation.autoProgressNudgeEnabled) continue;

      const cutoffIso = new Date(
        getProgressNudgeCutoff(taskAutomation.autoProgressNudgeMinutes),
      ).toISOString();

      const staleTasks = await taskManager.getStaleInProgressTasks(
        channelRow.id,
        cutoffIso,
      ) as ManagedTask[];

      for (const task of staleTasks) {
        const autoNudgeMax = task.autoNudgeMax ?? taskAutomation.autoProgressNudgeMax;
        if ((task.autoNudgeCount ?? 0) >= autoNudgeMax) {
          const stalledTask = await taskManager.markTaskStalled(task.id, channelRow.id, "max_nudges_reached") as ManagedTask | null;
          if (stalledTask) {
            io.to(channelRow.id).emit("task:updated", { task: stalledTask, action: "stalled" });
          }
          continue;
        }

        const lastNudgedAt = progressNudgeCooldowns.get(task.id) ?? 0;
        if (Date.now() - lastNudgedAt < taskAutomation.autoProgressNudgeMinutes * 60 * 1000) {
          continue;
        }

        progressNudgeCooldowns.set(task.id, Date.now());
        await runProgressNudgeForTask(io, task);
      }
    }
  } catch (err) {
    console.error("[task-reporting] Progress nudge scan failed:", err);
  }
}

// ---------------------------------------------------------------------------
// OpenClaw gateway helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOrConnectGateway(channelId: string): Promise<any | null> {
  const gatewayConfig = await getGatewayRuntimeConfigForChannel(channelId);
  if (!gatewayConfig) {
    return null;
  }

  const gatewayKey = gatewayConfig.gatewayId;

  if (channelGateways.has(gatewayKey)) {
    const gw = channelGateways.get(gatewayKey)!;
    if (gw.isConnected()) return gw;
    channelGateways.delete(gatewayKey);
  }

  try {
    const gw = new OpenClawGateway();
    await gw.connect(gatewayConfig.baseUrl, gatewayConfig.token);
    channelGateways.set(gatewayKey, gw);
    return gw;
  } catch (err) {
    console.error(`[gateway] Connect failed for channel ${channelId}:`, err);
    return null;
  }
}

export async function invalidateGatewayConnectionForChannel(channelId: string) {
  const gatewayConfig = await getGatewayRuntimeConfigForChannel(channelId);
  if (!gatewayConfig) {
    return;
  }

  const gatewayKey = gatewayConfig.gatewayId;
  if (!channelGateways.has(gatewayKey)) {
    return;
  }

  const gw = channelGateways.get(gatewayKey);
  try {
    gw?.disconnect?.();
  } catch {
    // Best effort cache invalidation only.
  }
  channelGateways.delete(gatewayKey);
}

// ---------------------------------------------------------------------------
// NPC config loader
// ---------------------------------------------------------------------------

async function getNpcConfig(npcId: string): Promise<NpcConfig | null> {
  try {
    const rows = await db
      .select()
      .from(npcs)
      .where(eq(npcs.id, npcId))
      .limit(1);

    if (rows.length === 0) return null;

    const npc = rows[0];
    const oc = parseDbObject(npc.openclawConfig) || {};
    const adapterConfig = parseDbObject(npc.adapterConfig) || {};

    return {
      id: npc.id,
      name: npc.name,
      agentId: (oc.agentId as string) || null,
      sessionKeyPrefix: (oc.sessionKeyPrefix as string) || npcId,
      adapterType: typeof npc.adapterType === "string" ? npc.adapterType : "openclaw",
      adapterConfig,
      hermesProfileId: typeof npc.hermesProfileId === "string" ? npc.hermesProfileId : null,
      _channelId: npc.channelId as string,
      _name: npc.name,
      role: "Participant",
      passPolicy: typeof oc.passPolicy === "string" ? oc.passPolicy : null,
    };
  } catch (err) {
    console.error(`[npc] Failed to load config for ${npcId}:`, err);
    return null;
  }
}

async function getNpcConfigsForChannel(channelId: string): Promise<NpcConfig[]> {
  try {
    const rows = await db
      .select()
      .from(npcs)
      .where(eq(npcs.channelId, channelId));

    return rows.map((npc) => {
      const oc = parseDbObject(npc.openclawConfig) || {};
      const adapterConfig = parseDbObject(npc.adapterConfig) || {};
      return {
        id: npc.id,
        name: npc.name,
        agentId: (oc.agentId as string) || null,
        sessionKeyPrefix: (oc.sessionKeyPrefix as string) || npc.id,
        adapterType: typeof npc.adapterType === "string" ? npc.adapterType : "openclaw",
        adapterConfig,
        hermesProfileId: typeof npc.hermesProfileId === "string" ? npc.hermesProfileId : null,
        _channelId: channelId,
        _name: npc.name,
        role: "Participant",
        passPolicy: typeof oc.passPolicy === "string" ? oc.passPolicy : null,
      };
    });
  } catch (err) {
    console.error(`[npc] Failed to load NPC configs for channel ${channelId}:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenClaw streaming — 1:1 DM chat
// ---------------------------------------------------------------------------

async function streamNpcResponse(
  socket: Socket,
  npcId: string,
  npcConfig: NpcConfig,
  userId: string,
  message: string,
  attachments?: OpenClawAttachment[],
  sessionKeyOverride?: string,
  emitEvent?: string,
): Promise<string> {
  const { agentId, _channelId, sessionKeyPrefix, adapterType, hermesProfileId } = npcConfig;
  const responseEvent = emitEvent || "npc:response";
  const sessionKey = sessionKeyOverride || `${sessionKeyPrefix || npcId}-dm-${userId}`;

  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });

  if (dispatchKind === "unbound") {
    emitNpcSystemResponse(socket, npcId, "npc_unbound");
    return "";
  }

  if (dispatchKind === "hermes") {
    const adapter = await createHermesAdapterForNpc(
      npcId,
      userId,
      deriveHermesContextKey(sessionKey, sessionKeyPrefix || npcId),
    );
    if (!adapter) {
      emitNpcSystemResponse(socket, npcId, "npc_unbound");
      return "";
    }

    if (attachments?.some((a) => a.type === "image")) {
      socket.emit(responseEvent, { npcId, chunk: "", done: false, messageCode: "hermes_image_unsupported" });
    }

    try {
      const { response, session } = await adapter.execute({
        sessionKey,
        prompt: message,
        onDelta: (delta: string) => {
          socket.emit(responseEvent, { npcId, chunk: delta, done: false });
        },
        // onToolProgress 는 의도적으로 넘기지 않는다. tool.progress 는 "에이전트가 아직
        // 살아 있다"는 진행 신호이지 답변 본문이 아니다 — 실측(v0.20.2)에서 Hermes 의
        // `_thinking` 툴은 완성된 답변 **전체**를 delta 필드에 한 번 더 실어 보낸다:
        //   assistant.delta "사"/"과"/"딸"/"기"
        //   tool.progress   tool_name="_thinking"  delta="사과딸기"   ← 통째로 다시
        //   assistant.completed content="사과딸기"
        // 이걸 채팅 청크로 흘리던 탓에 1:1 대화에서 답이 정확히 두 번 보였다.
        // 회의 경로(ConversationEngine)는 처음부터 timeout.touch() 용으로만 썼다 —
        // 같은 콜백을 두 소비자가 다르게 읽었고, 1:1 쪽만 어긋나 있었다.
        onRunStarted: (runId: string) => {
          registerHermesRun(sessionKey, runId);
        },
      });
      socket.emit(responseEvent, { npcId, chunk: "", done: true });
      await persistHermesSessionRef(
        npcId,
        userId,
        deriveHermesContextKey(sessionKey, sessionKeyPrefix || npcId),
        session.sessionRef,
      );
      return response || "";
    } catch (err) {
      console.error("[npc] Hermes adapter error for " + npcId + ":", err);
      emitNpcSystemResponse(socket, npcId, "gateway_error");
      return "";
    } finally {
      clearHermesRun(sessionKey);
    }
  }

  if (dispatchKind === "openclaw") {
    if (!agentId) {
      emitNpcSystemResponse(socket, npcId, "no_agent");
      return "";
    }

    const gateway = await getOrConnectGateway(_channelId);
    if (!gateway) {
      emitNpcSystemResponse(socket, npcId, "gateway_not_connected");
      return "";
    }

    try {
      const { response } = await openclawAdapter.executeWithGateway(
        gateway,
        {
          sessionKey,
          prompt: message,
          onDelta: (delta: string) => {
            socket.emit(responseEvent, { npcId, chunk: delta, done: false });
          },
          attachments,
        },
        agentId,
      );
      socket.emit(responseEvent, { npcId, chunk: "", done: true });
      return response || "";
    } catch (err) {
      console.error("[npc] OpenClaw chatSend error:", err);
      emitNpcSystemResponse(socket, npcId, "gateway_error");
      return "";
    }
  }

  // dispatchKind === "registry"
  if (adapterRegistry.has(adapterType)) {
    const adapter = adapterRegistry.get(adapterType);

    try {
      const { response } = await adapter.execute({
        sessionKey,
        prompt: message,
        attachments,
        model: typeof npcConfig.adapterConfig.model === "string"
          ? npcConfig.adapterConfig.model
          : undefined,
        onDelta: (delta: string) => {
          socket.emit(responseEvent, { npcId, chunk: delta, done: false });
        },
        timeoutMs: 180_000,
      });
      socket.emit(responseEvent, { npcId, chunk: "", done: true });
      return response || "";
    } catch (err) {
      console.error("[npc] CLI adapter error for " + npcId + ":", err);
      emitNpcSystemResponse(socket, npcId, "gateway_error");
      return "";
    }
  } else {
    emitNpcSystemResponse(socket, npcId, "unsupported_adapter");
    return "";
  }
}

// ---------------------------------------------------------------------------
// OpenClaw streaming — meeting room broadcast
// ---------------------------------------------------------------------------

async function streamMeetingNpcResponse(
  io: Server,
  channelId: string,
  npcConfig: NpcConfig,
  room: MeetingRoom,
  userMessage: string,
  senderName: string,
  userId: string,
): Promise<void> {
  const { id: npcId, agentId, sessionKeyPrefix, _name, adapterType, hermesProfileId } = npcConfig;
  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });

  if (dispatchKind === "unbound") {
    emitMeetingNpcStream(io, channelId, {
      npcId,
      npcName: _name,
      chunk: "",
      done: true,
      messageCode: "npc_unbound",
    });
    return;
  }

  if (dispatchKind === "registry" && !adapterRegistry.has(adapterType)) {
    emitMeetingNpcStream(io, channelId, {
      npcId,
      npcName: _name,
      chunk: "",
      done: true,
      messageCode: "unsupported_adapter",
    });
    return;
  }

  // Skip openclaw NPCs without an assigned agent in meeting rooms (unchanged: silent no-op).
  if (dispatchKind === "openclaw" && !agentId) return;

  const sessionKey = `${sessionKeyPrefix || _name}-meeting-${channelId}`;
  const prompt = `${senderName}: ${userMessage}`;

  let gateway: unknown = null;
  let hermesAdapter: Awaited<ReturnType<typeof createHermesAdapterForNpc>> = null;
  let hermesContextKey = "";

  if (dispatchKind === "openclaw") {
    gateway = await getOrConnectGateway(channelId);
    if (!gateway) return; // unchanged: silent no-op
  } else if (dispatchKind === "hermes") {
    hermesContextKey = deriveHermesContextKey(sessionKey, sessionKeyPrefix || _name);
    hermesAdapter = await createHermesAdapterForNpc(npcId, userId, hermesContextKey);
    if (!hermesAdapter) {
      emitMeetingNpcStream(io, channelId, {
        npcId,
        npcName: _name,
        chunk: "",
        done: true,
        messageCode: "npc_unbound",
      });
      return;
    }
  }

  const npcMessage: MeetingMessage = {
    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sender: _name,
    senderId: `npc-${_name}`,
    senderType: "npc",
    content: "",
    timestamp: Date.now(),
  };

  room.messages.push(npcMessage);
  if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);

  // fullText는 onDelta 클로저보다 먼저 선언해야 한다 — 반대 순서는 오늘은 안전하지만
  // (execute 안에서만 호출된다) 리팩터 한 번이면 TDZ 함정이 된다.
  let fullText = "";
  const onDelta = (delta: string) => {
    fullText += delta;
    npcMessage.content = fullText;
    emitMeetingNpcStream(io, channelId, {
      npcId,
      npcName: _name,
      messageId: npcMessage.id,
      sender: _name,
      chunk: delta,
      done: false,
    });
  };

  /** hermes 분기에서만 채워진다 — 답변을 확정 전달한 뒤에 best-effort로 영속화한다(M6). */
  let persistSessionRef: (() => Promise<void>) | null = null;
  try {
    if (dispatchKind === "openclaw") {
      const { response } = await openclawAdapter.executeWithGateway(gateway, { sessionKey, prompt, onDelta }, agentId!);
      fullText = response || fullText;
    } else if (dispatchKind === "hermes") {
      const { response, session } = await hermesAdapter!.execute({
        sessionKey,
        prompt,
        onDelta,
        onRunStarted: (runId: string) => registerHermesRun(sessionKey, runId),
      });
      fullText = response || fullText;
      persistSessionRef = () =>
        persistHermesSessionRef(npcId, userId, hermesContextKey, session.sessionRef);
    } else {
      // dispatchKind === "registry"
      const adapter = adapterRegistry.get(adapterType);
      const { response } = await adapter.execute({
        sessionKey,
        prompt,
        model: typeof npcConfig.adapterConfig.model === "string" ? npcConfig.adapterConfig.model : undefined,
        onDelta,
        timeoutMs: 180_000,
      });
      fullText = response || fullText;
    }

    npcMessage.content = fullText;
    await deliverMeetingNpcAnswer({
      emitDone: () =>
        emitMeetingNpcStream(io, channelId, {
          npcId,
          npcName: _name,
          messageId: npcMessage.id,
          sender: _name,
          chunk: "",
          done: true,
        }),
      emitMessage: () => io.to(`meeting-${channelId}`).emit("meeting:message", npcMessage),
      persistSessionRef,
      onPersistError: (err) =>
        console.error(`[meeting] hermes session ref persist failed for NPC ${_name}:`, err),
    });
  } catch (err) {
    console.error(`[meeting] ${dispatchKind} error for NPC ${_name}:`, err);
    room.messages.pop();
  } finally {
    if (dispatchKind === "hermes") clearHermesRun(sessionKey);
  }
}

/**
 * 회의 요약. 참가자 어댑터 하나를 빌려 쓴다 — 백엔드가 무엇이든 상관없다.
 *
 * 예전에는 OpenClaw 게이트웨이의 chatSend 에 직접 매여 있었고, 호출부가
 * `gateway && openclawAgentId` 로 감싸고 있어서 Hermes 회의는 요약을 통째로 건너뛰었다.
 * 실패가 조용해서(빈 배열 + null) 회의록에 결론이 안 남는 것으로만 보였다.
 */
async function generateMeetingSummary(
  adapter: NpcAdapter,
  sessionKey: string,
  topic: string,
  transcript: string,
) {
  const summaryPrompt = `다음 회의 내용을 분석하여 JSON으로 응답하세요.

회의 주제: ${topic}

${transcript}

응답 형식 (JSON만, 다른 텍스트 없이):
{
  "keyTopics": ["주제1", "주제2", "주제3"],
  "conclusions": "결론 요약 2-3문장"
}`;

  try {
    // multiParty: true — 요약은 그 NPC 의 영속 대화 세션이 아니라 일회성 실행이어야 한다.
    // 히스토리는 비운다; 트랜스크립트는 프롬프트에 이미 통째로 들어 있다.
    const { response } = await Promise.race([
      adapter.execute({
        sessionKey,
        prompt: summaryPrompt,
        multiParty: true,
        conversationHistory: [],
      }),
      new Promise<{ response: string }>((_, reject) => {
        setTimeout(() => reject(new Error("Summary timeout")), 60_000);
      }),
    ]);
    const jsonMatch = (response || "").match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { keyTopics: [], conclusions: null };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { keyTopics?: unknown; conclusions?: unknown };
    return {
      keyTopics: Array.isArray(parsed.keyTopics)
        ? parsed.keyTopics.filter((topic): topic is string => typeof topic === "string")
        : [],
      conclusions: typeof parsed.conclusions === "string" ? parsed.conclusions : null,
    };
  } catch (err) {
    console.warn("[meeting] Summary generation failed:", err);
    return { keyTopics: [], conclusions: null };
  }
}

async function canControlMeeting(channelId: string, userId: string) {
  if (discussionInitiators.get(channelId) === userId) {
    return true;
  }

  const rows = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return rows[0]?.ownerId === userId;
}

async function persistMeetingMinutes(input: {
  channelId: string;
  topic: string;
  transcript: string;
  participants: Array<{ id: string; name: string; type: "npc" | "player"; agentId?: string }>;
  totalTurns: number;
  durationSeconds?: number;
  initiatorId: string | null;
  keyTopics: string[];
  conclusions: string | null;
}) {
  try {
    const inserted = await db
      .insert(meetingMinutes)
      .values({
        channelId: input.channelId,
        topic: input.topic,
        transcript: input.transcript,
        participants: jsonForDb(input.participants),
        totalTurns: input.totalTurns,
        durationSeconds: input.durationSeconds ?? null,
        initiatorId: input.initiatorId,
        keyTopics: jsonForDb(input.keyTopics),
        conclusions: input.conclusions,
      })
      .returning({ id: meetingMinutes.id });

    return inserted[0]?.id ?? null;
  } catch (err) {
    console.error("[meeting] Failed to save minutes:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

import { DEV_JWT_SECRET } from "@/lib/dev-constants";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? DEV_JWT_SECRET : "");
  if (!secret) throw new Error("Missing JWT_SECRET");
  return new TextEncoder().encode(secret);
}

async function authenticateSocket(
  socket: Socket,
): Promise<{ userId: string; nickname: string } | null> {
  const cookieHeader = socket.handshake.headers.cookie || "";
  try {
    const tokenCookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("token="));

    if (!tokenCookie) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[socket:auth] missing token cookie", {
          socketId: socket.id,
          transport: socket.conn.transport.name,
          hasCookieHeader: cookieHeader.length > 0,
          userAgent: socket.handshake.headers["user-agent"] || "",
        });
      }
      return null;
    }

    const rawTokenValue = tokenCookie.slice("token=".length);
    const normalizedToken = decodeURIComponent(rawTokenValue).replace(/^"|"$/g, "");

    const { payload } = await jwtVerify(normalizedToken, getJwtSecret());
    return {
      userId: payload.userId as string,
      nickname: payload.nickname as string,
    };
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[socket:auth] token verify failed", {
        socketId: socket.id,
        transport: socket.conn.transport.name,
        error: error instanceof Error ? error.message : String(error),
        cookiePreview: cookieHeader.slice(0, 120),
        userAgent: socket.handshake.headers["user-agent"] || "",
      });
    }
    return null;
  }
}

function emitChannelAccessDenied(
  socket: Socket,
  input: Parameters<typeof buildChannelAccessDeniedPayload>[0],
) {
  socket.emit("channel:access-denied", buildChannelAccessDeniedPayload(input));
}

async function getSocketChannelParticipationAccess(channelId: string, userId: string) {
  const channelRows = await db
    .select({
      id: channels.id,
      groupId: channels.groupId,
      isPublic: channels.isPublic,
      ownerId: channels.ownerId,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  const channel = channelRows[0];
  if (!channel) {
    return null;
  }

  const groupMembershipRows = channel.groupId
    ? await db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, channel.groupId),
            eq(groupMembers.userId, userId),
          ),
        )
        .limit(1)
    : [];

  const channelMembershipRows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, userId),
      ),
    )
    .limit(1);

  const access = summarizeChannelParticipationAccess({
    groupId: channel.groupId,
    isPublic: channel.isPublic ?? true,
    hasActiveGroupMembership: groupMembershipRows.length > 0,
    isChannelMember:
      channel.ownerId === userId || channelMembershipRows.length > 0,
  });

  return { channel, access };
}

async function isChannelOwner(channelId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return rows[0]?.ownerId === userId;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setupSocketHandlers(io: Server) {
  if (!progressNudgeTimer) {
    progressNudgeTimer = setInterval(() => {
      void scanProgressNudges(io);
    }, PROGRESS_NUDGE_SCAN_MS);
  }

  io.on("connection", async (socket) => {
    const user = await authenticateSocket(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    // ----- player:join -----
    socket.on(
      "player:join",
      async (data: {
        characterId: string;
        characterName: string;
        appearance: unknown;
        mapId: string;
        x: number;
        y: number;
      }) => {
        const accessResult = await getSocketChannelParticipationAccess(data.mapId, user.userId);
        if (!accessResult) {
          socket.emit("channel:access-denied", {
            channelId: data.mapId,
            action: "player:join",
            reason: "forbidden",
            errorCode: "forbidden",
          });
          return;
        }

        if (!accessResult.access.allowed) {
          emitChannelAccessDenied(socket, {
            channelId: data.mapId,
            action: "player:join",
            reason: accessResult.access.reason as ChannelAccessDeniedReason,
          });
          return;
        }

        // Enforce single session per user — disconnect any prior session(s)
        // for this account now that the join is authorized and proceeding.
        const priorSocketIds = getSocketIdsToKick(getSocketIdsForUser(user.userId), socket.id);
        for (const prevSocketId of priorSocketIds) {
          const prevSocket = io.sockets.sockets.get(prevSocketId);
          if (prevSocket) {
            prevSocket.emit("session:kicked", {
              reason: "다른 위치에서 접속하여 현재 세션이 종료되었습니다.",
            });
            prevSocket.disconnect(true);
          }
          players.delete(prevSocketId);
        }

        const playerState: PlayerState = {
          id: socket.id,
          userId: user.userId,
          characterId: data.characterId,
          characterName: data.characterName,
          appearance: data.appearance,
          mapId: data.mapId,
          x: data.x,
          y: data.y,
          direction: "down",
          animation: "idle",
        };

        players.set(socket.id, playerState);
        socket.join(data.mapId);

        // Send current players on this map to the joining player
        const mapPlayers = Array.from(players.values()).filter(
          (p) => p.mapId === data.mapId && p.id !== socket.id,
        );
        socket.emit("players:state", { players: mapPlayers });

        // Send channel chat history to the joining player
        const chatHistory = channelChatHistory.get(data.mapId);
        if (chatHistory && chatHistory.length > 0) {
          socket.emit("chat:history", { messages: chatHistory });
        }

        await deliverPendingReportsToSocket(socket, user.userId, data.mapId);

        // Broadcast to others in the same map
        socket.to(data.mapId).emit("player:joined", playerState);
      },
    );

    // ----- player:move -----
    socket.on(
      "player:move",
      (data: {
        x: number;
        y: number;
        direction: string;
        animation: string;
      }) => {
        const player = players.get(socket.id);
        if (!player) return;

        player.x = data.x;
        player.y = data.y;
        player.direction = data.direction;
        player.animation = data.animation;

        socket.to(player.mapId).emit("player:moved", {
          id: socket.id,
          x: data.x,
          y: data.y,
          direction: data.direction,
          animation: data.animation,
        });
      },
    );

    // ----- chat:send (channel chat, user-to-user) -----
    socket.on("chat:send", ({ message }: { message: string }) => {
      const player = players.get(socket.id);
      if (!player) return;
      const trimmed = String(message || "").trim().slice(0, 500);
      if (!trimmed) return;
      const now = Date.now();
      if (now - (lastChatTime.get(socket.id) || 0) < CHAT_COOLDOWN_MS) return;
      lastChatTime.set(socket.id, now);

      const chatMessage: ChannelChatMessage = {
        id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender: player.characterName || user.nickname,
        senderId: socket.id,
        content: trimmed,
        timestamp: now,
      };
      // Store in channel chat history
      const history = channelChatHistory.get(player.mapId) || [];
      history.push(chatMessage);
      channelChatHistory.set(player.mapId, history);
      io.to(player.mapId).emit("chat:message", chatMessage);
    });

    // ----- map:object-add (map editing broadcast, owner only) -----
    socket.on("map:object-add", async (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (!(await isChannelOwner(player.mapId, user.userId))) return;
      socket.to(player.mapId).emit("map:object-added", data);
    });

    // ----- map:object-remove (map editing broadcast, owner only) -----
    socket.on("map:object-remove", async (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (!(await isChannelOwner(player.mapId, user.userId))) return;
      socket.to(player.mapId).emit("map:object-removed", data);
    });

    // ----- map:tiles-update (map editing broadcast, owner only) -----
    socket.on("map:tiles-update", async (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      if (!(await isChannelOwner(player.mapId, user.userId))) return;
      socket.to(player.mapId).emit("map:tiles-updated", data);
    });

    // ----- npc:chat -----
    socket.on(
      "npc:chat",
      async (data: {
        npcId: string;
        message: string;
        files?: Array<{ name: string; type: string; size: number; data: ArrayBuffer }>;
      }) => {
        const { npcId, message, files } = data;
        chatLog(`← user msg to ${npcId}:`, message?.slice(0, 100), files ? `+${files.length} files [${files.map(f => `${f.name}(${(f.size/1024).toFixed(0)}KB)`).join(", ")}]` : "");

        // Validate
        if (!npcId || !message || typeof message !== "string") return;
        const trimmed = message.trim().slice(0, 500);
        if (!trimmed && (!files || files.length === 0)) return;

        // Rate limit
        const now = Date.now();
        const lastTime = lastChatTime.get(socket.id) || 0;
        if (now - lastTime < CHAT_COOLDOWN_MS) {
          emitNpcSystemResponse(socket, npcId, "wait_before_sending");
          return;
        }
        lastChatTime.set(socket.id, now);

        // Load NPC config
        const npcConfig = await getNpcConfig(npcId);
        if (!npcConfig) {
          emitNpcSystemResponse(socket, npcId, "npc_not_found");
          return;
        }

        // --- File processing (text-based files only) ---
        let extractedFiles: ExtractedFile[] = [];
        let fileAttachments: OpenClawAttachment[] | undefined;

        if (files && files.length > 0) {
          if (files.length > FILE_LIMITS.maxFileCount) {
            emitNpcSystemResponse(socket, npcId, "too_many_files");
            return;
          }
          for (const f of files) {
            if (f.size > FILE_LIMITS.maxFileSize) {
              emitNpcSystemResponse(socket, npcId, "file_too_large");
              return;
            }
            if (!isAllowedFileType(f.name, f.type)) {
              emitNpcSystemResponse(socket, npcId, "unsupported_file_type");
              return;
            }
          }
          extractedFiles = await Promise.all(
            files.map((f) => extractFileContent(Buffer.from(f.data), f.name, f.type)),
          );
          fileAttachments = buildAttachments(extractedFiles);
          chatLog("  extracted:", extractedFiles.map(f => `${f.name}(text=${f.textContent?.length ?? 0}, img=${f.imageBase64 ? (f.imageBase64.length/1024).toFixed(0)+'KB' : '-'}, trunc=${f.truncated})`).join(", "));
        }

        const player = players.get(socket.id);
        const historyKey = `${player?.mapId || npcConfig._channelId}:${npcId}`;
        const history = npcChatHistory.get(historyKey) || [];
        history.push({ role: "player", content: trimmed, timestamp: Date.now() });

        // Inject task reminder on every NPC DM so task actions can be parsed consistently.
        const fileSection = buildFilePromptSection(extractedFiles);
        const taskDashboard = await dmHub.buildTaskDashboard(npcId, npcConfig._channelId);
        const enrichedMessage = taskDashboard
          ? `${taskDashboard}\n\n${trimmed + fileSection}`
          : trimmed + fileSection;
        const messageToSend = withTaskReminder(enrichedMessage, getSocketLocale(socket));

        // Stream response via OpenClaw
        chatLog(`  → gateway (${npcConfig._name}): msgLen=${messageToSend.length}(${(messageToSend.length/1024).toFixed(0)}KB)`, fileAttachments ? `+${fileAttachments.length} att(${fileAttachments.map(a => `${a.fileName}:${(a.content.length/1024).toFixed(0)}KB`).join(",")})` : "");
        const response = await streamNpcResponse(socket, npcId, npcConfig, user.userId, messageToSend, fileAttachments);
        chatLog(`  ← npc response (${npcConfig._name}):`, response ? response.slice(0, 150) + (response.length > 150 ? "..." : "") : "(empty)");
        if (response) {
          const { finalResponse, markers } = dmHub.processResponseMarkers(response);
          if (markers.length > 0) {
            console.log("[dm-hub] Response markers:", markers);
          }
          const parsed = parseNpcResponse(finalResponse);
          const sanitizedResponse = sanitizeNpcResponseText(finalResponse);
          history.push({ role: "npc", content: sanitizedResponse, timestamp: Date.now() });
          if (player?.characterId) {
            await processNpcTaskActions(io, parsed, {
              channelId: npcConfig._channelId,
              npcId,
              npcName: npcConfig._name,
              assignerCharacterId: player.characterId,
              targetUserId: player.userId,
            });
          } else {
            console.warn("[TaskManager] No characterId for socket", socket.id);
          }
          socket.emit("npc:response-complete", { npcId, npcName: npcConfig._name || npcId });
        }
        npcChatHistory.set(historyKey, history);
      },
    );

    socket.on("npc:history", ({ npcId }: { npcId: string }) => {
      if (!npcId) return;
      const player = players.get(socket.id);
      const historyKey = `${player?.mapId || ""}:${npcId}`;
      const history = npcChatHistory.get(historyKey) || [];
      socket.emit("npc:history", { npcId, messages: history });
    });

    // ----- npc:task-chat (per-task session) -----
    socket.on(
      "npc:task-chat",
      async (data: {
        npcId: string;
        taskId: string;
        message: string;
        files?: Array<{ name: string; type: string; size: number; data: ArrayBuffer }>;
      }) => {
        const { npcId, taskId, message, files } = data;
        chatLog(`← task-chat to ${npcId} task=${taskId}:`, message?.slice(0, 100));

        if (!npcId || !taskId || !message || typeof message !== "string") return;
        const trimmed = message.trim().slice(0, 500);
        if (!trimmed && (!files || files.length === 0)) return;

        // Rate limit
        const now = Date.now();
        const lastTime = lastChatTime.get(socket.id) || 0;
        if (now - lastTime < CHAT_COOLDOWN_MS) {
          emitNpcSystemResponse(socket, npcId, "wait_before_sending");
          return;
        }
        lastChatTime.set(socket.id, now);

        // Load NPC config
        const npcConfig = await getNpcConfig(npcId);
        if (!npcConfig) {
          emitNpcSystemResponse(socket, npcId, "npc_not_found");
          return;
        }

        // Load task from DB for context injection
        const task = await taskManager.getTaskByNpcTaskId(npcId, taskId) as {
          title: string; npcTaskId: string; status: string;
          summary: string | null; createdAt: string;
        } | null;

        // File processing (same pattern as npc:chat)
        let extractedFiles: ExtractedFile[] = [];
        let fileAttachments: OpenClawAttachment[] | undefined;

        if (files && files.length > 0) {
          if (files.length > FILE_LIMITS.maxFileCount) {
            emitNpcSystemResponse(socket, npcId, "too_many_files");
            return;
          }
          for (const f of files) {
            if (f.size > FILE_LIMITS.maxFileSize) {
              emitNpcSystemResponse(socket, npcId, "file_too_large");
              return;
            }
            if (!isAllowedFileType(f.name, f.type)) {
              emitNpcSystemResponse(socket, npcId, "unsupported_file_type");
              return;
            }
          }
          extractedFiles = await Promise.all(
            files.map((f) => extractFileContent(Buffer.from(f.data), f.name, f.type)),
          );
          fileAttachments = buildAttachments(extractedFiles);
        }

        // Build message with task session context
        const fileSection = buildFilePromptSection(extractedFiles);
        const taskPrompt = task
          ? buildTaskSessionPrompt(task, getSocketLocale(socket))
          : "";
        const messageToSend = (taskPrompt ? taskPrompt + "\n\n" : "") + withTaskReminder(trimmed + fileSection, getSocketLocale(socket));

        // Session key: per-task
        const sessionKey = `${npcConfig.sessionKeyPrefix || npcId}-task-${taskId}`;

        chatLog(`  → task gateway (${npcConfig._name}): task=${taskId} sessionKey=${sessionKey}`);
        const response = await streamNpcResponse(
          socket, npcId, npcConfig, user.userId, messageToSend, fileAttachments, sessionKey, "npc:task-response",
        );
        chatLog(`  ← task response (${npcConfig._name}):`, response ? response.slice(0, 150) : "(empty)");

        if (response) {
          const parsed = parseNpcResponse(response);
          const sanitizedResponse = sanitizeNpcResponseText(response);
          const player = players.get(socket.id);
          if (player?.characterId) {
            await processNpcTaskActions(io, parsed, {
              channelId: npcConfig._channelId,
              npcId,
              npcName: npcConfig._name,
              assignerCharacterId: player.characterId,
              targetUserId: player.userId,
            });
          }
          socket.emit("npc:response-complete", { npcId, npcName: npcConfig._name || npcId });
        }
      },
    );

    socket.on("npc:reset-chat", ({ npcId }: { npcId: string }) => {
      if (!npcId) return;
      const player = players.get(socket.id);
      const historyKey = `${player?.mapId || ""}:${npcId}`;
      npcChatHistory.delete(historyKey);
    });

    socket.on("npc:report-consumed", async ({ reportId }: { reportId?: string }) => {
      if (!reportId) return;
      try {
        await markReportConsumed(db, { npcReports }, reportId);
      } catch (err) {
        console.error("[task-reporting] Error marking report consumed:", err);
      }
    });

    // ----- NPC movement -----
    socket.on("npc:call", ({ channelId, npcId }: { channelId: string; npcId: string }) => {
      if (!channelId || !npcId) return;
      const player = players.get(socket.id);
      if (!player) return;
      io.to(channelId).emit("npc:come-to-player", {
        npcId,
        targetPlayerId: socket.id,
      });
    });

    socket.on("npc:return-home", ({ channelId, npcId }: { channelId: string; npcId: string }) => {
      if (!channelId || !npcId) return;
      io.to(channelId).emit("npc:returning", { npcId });
    });

    socket.on(
      "npc:position-update",
      ({ channelId, npcId, x, y, direction }: { channelId: string; npcId: string; x: number; y: number; direction: string }) => {
        if (!channelId || !npcId) return;
        socket.to(channelId).emit("npc:position-sync", { npcId, x, y, direction });
      },
    );

    socket.on("npc:arrived", ({ channelId, npcId }: { channelId: string; npcId: string }) => {
      if (!channelId || !npcId) return;
      socket.to(channelId).emit("npc:stop-moving", { npcId });
    });

    // NPC management broadcasts (re-broadcast to room)
    socket.on("npc:broadcast-add", (npcData: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:added", npcData);
    });

    socket.on("npc:broadcast-update", (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:updated", data);
    });

    socket.on("npc:broadcast-remove", (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      socket.to(player.mapId).emit("npc:removed", data);
    });

    socket.on("task:list", async ({ channelId, npcId }: { channelId?: string | null; npcId?: string | null }) => {
      try {
        const taskList = npcId
          ? await taskManager.getTasksByNpc(npcId)
          : channelId
            ? await taskManager.getTasksByChannel(channelId)
            : [];
        socket.emit("task:list-response", { tasks: taskList, npcId: npcId || null });
      } catch (err) {
        console.error("[TaskManager] Error fetching tasks:", err);
        socket.emit("task:list-response", { tasks: [], npcId: npcId || null });
      }
    });

    socket.on("task:create", async ({ channelId, title, summary, npcId }: { channelId?: string | null; title?: unknown; summary?: unknown; npcId?: string | null }) => {
      try {
        const player = players.get(socket.id);
        if (!player) return;

        if (!channelId || typeof channelId !== "string") return;
        if (typeof title !== "string") return;

        const trimmedTitle = title.trim().slice(0, 200);
        if (!trimmedTitle) return;
        const trimmedSummary = typeof summary === "string" ? summary.trim() : null;

        let task = await taskManager.createBacklogTask(channelId, player.characterId, trimmedTitle, trimmedSummary);
        if (npcId) {
          task = await taskManager.moveTask((task as ManagedTask).id, player.mapId, "pending", npcId);
        }

        if (task) {
          io.to(player.mapId).emit("task:updated", { task, action: "create" });
        }
      } catch (err) {
        console.error("[TaskManager] Error creating task:", err);
      }
    });

    socket.on("task:move", async ({ taskId, toStatus, npcId }: { taskId?: string | null; toStatus?: string | null; npcId?: string | null }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId || !toStatus) return;

        const allowedStatuses = ["backlog", "pending", "in_progress", "stalled", "complete", "cancelled"];
        if (!allowedStatuses.includes(toStatus)) return;

        // If requesting in_progress but NPC already has an in_progress task, demote to pending
        let finalToStatus = toStatus;
        const effectiveNpcId = npcId || null;
        if (toStatus === "in_progress" && effectiveNpcId) {
          const busy = await taskManager.hasInProgressTask(effectiveNpcId, player.mapId);
          if (busy) finalToStatus = "pending";
        }

        const movedTask = await taskManager.moveTask(taskId, player.mapId, finalToStatus, effectiveNpcId) as (ManagedTask & { _fromStatus?: string }) | null;
        if (!movedTask) return;

        const fromStatus = movedTask._fromStatus;
        const { _fromStatus, ...task } = movedTask;
        io.to(player.mapId).emit("task:updated", { task, action: `move_${fromStatus}_${finalToStatus}` });

        if (
          finalToStatus === "in_progress" &&
          (fromStatus === "backlog" || fromStatus === "pending") &&
          task.npcId
        ) {
          const npcConfig = await getNpcConfig(task.npcId);
          if (npcConfig) {
            const taskSessionPrompt = buildTaskSessionPrompt({
              ...task,
              summary: task.summary || "",
              createdAt: (task as { createdAt?: string }).createdAt || "",
            }, getSocketLocale(socket));
            const autoStartMessage = withTaskReminder(`${task.title} 업무를 시작합니다.`, getSocketLocale(socket));
            const messageToSend = `${taskSessionPrompt}\n\n${autoStartMessage}`;
            const sessionKey = `${npcConfig.sessionKeyPrefix || task.npcId}-task-${task.npcTaskId}`;
            const response = await streamNpcResponse(
              socket,
              task.npcId,
              npcConfig,
              player.userId,
              messageToSend,
              undefined,
              sessionKey,
              "npc:task-response",
            );

            if (response) {
              const parsed = parseNpcResponse(response);
              await processNpcTaskActions(io, parsed, {
                channelId: player.mapId,
                npcId: task.npcId,
                npcName: npcConfig._name,
                assignerCharacterId: player.characterId,
                targetUserId: player.userId,
              });
              socket.emit("npc:response-complete", {
                npcId: task.npcId,
                npcName: npcConfig._name || task.npcId,
              });
            }
          }
        }
      } catch (err) {
        console.error("[TaskManager] Error moving task:", err);
        if (err instanceof Error && err.message.includes("npcId required")) {
          socket.emit("task:move-error", { error: "npcId_required" });
        }
      }
    });

    socket.on("task:delete", async ({ taskId }: { taskId: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;
        const deleted = await taskManager.deleteTask(taskId, player.mapId);
        if (deleted) {
          io.to(player.mapId).emit("task:deleted", { taskId });
        }
      } catch (err) {
        console.error("[TaskManager] Error deleting task:", err);
      }
    });

    socket.on("task:request-report", async ({ taskId }: { taskId: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;
        const task = await taskManager.getTaskById(taskId, player.mapId) as ManagedTask | null;
        if (!task) return;
        if (task.status === "complete" || task.status === "cancelled") return;

        let runnableTask = task;
        if (task.status === "stalled") {
          const resumedTask = await taskManager.resumeTask(task.id, player.mapId) as ManagedTask | null;
          if (!resumedTask) return;
          io.to(player.mapId).emit("task:updated", { task: resumedTask, action: "resume" });
          runnableTask = resumedTask;
        }

        appendNpcHistoryMessageForUser(
          io,
          player.userId,
          player.mapId,
          runnableTask.npcId,
          buildTaskActionStartMessage({ title: runnableTask.title }, "request-report"),
        );

        await runProgressNudgeForTask(io, {
          id: runnableTask.id,
          channelId: runnableTask.channelId,
          npcId: runnableTask.npcId,
          assignerId: runnableTask.assignerId,
          npcTaskId: runnableTask.npcTaskId,
          title: runnableTask.title,
          summary: runnableTask.summary,
          status: runnableTask.status,
          autoNudgeCount: runnableTask.autoNudgeCount,
          autoNudgeMax: runnableTask.autoNudgeMax,
        }, buildManualTaskReportPrompt({
          title: runnableTask.title,
          summary: runnableTask.summary,
          npcTaskId: runnableTask.npcTaskId,
          status: runnableTask.status,
        }), "manual");
      } catch (err) {
        console.error("[TaskManager] Error requesting task report:", err);
      }
    });

    socket.on("task:resume", async ({ taskId }: { taskId: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const resumedTask = await taskManager.resumeTask(taskId, player.mapId) as ManagedTask | null;
        if (resumedTask) {
          io.to(player.mapId).emit("task:updated", { task: resumedTask, action: "resume" });

          appendNpcHistoryMessageForUser(
            io,
            player.userId,
            player.mapId,
            resumedTask.npcId,
            buildTaskActionStartMessage({ title: resumedTask.title }, "resume"),
          );

          await runProgressNudgeForTask(io, {
            id: resumedTask.id,
            channelId: resumedTask.channelId,
            npcId: resumedTask.npcId,
            assignerId: resumedTask.assignerId,
            npcTaskId: resumedTask.npcTaskId,
            title: resumedTask.title,
            summary: resumedTask.summary,
            status: resumedTask.status,
            autoNudgeCount: resumedTask.autoNudgeCount,
            autoNudgeMax: resumedTask.autoNudgeMax,
          }, buildResumeTaskExecutionPrompt({
            title: resumedTask.title,
            summary: resumedTask.summary,
            npcTaskId: resumedTask.npcTaskId,
          }), "resume");
        }
      } catch (err) {
        console.error("[TaskManager] Error resuming task:", err);
      }
    });

    socket.on("task:complete", async ({ taskId }: { taskId: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const completedTask = await taskManager.completeTask(taskId, player.mapId) as ManagedTask | null;
        if (completedTask) {
          io.to(player.mapId).emit("task:updated", { task: completedTask, action: "complete_manual" });

          // Auto-promote next pending task for the same NPC (FIFO)
          if (completedTask.npcId) {
            const nextTask = await taskManager.getNextPendingTask(completedTask.npcId, player.mapId);
            if (nextTask) {
              const promoted = await taskManager.moveTask(nextTask.id, player.mapId, "in_progress", completedTask.npcId, { expectedFromStatus: "pending" }) as (ManagedTask & { _fromStatus?: string }) | null;
              if (promoted) {
                const { _fromStatus, ...promotedTask } = promoted;
                io.to(player.mapId).emit("task:updated", { task: promotedTask, action: "move_pending_in_progress" });

                // Trigger NPC to start working on the promoted task
                // Stream to the promoted task's assigner, not the user who clicked complete
                const npcConfig = await getNpcConfig(completedTask.npcId);
                if (npcConfig) {
                  const assignerSockets = getJoinedSocketsForUserAndChannel(io, player.userId, player.mapId);
                  const targetSocket = assignerSockets[0] || socket;

                  const taskSessionPrompt = buildTaskSessionPrompt({
                    ...promotedTask,
                    summary: promotedTask.summary || "",
                    createdAt: (promotedTask as { createdAt?: string }).createdAt || "",
                  }, getSocketLocale(targetSocket));
                  const autoStartMessage = withTaskReminder(`${promotedTask.title} 업무를 시작합니다.`, getSocketLocale(targetSocket));
                  const messageToSend = `${taskSessionPrompt}\n\n${autoStartMessage}`;
                  const sessionKey = `${npcConfig.sessionKeyPrefix || completedTask.npcId}-task-${promotedTask.npcTaskId}`;

                  const response = await streamNpcResponse(
                    targetSocket,
                    completedTask.npcId,
                    npcConfig,
                    player.userId,
                    messageToSend,
                    undefined,
                    sessionKey,
                    "npc:task-response",
                  );

                  if (response) {
                    const parsed = parseNpcResponse(response);
                    await processNpcTaskActions(io, parsed, {
                      channelId: player.mapId,
                      npcId: completedTask.npcId,
                      npcName: npcConfig._name,
                      assignerCharacterId: player.characterId,
                      targetUserId: player.userId,
                    });
                    targetSocket.emit("npc:response-complete", {
                      npcId: completedTask.npcId,
                      npcName: npcConfig._name || completedTask.npcId,
                    });
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("[TaskManager] Error completing task:", err);
      }
    });

    socket.on("task:get-report", async ({ taskId }: { taskId: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !taskId) return;

        const reports = await getReportsByTaskId(db, { npcReports }, taskId);
        const lastReport = reports.length > 0 ? reports[reports.length - 1] : null;
        socket.emit("task:report", {
          taskId,
          message: lastReport?.message || null,
          kind: lastReport?.kind || null,
          createdAt: lastReport?.createdAt || null,
        });
      } catch (err) {
        console.error("[TaskManager] Error getting task report:", err);
        socket.emit("task:report", { taskId, message: null, kind: null, createdAt: null });
      }
    });

    registerMeetingSocketHandlers({
      io,
      socket,
      deps: {
        meetingRooms,
        players,
        lastChatTime,
        chatCooldownMs: CHAT_COOLDOWN_MS,
        user,
        getParticipationAccess: getSocketChannelParticipationAccess,
        emitChannelAccessDenied: (meetingSocket, input) => {
          emitChannelAccessDenied(
            meetingSocket as unknown as Socket,
            input as Parameters<typeof emitChannelAccessDenied>[1],
          );
        },
        onMeetingChat: async ({ channelId, message, room, player }) => {
          const npcConfigs = await getNpcConfigsForChannel(channelId);
          // Stagger NPC responses with random delays, but track all promises
          const promises = npcConfigs.map((npc) => {
            const delay = 1000 + Math.random() * 2000;
            return new Promise<void>((resolve) => {
              setTimeout(async () => {
                try {
                  await streamMeetingNpcResponse(
                    io,
                    channelId,
                    npc,
                    room,
                    message,
                    player?.characterName || "Unknown",
                    user.userId,
                  );
                } catch (err) {
                  console.error(`[meeting] NPC ${npc._name} failed:`, err);
                  // Notify client that this NPC failed to respond
                  emitMeetingNpcStream(io, channelId, {
                    messageId: `error-${Date.now()}-${npc._name}`,
                    sender: npc._name,
                    chunk: "",
                    done: true,
                    error: true,
                  });
                }
                resolve();
              }, delay);
            });
          });
          await Promise.allSettled(promises);
        },
      },
    });

    registerMeetingDiscussionHandlers({
      io,
      socket,
      deps: {
        activeBrokers,
        discussionInitiators,
        meetingRooms,
        players,
        user,
        adapterRegistry,
        getNpcConfigsForChannel,
        canControlMeeting,
        generateMeetingSummary,
        persistMeetingMinutes,
      },
    });

    // ----- disconnect -----
    socket.on("disconnect", () => {
      const player = players.get(socket.id);
      if (player) {
        socket.to(player.mapId).emit("player:left", { id: socket.id });

        // Save last position to DB
        const px = Math.round(player.x);
        const py = Math.round(player.y);
        try {
          const result = db
            .update(channelMembers)
            .set({ lastX: px, lastY: py })
            .where(
              and(
                eq(channelMembers.channelId, player.mapId),
                eq(channelMembers.userId, player.userId),
              ),
            );
          // Handle both sync (SQLite) and async (PG)
          if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
            (result as unknown as Promise<unknown>).catch((err: Error) => {
              console.error("[socket] Position save failed (async):", err.message);
            });
          }
        } catch (e) {
          console.error("[socket] Position save failed (sync):", e instanceof Error ? e.message : e);
        }

        players.delete(socket.id);
      }

      // Clean up meeting room participation
      for (const [channelId, room] of meetingRooms.entries()) {
        if (room.participants.has(socket.id)) {
          room.participants.delete(socket.id);
          socket
            .to(`meeting-${channelId}`)
            .emit("meeting:participant-left", { id: socket.id });
        }
      }

      for (const [channelId, broker] of activeBrokers.entries()) {
        const room = meetingRooms.get(channelId);
        if (room && room.participants.size === 0) {
          broker.stop();
          activeBrokers.delete(channelId);
          discussionInitiators.delete(channelId);
        }
      }

      lastChatTime.delete(socket.id);
    });
  });
}
