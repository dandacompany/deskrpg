import { Server, Socket } from "socket.io";
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
const { TaskManager } = require("../lib/task-manager.js") as { TaskManager: new (db: typeof import("../db").db, schema: { tasks: typeof tasks; npcs: typeof npcs }) => { handleTaskAction: (...args: unknown[]) => Promise<unknown>; getTasksByNpc: (npcId: string) => Promise<unknown[]>; getTasksByChannel: (channelId: string) => Promise<unknown[]>; deleteTask: (taskId: string, channelId: string) => Promise<unknown>; getStaleInProgressTasks: (channelId: string, olderThanIso: string) => Promise<unknown[]>; markTaskNudged: (taskId: string, channelId: string) => Promise<unknown>; markTaskStalled: (taskId: string, channelId: string, reason: string) => Promise<unknown>; resumeTask: (taskId: string, channelId: string) => Promise<unknown>; completeTask: (taskId: string, channelId: string) => Promise<unknown>; getTaskById: (taskId: string, channelId: string) => Promise<unknown>; }; };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withTaskReminder, normalizeTaskPromptLocale } = require("../lib/task-prompt.js") as typeof import("../lib/task-prompt.js");

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

      io.to(input.channelId).emit("task:updated", { task, action: (taskAction as { action: string }).action });

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
): Promise<string> {
  const { agentId, _channelId, sessionKeyPrefix } = npcConfig;

  if (!agentId) {
    emitNpcSystemResponse(socket, npcId, "no_agent");
    return "";
  }

  const gateway = await getOrConnectGateway(_channelId);
  if (!gateway) {
    emitNpcSystemResponse(socket, npcId, "gateway_not_connected");
    return "";
  }

  const sessionKey = `${sessionKeyPrefix || npcId}-dm-${userId}`;
  try {
    const response = await gateway.chatSend(agentId, sessionKey, message, (delta: string) => {
      socket.emit("npc:response", { npcId, chunk: delta, done: false });
    });
    socket.emit("npc:response", { npcId, chunk: "", done: true });
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

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
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
      async (data: { npcId: string; message: string }) => {
        const { npcId, message } = data;

        // Validate
        if (!npcId || !message || typeof message !== "string") return;
        const trimmed = message.trim().slice(0, 500);
        if (!trimmed) return;

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

        const player = players.get(socket.id);
        const historyKey = `${player?.mapId || npcConfig._channelId}:${npcId}`;
        const history = npcChatHistory.get(historyKey) || [];
        history.push({ role: "player", content: trimmed, timestamp: Date.now() });

        // Inject task reminder on every NPC DM so task actions can be parsed consistently.
        const messageToSend = withTaskReminder(trimmed, getSocketLocale(socket));

        // Stream response via OpenClaw
        const response = await streamNpcResponse(socket, npcId, npcConfig, user.userId, messageToSend);
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
          for (const npc of npcConfigs) {
            const delay = 1000 + Math.random() * 2000;
            setTimeout(async () => {
              await streamMeetingNpcResponse(
                io,
                channelId,
                npc,
                room,
                message,
                player?.characterName || "Unknown",
              );
            }, delay);
          }
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
