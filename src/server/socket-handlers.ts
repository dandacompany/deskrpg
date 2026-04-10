import { Server, Socket } from "socket.io";
import { jwtVerify } from "jose";
import { eq, and } from "drizzle-orm";
import {
  db,
  channels,
  npcs,
  channelMembers,
  tasks,
  scheduledTasks,
  npcReports,
  characters,
  groupMembers,
  meetingMinutes,
  jsonForDb,
} from "../db";
import { ScheduledTaskManager } from "../lib/scheduled-task-manager";
import { getNextCronRun, validateCronExpr } from "../lib/cron-parser";
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
  emitMeetingNpcStream,
  registerMeetingSocketHandlers,
} from "./meeting-socket";
import { registerMeetingDiscussionHandlers } from "./meeting-discussion";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { OpenClawGateway } = require("../lib/openclaw-gateway.js") as { OpenClawGateway: new () => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseNpcResponse, isValidTaskAction } = require("../lib/task-parser.js") as typeof import("../lib/task-parser.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeNpcResponseText } = require("../lib/task-block-utils.js") as typeof import("../lib/task-block-utils.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TaskManager, generateTaskId } = require("../lib/task-manager.js") as { TaskManager: new (db: typeof import("../db").db, schema: { tasks: typeof tasks; npcs: typeof npcs }) => { handleTaskAction: (...args: unknown[]) => Promise<unknown>; getTasksByNpc: (npcId: string) => Promise<unknown[]>; getTasksByChannel: (channelId: string) => Promise<unknown[]>; deleteTask: (taskId: string, channelId: string) => Promise<unknown>; getStaleInProgressTasks: (channelId: string, olderThanIso: string) => Promise<unknown[]>; markTaskNudged: (taskId: string, channelId: string) => Promise<unknown>; markTaskStalled: (taskId: string, channelId: string, reason: string) => Promise<unknown>; resumeTask: (taskId: string, channelId: string) => Promise<unknown>; completeTask: (taskId: string, channelId: string) => Promise<unknown>; createBacklogTask: (channelId: string, assignerId: string, title: string, summary: string | null, npcTaskIdOverride?: string) => Promise<unknown>; moveTask: (taskId: string, channelId: string, toStatus: string, npcId: string | null) => Promise<unknown>; getTaskById: (taskId: string, channelId: string) => Promise<unknown>; getTaskByNpcTaskId: (npcId: string, npcTaskId: string) => Promise<unknown>; }; generateTaskId: () => string; };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withTaskReminder, normalizeTaskPromptLocale, buildTaskSessionPrompt, buildTaskSummaryContext } = require("../lib/task-prompt.js") as typeof import("../lib/task-prompt.js");

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

interface NpcConfig {
  id: string;
  name: string;
  agentId: string | null;
  sessionKeyPrefix: string;
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
const SCHEDULED_TASK_SCAN_MS = 60_000;
const taskManager = new TaskManager(db, { tasks, npcs });
const scheduledTaskManager = new ScheduledTaskManager(db, { scheduledTasks, tasks });
const progressNudgeInFlight = new Set<string>();
const progressNudgeCooldowns = new Map<string, number>();
const scheduledTaskInFlight = new Set<string>();
let progressNudgeTimer: NodeJS.Timeout | null = null;
let scheduledTaskTimer: NodeJS.Timeout | null = null;

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

    // Server assigns ID for create actions (NPC no longer generates IDs)
    const ta = taskAction as { action: string; id?: string; title: string; summary?: string; status?: string };
    if (ta.action === "create" && (!ta.id || ta.id.startsWith("{") || ta.id.includes("YYYYMMDD"))) {
      ta.id = generateTaskId();
    }

    try {
      const task = await taskManager.handleTaskAction(
        ta,
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
    if (!npcConfig?.agentId) return;

    const targetUserId = await getAssignerUserId(task.assignerId);
    if (!targetUserId) return;

    const gateway = await getOrConnectGateway(task.channelId);
    if (!gateway) return;

    const sessionKey = `${npcConfig.sessionKeyPrefix || task.npcId}-dm-${targetUserId}`;
    await taskManager.markTaskNudged(task.id, task.channelId);
    const response = await gateway.chatSend(
      npcConfig.agentId,
      sessionKey,
      withTaskReminder(promptOverride ?? buildAutoExecutionPrompt(task)),
      () => {},
    );
    const parsed = parseNpcResponse(response);

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
// Scheduled task scanner — runs every 60s, executes due recurring tasks
// ---------------------------------------------------------------------------

async function scanScheduledTasks(io: Server) {
  try {
    const now = new Date();
    const dueSchedules = await scheduledTaskManager.getDueSchedules(now);

    for (const schedule of dueSchedules) {
      if (scheduledTaskInFlight.has(schedule.id)) continue;
      scheduledTaskInFlight.add(schedule.id);

      try {
        // Resolve assigner's userId for report delivery
        const assignerRows = await db.select({ userId: characters.userId })
          .from(characters).where(eq(characters.id, schedule.assignerId)).limit(1);
        const targetUserId = assignerRows[0]?.userId;
        if (!targetUserId) { console.warn("[scheduled-task] No user for assigner", schedule.assignerId); continue; }

        // Create child task
        const childTask = await taskManager.createBacklogTask(
          schedule.channelId, schedule.assignerId, schedule.title, schedule.summary, undefined, schedule.id,
        ) as ManagedTask | null;
        if (!childTask) continue;

        // Move to in_progress with NPC assignment
        const movedTask = await taskManager.moveTask(childTask.id, schedule.channelId, "in_progress", schedule.npcId) as ManagedTask | null;
        if (!movedTask) continue;

        const { _fromStatus, ...taskData } = movedTask as ManagedTask & { _fromStatus?: string };
        io.to(schedule.channelId).emit("task:updated", { task: taskData, action: "scheduled_execute" });

        // Execute via NPC gateway (no socket needed — offline capable)
        const npcConfig = await getNpcConfig(schedule.npcId);
        if (!npcConfig) {
          console.warn("[scheduled-task] No NPC config for", schedule.npcId);
          continue;
        }

        const gateway = await getOrConnectGateway(schedule.channelId);
        if (!gateway) {
          console.warn("[scheduled-task] Gateway not available for channel", schedule.channelId);
          continue;
        }

        const prompt = `[SCHEDULED TASK]\n제목: ${schedule.title}\n태스크 ID: ${taskData.npcTaskId}\n${schedule.summary ? `설명: ${schedule.summary}\n` : ""}이 태스크는 자동 스케줄에 의해 실행되었습니다. 즉시 작업을 수행하고 결과를 보고하세요.`;
        const messageToSend = withTaskReminder(prompt, "ko");
        const sessionKey = `${npcConfig.sessionKeyPrefix || schedule.npcId}-task-${taskData.npcTaskId}`;

        let response = "";
        try {
          response = await gateway.chatSend(
            npcConfig.agentId,
            sessionKey,
            messageToSend,
            () => {}, // No streaming for offline execution
          ) || "";
        } catch (chatErr) {
          console.error("[scheduled-task] Gateway chat error:", (chatErr as Error).message);
        }

        if (response) {
          const parsed = parseNpcResponse(response);
          await processNpcTaskActions(io, parsed, {
            channelId: schedule.channelId,
            npcId: schedule.npcId,
            npcName: npcConfig._name,
            assignerCharacterId: schedule.assignerId,
            targetUserId,
          });

          // Emit execution notification to connected clients
          io.to(schedule.channelId).emit("schedule:executed", {
            scheduleId: schedule.id,
            taskId: taskData.id,
            npcId: schedule.npcId,
            title: schedule.title,
          });
        }

        // Advance schedule
        const nextRunAt = getNextCronRun(schedule.cronExpr, schedule.timezone, now);
        await scheduledTaskManager.markExecuted(schedule.id, now, nextRunAt);
        await scheduledTaskManager.cleanupOldHistory(schedule.id, schedule.maxHistory);

        console.log(`[scheduled-task] Executed "${schedule.title}" → next run: ${nextRunAt.toISOString()}`);
      } catch (err) {
        console.error(`[scheduled-task] Error executing schedule ${schedule.id}:`, err);
      } finally {
        scheduledTaskInFlight.delete(schedule.id);
      }
    }
  } catch (err) {
    console.error("[scheduled-task] Scan failed:", err);
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

    return {
      id: npc.id,
      name: npc.name,
      agentId: (oc.agentId as string) || null,
      sessionKeyPrefix: (oc.sessionKeyPrefix as string) || npcId,
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
      return {
        id: npc.id,
        name: npc.name,
        agentId: (oc.agentId as string) || null,
        sessionKeyPrefix: (oc.sessionKeyPrefix as string) || npc.id,
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
  const { agentId, _channelId, sessionKeyPrefix } = npcConfig;
  const responseEvent = emitEvent || "npc:response";

  if (!agentId) {
    emitNpcSystemResponse(socket, npcId, "no_agent");
    return "";
  }

  const gateway = await getOrConnectGateway(_channelId);
  if (!gateway) {
    emitNpcSystemResponse(socket, npcId, "gateway_not_connected");
    return "";
  }

  const sessionKey = sessionKeyOverride || `${sessionKeyPrefix || npcId}-dm-${userId}`;
  try {
    const response = await gateway.chatSend(
      agentId,
      sessionKey,
      message,
      (delta: string) => {
        socket.emit(responseEvent, { npcId, chunk: delta, done: false });
      },
      attachments,
    );
    socket.emit(responseEvent, { npcId, chunk: "", done: true });
    return response || "";
  } catch (err) {
    console.error(`[npc] OpenClaw chatSend error for ${npcId}:`, err);
    emitNpcSystemResponse(socket, npcId, "gateway_error");
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
): Promise<void> {
  const { agentId, sessionKeyPrefix, _name } = npcConfig;

  // Skip NPCs without an assigned agent in meeting rooms
  if (!agentId) return;

  const gateway = await getOrConnectGateway(channelId);
  if (!gateway) return;

  const sessionKey = `${sessionKeyPrefix || _name}-meeting-${channelId}`;
  const prompt = `${senderName}: ${userMessage}`;

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

  let fullText = "";
  try {
    await gateway.chatSend(agentId, sessionKey, prompt, (delta: string) => {
      fullText += delta;
      npcMessage.content = fullText;
      emitMeetingNpcStream(io, channelId, {
        messageId: npcMessage.id,
        sender: _name,
        chunk: delta,
        done: false,
      });
    });
    npcMessage.content = fullText;
    emitMeetingNpcStream(io, channelId, {
      messageId: npcMessage.id,
      sender: _name,
      chunk: "",
      done: true,
    });
    io.to(`meeting-${channelId}`).emit("meeting:message", npcMessage);
  } catch (err) {
    console.error(`[meeting] OpenClaw error for NPC ${_name}:`, err);
    room.messages.pop();
  }
}

async function generateMeetingSummary(
  gateway: {
    chatSend: (
      agentId: string,
      sessionKey: string,
      message: string,
      onChunk: (delta: string) => void,
    ) => Promise<string>;
  },
  agentId: string,
  sessionKeyPrefix: string,
  meetingId: string,
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
    const sessionKey = `${sessionKeyPrefix}-summary-${meetingId}`;
    const response = await Promise.race([
      gateway.chatSend(agentId, sessionKey, summaryPrompt, () => {}),
      new Promise<string>((_, reject) => {
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

const DEV_JWT_SECRET = "deskrpg-dev-jwt-secret-do-not-use-in-production";

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setupSocketHandlers(io: Server) {
  if (!progressNudgeTimer) {
    progressNudgeTimer = setInterval(() => {
      void scanProgressNudges(io);
    }, PROGRESS_NUDGE_SCAN_MS);
  }
  if (!scheduledTaskTimer) {
    scheduledTaskTimer = setInterval(() => {
      void scanScheduledTasks(io);
    }, SCHEDULED_TASK_SCAN_MS);
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

    // ----- npc:chat -----
    socket.on(
      "npc:chat",
      async (data: {
        npcId: string;
        message: string;
        files?: Array<{ name: string; type: string; size: number; data: ArrayBuffer }>;
        asTask?: boolean;
      }) => {
        const { npcId, message, files, asTask } = data;
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

        // Pre-register task if user toggled "Send as Task"
        let preRegisteredTaskId: string | null = null;
        if (asTask && player?.characterId) {
          const taskId = generateTaskId();
          const taskTitle = trimmed.slice(0, 50);
          const task = await taskManager.createBacklogTask(
            npcConfig._channelId, player.characterId, taskTitle, trimmed, taskId,
          ) as ManagedTask | null;
          if (task) {
            const movedTask = await taskManager.moveTask(task.id, npcConfig._channelId, "in_progress", npcId) as ManagedTask | null;
            if (movedTask) {
              const { _fromStatus, ...taskData } = movedTask as ManagedTask & { _fromStatus?: string };
              io.to(player.mapId).emit("task:updated", { task: taskData, action: "create" });
              preRegisteredTaskId = taskId;
              // Notify chat tab that a task was registered
              socket.emit("npc:task-registered", {
                npcId,
                taskId: taskData.id,
                npcTaskId: taskId,
                title: taskTitle,
              });
            }
          }
        }

        // Inject active task summary so NPC is aware of board tasks during DM chat
        const npcActiveTasks = await taskManager.getTasksByNpc(npcId) as ManagedTask[];
        const taskContext = buildTaskSummaryContext(npcActiveTasks);

        // Inject task reminder on every NPC DM so task actions can be parsed consistently.
        const fileSection = buildFilePromptSection(extractedFiles);
        let userContent = taskContext + trimmed + fileSection;
        if (preRegisteredTaskId) {
          userContent = `[SYSTEM: The user has registered this as a task. Task ID: ${preRegisteredTaskId}. Title: "${trimmed.slice(0, 50)}". Execute immediately and include a json:task block with action "update" or "complete" using this exact ID in your response.]\n\n${userContent}`;
        }
        const messageToSend = withTaskReminder(userContent, getSocketLocale(socket));

        // Stream response via OpenClaw
        chatLog(`  → gateway (${npcConfig._name}): msgLen=${messageToSend.length}(${(messageToSend.length/1024).toFixed(0)}KB)`, fileAttachments ? `+${fileAttachments.length} att(${fileAttachments.map(a => `${a.fileName}:${(a.content.length/1024).toFixed(0)}KB`).join(",")})` : "");
        const response = await streamNpcResponse(socket, npcId, npcConfig, user.userId, messageToSend, fileAttachments);
        chatLog(`  ← npc response (${npcConfig._name}):`, response ? response.slice(0, 150) + (response.length > 150 ? "..." : "") : "(empty)");
        if (response) {
          const parsed = parseNpcResponse(response);
          const sanitizedResponse = sanitizeNpcResponseText(response);
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

        // Inject recent DM context so the task session has conversational awareness
        const dmHistoryKey = `${player?.mapId || npcConfig._channelId}:${npcId}`;
        const dmHistory = npcChatHistory.get(dmHistoryKey) || [];
        const recentDm = dmHistory.slice(-3).map((h) => `[${h.role}]: ${h.content.slice(0, 100)}`).join("\n");
        const dmContext = recentDm ? `\n[RECENT DM CONTEXT]\n${recentDm}\n` : "";

        // Build message with task session context
        const fileSection = buildFilePromptSection(extractedFiles);
        const taskPrompt = task
          ? buildTaskSessionPrompt(task, getSocketLocale(socket))
          : "";
        const messageToSend = (taskPrompt ? taskPrompt + "\n\n" : "") + dmContext + withTaskReminder(trimmed + fileSection, getSocketLocale(socket));

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
          // Notify chat that task was registered (with optional NPC assignment)
          if (npcId) {
            socket.emit("npc:task-registered", {
              npcId,
              taskId: (task as ManagedTask).id,
              npcTaskId: (task as ManagedTask).npcTaskId,
              title: trimmedTitle,
            });
          }
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

        const movedTask = await taskManager.moveTask(taskId, player.mapId, toStatus, npcId || null) as (ManagedTask & { _fromStatus?: string }) | null;
        if (!movedTask) return;

        const fromStatus = movedTask._fromStatus;
        const { _fromStatus, ...task } = movedTask;
        io.to(player.mapId).emit("task:updated", { task, action: `move_${fromStatus}_${toStatus}` });

        if (
          toStatus === "in_progress" &&
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
              // Mirror task execution result to chat tab
              const sanitized = sanitizeNpcResponseText(response);
              socket.emit("npc:task-chat-mirror", {
                npcId: task.npcId,
                npcTaskId: task.npcTaskId,
                taskTitle: task.title,
                content: sanitized.slice(0, 500),
                action: "auto_execute",
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
        }
      } catch (err) {
        console.error("[TaskManager] Error completing task:", err);
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
        getOrConnectGateway,
        getNpcConfigsForChannel,
        canControlMeeting,
        generateMeetingSummary: (gateway, agentId, sessionKeyPrefix, meetingId, topic, transcript) =>
          generateMeetingSummary(
            gateway as Parameters<typeof generateMeetingSummary>[0],
            agentId,
            sessionKeyPrefix,
            meetingId,
            topic,
            transcript,
          ),
        persistMeetingMinutes,
      },
    });

    // ----- schedule CRUD -----
    socket.on("schedule:create", async (data: { channelId?: string; npcId?: string; title?: string; summary?: string; cronExpr?: string; timezone?: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player) return;
        const { channelId, npcId, title, cronExpr } = data;
        if (!channelId || !npcId || !title || !cronExpr) return;
        const validationError = validateCronExpr(cronExpr);
        if (validationError) { socket.emit("schedule:error", { error: validationError }); return; }
        const schedule = await scheduledTaskManager.create({
          channelId, npcId, assignerId: player.characterId,
          title: title.trim().slice(0, 200), summary: data.summary?.trim() || null,
          cronExpr, timezone: data.timezone || "Asia/Seoul",
        });
        io.to(player.mapId).emit("schedule:updated", { schedule, action: "create" });
      } catch (err) { console.error("[schedule] Create error:", err); }
    });

    socket.on("schedule:update", async (data: { scheduleId?: string; title?: string; summary?: string; cronExpr?: string; timezone?: string; maxHistory?: number }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !data.scheduleId) return;
        if (data.cronExpr) {
          const validationError = validateCronExpr(data.cronExpr);
          if (validationError) { socket.emit("schedule:error", { error: validationError }); return; }
        }
        const schedule = await scheduledTaskManager.update(data.scheduleId, player.mapId, {
          title: data.title, summary: data.summary, cronExpr: data.cronExpr,
          timezone: data.timezone, maxHistory: data.maxHistory,
        });
        if (schedule) io.to(player.mapId).emit("schedule:updated", { schedule, action: "update" });
      } catch (err) { console.error("[schedule] Update error:", err); }
    });

    socket.on("schedule:delete", async (data: { scheduleId?: string }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !data.scheduleId) return;
        const deleted = await scheduledTaskManager.delete(data.scheduleId, player.mapId);
        if (deleted) io.to(player.mapId).emit("schedule:updated", { schedule: { id: data.scheduleId }, action: "delete" });
      } catch (err) { console.error("[schedule] Delete error:", err); }
    });

    socket.on("schedule:list", async (data: { channelId?: string }) => {
      try {
        const channelId = data?.channelId;
        if (!channelId) return;
        const schedules = await scheduledTaskManager.getByChannel(channelId);
        socket.emit("schedule:list-response", { schedules });
      } catch (err) { console.error("[schedule] List error:", err); }
    });

    socket.on("schedule:toggle", async (data: { scheduleId?: string; enabled?: boolean }) => {
      try {
        const player = players.get(socket.id);
        if (!player || !data.scheduleId || data.enabled === undefined) return;
        const schedule = await scheduledTaskManager.setEnabled(data.scheduleId, player.mapId, data.enabled);
        if (schedule) io.to(player.mapId).emit("schedule:updated", { schedule, action: "toggle" });
      } catch (err) { console.error("[schedule] Toggle error:", err); }
    });

    socket.on("schedule:history", async (data: { scheduleId?: string; limit?: number }) => {
      try {
        if (!data.scheduleId) return;
        const tasks = await scheduledTaskManager.getExecutionHistory(data.scheduleId, data.limit || 20);
        socket.emit("schedule:history-response", { scheduleId: data.scheduleId, tasks });
      } catch (err) { console.error("[schedule] History error:", err); }
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
