import { broadcastNpcUpdate } from "./npc-update-broadcast";
import { mapContentRevision } from "../lib/channel-map-revision";
import { createChannelMapRefresh } from "./channel-map-refresh";
import { registerMapRefreshHandler } from "../lib/channel-map-refresh";
import { effectiveMapSpawn, isCreativeStudioMap } from "../lib/effective-map-spawn";
import {
  PlayerResumeStore,
  readPlayerDestination,
  type PlayerDestination,
} from "./player-resume-state";
import { getChannelTimeZone } from "../lib/channel-timezone";
import { setNpcActive } from "../lib/npc-roster";
import { getMyCharacter, isMyCharacter, type MyCharacter } from "../lib/my-character";
import { createNpcCoordination } from "./npc-coordination";
import {
  createMeetingSpatialCoordinator,
  type MeetingSpatialCoordinator,
} from "./meeting-spatial-coordinator";
import { deriveChannelMotionLayout, closestValidUnoccupiedSpawn } from "./channel-motion-layout";
import { ChatResponseTracker, SessionQueue } from "./chat-response-tracker";
import { runTrackedDm, executeDmAdapter } from "./dm-response-runtime";
import { Server, Socket } from "socket.io";
import type { NpcAdapter } from "../lib/adapters/types";
import {
  createApprovalTimeoutLookup,
  createToolApprovalRegistry,
  withToolApprovals,
  type ApprovalRoute,
  type ToolApprovalRegistry,
} from "./tool-approvals";
import { getProfileClientForNpc } from "@/lib/hermes-profiles";
import {
  answerNpcQuestion,
  npcCanAskUser,
  registerAskUserSession,
  sessionQuestions,
  type AskUserContext,
} from "@/lib/npc-questions";
import { NPC_QUESTION_EVENTS, withAskUser } from "./ask-user";
import { roomSocketRoom, userSocketRoom } from "./room-broadcast";
import { jwtVerify } from "jose";
import { eq, and } from "drizzle-orm";
import {
  db,
  channels,
  channelMembers,
  characters,
  groupMembers,
  meetingMinutes,
  chatMessages,
  jsonForDb,
} from "../db";
import { describeActivity } from "@/lib/npc-activity";
import { readLocaleCookie } from "@/lib/i18n/server";
import { composeNpcInstructions } from "@/lib/npc-prompt-layers";
import { getDefaultMeetingProtocol } from "@/lib/meeting-protocol";
import {
  appendNpcChatMessage,
  characterBelongsToUser,
  clearNpcChatHistory,
  loadDmThreads,
  loadNpcChatHistory,
  npcHistoryKey,
  pickHistoryCharacterId,
  type NpcHistoryMessage,
} from "@/lib/npc-chat-history";
import {
  extractFileContent,
  buildFilePromptSection,
  buildAttachments,
  isAllowedFileType,
  FILE_LIMITS,
} from "@/lib/file-extractor";
import type { ExtractedFile, GatewayAttachment } from "@/lib/file-extractor";

const DEBUG_CHAT = process.env.DEBUG_CHAT === "1" || process.env.DEBUG_CHAT === "true";
function chatLog(...args: unknown[]) {
  if (DEBUG_CHAT) console.log("[npc:chat]", ...args);
}

import { selectChannelNpcs, selectNpcById } from "../lib/npc-projection";
import { registerNpcRosterHandlers } from "./npc-roster-socket";
import {
  buildChannelAccessDeniedPayload,
  type ChannelAccessDeniedReason,
  summarizeChannelParticipationAccess,
} from "../lib/rbac/channel-access";
import { gatewayFailureMessageCode } from "../lib/hermes/classify-gateway-failure";
import { type NpcResponseMessageCode, type NpcResponsePayload } from "../lib/npc-response-messages";
import {
  deliverMeetingNpcAnswer,
  emitMeetingNpcStream,
  registerMeetingSocketHandlers,
} from "./meeting-socket";
import {
  registerMeetingDiscussionHandlers,
  resolveNpcAdapter,
  settleMeeting,
} from "./meeting-discussion";
import { createResummarizer } from "./meeting-resummarize";
import { registerRoomHandlers } from "./room-socket";
import { normalizeOfficeAppearance } from "@/game/three/office-appearance";
import { AUTOMATION_SOCKET_EVENTS, getWorkingSnapshot } from "./automation-events";
import { GATEWAY_HEALTH_EVENT, getGatewayHealth } from "./gateway-health";
import { setChannelActive, startAutomationPollers } from "./automation-poller";
import {
  getOrCreateRoomRuntime,
  invalidateRoomRuntime,
  invalidateRoomRuntimesForChannel,
} from "./room-runtime";
import * as chatRooms from "@/lib/chat-rooms";
import { attachDmReads, attachRoomReads, markConversationRead } from "@/lib/conversation-reads";
import { CONVERSATION_READ_EVENT, parseReadMark } from "@/lib/read-mark";
import {
  buildMeetingSummaryPrompt,
  parseMeetingOutcome,
  type MeetingOutcome,
  type MeetingSummaryStatus,
  type OutcomeParticipant,
  type ParsedMeetingOutcome,
} from "@/lib/meeting-outcome";
import { announceMeetingOutcome } from "@/lib/meeting-outcome-notice";
import { registerMeetingHooks } from "@/lib/meeting-registry";
import { prefixReportFormat } from "@/lib/report-format";
import { prefixUserContext, type UserContext } from "@/lib/user-context";
import { AdapterRegistry } from "../lib/adapters/types.js";
import { createApprovalSummarizer, runApprovalSummaryAsNpc } from "./tool-approval-summary";
import {
  classifyNpcDispatch,
  clearHermesRun,
  createHermesAdapterForNpc,
  deriveHermesContextKey,
  persistHermesSessionRef,
  registerHermesRun,
} from "./hermes-dispatch";
import { isUuid } from "@/lib/uuid";
import { registerNpcsPlacedNotifier } from "@/lib/npc-roster-registry";
import { broadcastPlacedNpcs } from "./npc-placement-broadcast";

// Nothing registers here at boot — Hermes NPCs dispatch through hermes-dispatch. The registry is
// the seam for any other adapter type; an NPC whose type is not registered gets
// `unsupported_adapter`.
export const adapterRegistry = new AdapterRegistry();

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
  motion?: PlayerDestination | null;
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
  /** Language of the prompt document. Task procedures are built in that language. */
  locale?: string | null;
  /**
   * System instructions attached to this NPC's turn. getNpcConfig* assembles the layers to fill it —
   * callers don't compute anything and only read this field. 1:1, meetings and channel mentions use the same value.
   */
  instructions?: string;
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
const playerResumeStates = new PlayerResumeStore();

// Rate limit: socketId -> last message timestamp
const lastChatTime = new Map<string, number>();

// Meeting rooms: channelId -> MeetingRoom
const meetingRooms = new Map<string, MeetingRoom>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeBrokers = new Map<string, any>();
const discussionInitiators = new Map<string, string>();

// NPC chat history: `${characterId}:${npcId}` -> messages.
// The source of truth is the chat_messages table and this map is a cache in front of it — empty when the process
// dies, but refilled from the DB on the next lookup. Keys are only ever built with npcHistoryKey().
const npcChatHistory = new Map<string, NpcHistoryMessage[]>();
const dmResponseQueue = new SessionQueue(8);
const dmResetting = new Set<string>();
const dmResponseTrackers = new Map<string, ChatResponseTracker>();
const dmResponseScope = (userId: string, characterId: string, npcId: string) =>
  `dm-response:${userId}:${characterId}:${npcId}`;
function getDmResponseTracker(io: Server, scope: string): ChatResponseTracker {
  const existing = dmResponseTrackers.get(scope);
  if (existing) return existing;
  // Evict only idle scopes; never lose the state of work currently queued/running.
  if (dmResponseTrackers.size >= 256) {
    const idle = [...dmResponseTrackers].find(([, tracker]) =>
      tracker
        .snapshot()
        .every((r) => r.status === "complete" || r.status === "failed" || r.status === "cancelled"),
    );
    if (!idle) throw new Error("queue_full");
    dmResponseTrackers.delete(idle[0]);
  }
  const tracker = new ChatResponseTracker((response) =>
    io.to(scope).emit("npc:response-state", { response }),
  );
  dmResponseTrackers.set(scope, tracker);
  return tracker;
}

// Live tool approvals — set up by setupSocketHandlers (it needs `io`). Until then adapters run unwrapped.
let toolApprovals: ToolApprovalRegistry | null = null;
const approvalTimeoutFor = createApprovalTimeoutLookup();
const userRoom = userSocketRoom;

/** The live approval registry of this process (null before setupSocketHandlers) — for tests. */
export function getToolApprovalRegistry(): ToolApprovalRegistry | null {
  return toolApprovals;
}

/** Routes a run's `approval.request` events to the approver as cards (no-op before setup). */
export function routeToolApprovals(adapter: NpcAdapter, route: ApprovalRoute): NpcAdapter {
  if (!toolApprovals) return adapter;
  return withToolApprovals(adapter, route, {
    registry: toolApprovals,
    timeoutFor: approvalTimeoutFor,
  });
}

// NPC questions (deskrpg_ask_user) — set up by setupSocketHandlers; until then 1:1 runs are unwrapped.
let emitToUserFn: ((userId: string, event: string, payload: unknown) => void) | null = null;

/** Registers a 1:1 run's session so the NPC can ask its user, and shows the questions it asks. */
export function routeAskUser(adapter: NpcAdapter, route: AskUserContext): NpcAdapter {
  const emitToUser = emitToUserFn;
  if (!emitToUser) return adapter;
  return withAskUser(adapter, route, {
    canAsk: npcCanAskUser,
    sessionIdOf: async (npcId, runId) =>
      (await getProfileClientForNpc(npcId))?.getRunSessionId(runId) ?? null,
    register: registerAskUserSession,
    questions: sessionQuestions,
    emit: (event, payload) => emitToUser(route.userId, event, payload),
  });
}

/** A user's character name in this process, for "waiting for <name>'s approval". */
export function playerNameOf(userId: string): string {
  for (const player of players.values()) {
    if (player.userId === userId) return player.characterName;
  }
  return "";
}

// Gateway connections: gatewayId -> gateway instance

const CHAT_COOLDOWN_MS = 2000;

function emitNpcSystemResponse(socket: Socket, npcId: string, messageCode: NpcResponseMessageCode) {
  const payload: NpcResponsePayload = {
    npcId,
    chunk: "",
    done: true,
    messageCode,
  };
  socket.emit("npc:response", payload);
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

/**
 * Whether the channel room has at least one socket — decides the automation poller interval (short/long) (R24).
 * At `disconnect` time the socket has already left the room, so counting as-is is correct.
 */
function channelHasSockets(io: Server, channelId: string): boolean {
  return (io.sockets?.adapter?.rooms?.get(channelId)?.size ?? 0) > 0;
}

/** Tells the poller about connection presence. Swallows poller-side failures here so they don't block the socket
 * flow. */
function notifyChannelActivity(io: Server, channelId: string) {
  void setChannelActive(channelId, channelHasSockets(io, channelId)).catch((err: unknown) => {
    console.warn(
      `[automation-poller] setChannelActive(${channelId}) failed:`,
      err instanceof Error ? err.message : err,
    );
  });
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

/**
 * Records one line in the history — in both the cache and the DB.
 *
 * A failed DB write doesn't cut the conversation. Between losing history and stalling the conversation,
 * the former is better. But it isn't silently skipped; it's logged — so as not to create a failure
 * that reports success.
 */
async function appendNpcHistoryMessage(
  characterId: string,
  npcId: string,
  content: string,
  role: "player" | "npc" = "npc",
  correlation?: { id: string; responseRequestId?: string },
) {
  if (!content.trim()) return null;

  const historyKey = npcHistoryKey(characterId, npcId);
  const history = npcChatHistory.get(historyKey) || [];
  const entry = { role, content, timestamp: Date.now(), ...correlation };
  if (!correlation) {
    history.push(entry);
    npcChatHistory.set(historyKey, history);
  }

  try {
    const persisted = await appendNpcChatMessage(
      db,
      { chatMessages },
      {
        characterId,
        npcId,
        role,
        content,
      },
    );
    if (correlation) {
      if (!persisted) throw new Error("message persistence returned no row");
      // Fetch the latest array: another queued source may have completed its write meanwhile.
      const current = npcChatHistory.get(historyKey) ?? [];
      current.push(entry);
      current.sort((a, b) => a.timestamp - b.timestamp);
      npcChatHistory.set(historyKey, current);
    }
  } catch (err) {
    console.error("[chat-history] failed to persist message", { characterId, npcId, role }, err);
    if (correlation) throw err;
  }
  return content;
}

/**
 * Decides whose history this socket's utterances are recorded under.
 *
 * For a socket that has finished join, the server knows the character, so that value is used. If it's not in
 * `players` (right after reconnect, before join succeeds again) the value sent by the client is used, but the DB
 * confirms it really is that user's character — trusting it unchecked could write into someone else's history.
 */
async function resolveHistoryCharacterId(
  socket: Socket,
  userId: string,
  claimedCharacterId?: string | null,
): Promise<string | null> {
  const player = players.get(socket.id);
  const picked = pickHistoryCharacterId({
    joinedCharacterId: player?.characterId ?? null,
    claimedCharacterId: claimedCharacterId ?? null,
  });
  if (!picked.characterId) return null;
  if (!picked.needsVerification) return picked.characterId;

  try {
    const owned = await characterBelongsToUser(
      db,
      { characters },
      {
        characterId: picked.characterId,
        userId,
      },
    );
    if (!owned) {
      console.warn("[chat-history] rejected character claim", {
        socketId: socket.id,
        userId,
        claimed: picked.characterId,
      });
      return null;
    }
    return picked.characterId;
  } catch (err) {
    console.error("[chat-history] failed to verify character claim", err);
    return null;
  }
}

/** This socket's own character id as confirmed by the server in player:join. null before join. */
function myCharacterIdOf(socket: Socket): string | null {
  const id = socket.data.myCharacterId;
  return typeof id === "string" && id ? id : null;
}

/** "Who this person is" (name, bio) set by player:join. null before join — no preamble is attached. */
function userContextOf(socket: { data?: Record<string, unknown> }): UserContext | null {
  const ctx = socket.data?.userContext as UserContext | undefined;
  return ctx && typeof ctx.name === "string" && ctx.name ? ctx : null;
}

// This used to hold the OpenClaw gateway connection pool (getOrConnectGateway /
// invalidateGatewayConnectionForChannel). The real invalidation of gateway runtime state is done
// directly by gateway-resources.ts via invalidateGatewayRuntimeState when settings change,
// so invalidation isn't lost with this pool gone.

// ---------------------------------------------------------------------------
// NPC config loader
// ---------------------------------------------------------------------------

/**
 * The new hiring paths (`hireGatewayProfilesIntoChannel`, `hireProfileIntoBoundChannels`) leave
 * `agent_config` NULL — because the source of truth for name, appearance and persona moved to the profile.
 * So without a fallback, every NPC created after this release would join meetings without `<team-instructions>`.
 * Existing rows keep using their old `agent_config`.
 *
 * The default protocol gets a "response language contract". That language is decided **at request time**:
 * requesting user's UI language → the employee's `agent_config.locale` → "en" only as a last resort.
 * Previously only `agent_config.locale` was checked, so new employees without it got an "all speech in English"
 * contract even in a Korean office. A `meetingProtocol` written by the user is
 * left untouched — its language is the author's choice.
 * Meetings, 1:1 and rooms all resolve through this one function (so the paths don't diverge).
 */
export function resolveNpcInstructions(
  oc: Record<string, unknown>,
  requestLocale?: string | null,
): string | undefined {
  const locale = requestLocale || (typeof oc.locale === "string" ? oc.locale : undefined);
  // The task-registration layer follows the same language; with nothing known it is English (`null`).
  if (typeof oc.meetingProtocol === "string" && oc.meetingProtocol.trim()) {
    return composeNpcInstructions({
      meetingProtocol: oc.meetingProtocol,
      taskConfirmation: true,
      locale: locale ?? null,
    });
  }
  return composeNpcInstructions({
    meetingProtocol: getDefaultMeetingProtocol(locale),
    taskConfirmation: true,
    locale: locale ?? null,
  });
}

/** UI language of the user who opened this socket. null if there's no cookie. */
function socketLocale(socket: Socket): string | null {
  return readLocaleCookie(socket.handshake.headers.cookie);
}

async function getNpcConfig(
  npcId: string,
  requestLocale?: string | null,
): Promise<NpcConfig | null> {
  try {
    // The profile is the source of truth for the name — reading `npcs.name` would put the old name into the
    // conversation even after it's renamed in the profile. The projection handles name, appearance and JSON parsing
    // in one go.
    const npc = await selectNpcById(npcId);
    if (!npc) return null;

    const oc = (npc.agentConfig ?? {}) as Record<string, unknown>;
    const adapterConfig = (npc.adapterConfig ?? {}) as Record<string, unknown>;

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
      locale: typeof oc.locale === "string" ? oc.locale : null,
      instructions: resolveNpcInstructions(oc, requestLocale),
    };
  } catch (err) {
    console.error(`[npc] Failed to load config for ${npcId}:`, err);
    return null;
  }
}

export async function getNpcConfigsForChannel(
  channelId: string,
  requestLocale?: string | null,
): Promise<NpcConfig[]> {
  try {
    // Participant roster for meetings and free chat. Unplaced (off-map) NPCs stay; only dormant ones are removed —
    // if an NPC clocked out on the roster kept answering free chat, the toggle would have no effect.
    const rows = await selectChannelNpcs(channelId, { roster: true, includeDormant: false });

    return rows.map((npc) => {
      const oc = (npc.agentConfig ?? {}) as Record<string, unknown>;
      const adapterConfig = (npc.adapterConfig ?? {}) as Record<string, unknown>;
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
        locale: typeof oc.locale === "string" ? oc.locale : null,
        instructions: resolveNpcInstructions(oc, requestLocale),
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
// Gateway streaming — 1:1 DM chat
// ---------------------------------------------------------------------------

async function streamNpcResponse(
  socket: Socket,
  npcId: string,
  npcConfig: NpcConfig,
  userId: string,
  message: string,
  attachments?: GatewayAttachment[],
  sessionKeyOverride?: string,
  emitEvent?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { _channelId, sessionKeyPrefix, adapterType, hermesProfileId } = npcConfig;
  const responseEvent = emitEvent || "npc:response";
  const sessionKey = sessionKeyOverride || `${sessionKeyPrefix || npcId}-dm-${userId}`;
  // The conversation-partner line and report-format rules are prepended to the message — the system prompt
  // (instructions) isn't touched. Order is "who you're talking to" → "how to report" → the actual body.
  const locale = socketLocale(socket);
  const prompt = prefixUserContext(
    prefixReportFormat(message, locale),
    userContextOf(socket),
    locale,
  );

  const dispatchKind = classifyNpcDispatch({ adapterType, hermesProfileId });

  if (dispatchKind === "unbound") {
    emitNpcSystemResponse(socket, npcId, "npc_unbound");
    return "";
  }

  if (dispatchKind === "hermes") {
    const hermesAdapter = await createHermesAdapterForNpc(
      npcId,
      userId,
      deriveHermesContextKey(sessionKey, sessionKeyPrefix || npcId),
    );
    if (!hermesAdapter) {
      emitNpcSystemResponse(socket, npcId, "npc_unbound");
      return "";
    }
    // The approver of a 1:1 run is the user who talked to the NPC — and the one its questions go to.
    const approvals = routeToolApprovals(hermesAdapter, {
      npcId,
      channelId: _channelId,
      context: "dm",
      approver: () => ({ userId, name: userContextOf(socket)?.name ?? playerNameOf(userId) }),
    });
    const adapter = sessionKeyOverride
      ? approvals
      : routeAskUser(approvals, { npcId, userId, channelId: _channelId });

    if (attachments?.some((a) => a.type === "image")) {
      socket.emit(responseEvent, {
        npcId,
        chunk: "",
        done: false,
        messageCode: "hermes_image_unsupported",
      });
    }

    try {
      const { response, session } = await executeDmAdapter(
        adapter,
        {
          sessionKey,
          prompt,
          instructions: npcConfig.instructions,
          onDelta: (delta: string) => {
            socket.emit(responseEvent, { npcId, chunk: delta, done: false });
          },
          // tool.progress is a progress signal, not an answer. So only the **tool name** is used and
          // the delta body is discarded — measured (v0.20.2), the `_thinking` tool sends the complete answer
          // once more in the delta; previously this was streamed as chat chunks and in 1:1 conversations
          // the answer showed up exactly twice. The body path (onDelta) and the activity path are fully separated,
          // so that bug structurally cannot recur.
          onToolProgress: (toolName: string) => {
            // An empty name means "the tool finished" (tool.completed) — turn the indicator off.
            const notice = describeActivity(toolName);
            socket.emit("npc:activity", { npcId, activityKey: notice?.key ?? null });
          },
          onRunStarted: (runId: string) => {
            registerHermesRun(sessionKey, runId);
          },
        },
        undefined,
        signal,
      );
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
      emitNpcSystemResponse(socket, npcId, gatewayFailureMessageCode(err));
      return "";
    } finally {
      clearHermesRun(sessionKey);
      // Always turn the activity indicator off, success or failure — if left on it becomes "searching forever".
      socket.emit("npc:activity", { npcId, activityKey: null });
    }
  }

  // dispatchKind === "registry"
  if (adapterRegistry.has(adapterType)) {
    const adapter = adapterRegistry.get(adapterType);

    try {
      const { response } = await executeDmAdapter(
        adapter,
        {
          sessionKey,
          prompt,
          instructions: npcConfig.instructions,
          attachments,
          model:
            typeof npcConfig.adapterConfig.model === "string"
              ? npcConfig.adapterConfig.model
              : undefined,
          onDelta: (delta: string) => {
            socket.emit(responseEvent, { npcId, chunk: delta, done: false });
          },
          timeoutMs: 180_000,
        },
        undefined,
        signal,
      );
      socket.emit(responseEvent, { npcId, chunk: "", done: true });
      return response || "";
    } catch (err) {
      console.error("[npc] " + adapterType + " adapter error for " + npcId + ":", err);
      emitNpcSystemResponse(socket, npcId, gatewayFailureMessageCode(err));
      return "";
    }
  } else {
    emitNpcSystemResponse(socket, npcId, "unsupported_adapter");
    return "";
  }
}

// ---------------------------------------------------------------------------
// Gateway streaming — meeting room broadcast
// ---------------------------------------------------------------------------

async function streamMeetingNpcResponse(
  io: Server,
  channelId: string,
  npcConfig: NpcConfig,
  room: MeetingRoom,
  userMessage: string,
  senderName: string,
  userId: string,
  userContext: UserContext | null,
  locale: string | null,
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
  // Prepend the speaker's name/bio and report format (the meeting counterpart is the speaker).
  const prompt = prefixUserContext(
    prefixReportFormat(`${senderName}: ${userMessage}`, locale),
    userContext,
    locale,
  );

  let hermesAdapter: NpcAdapter | null = null;
  let hermesContextKey = "";

  if (dispatchKind === "openclaw") {
    // OpenClaw has been removed. NPCs still on this adapter announce that they need to be reconnected
    // instead of silently dropping out of the meeting.
    emitMeetingNpcStream(io, channelId, {
      npcId,
      npcName: _name,
      chunk: "",
      done: true,
      messageCode: "npc_unbound",
    });
    return;
  } else if (dispatchKind === "hermes") {
    hermesContextKey = deriveHermesContextKey(sessionKey, sessionKeyPrefix || _name);
    const created = await createHermesAdapterForNpc(npcId, userId, hermesContextKey);
    // In a meeting the approver is whoever opened it; a chat outside a running discussion asks the speaker.
    hermesAdapter = created
      ? routeToolApprovals(created, {
          npcId,
          channelId,
          context: "meeting",
          approver: () => {
            const approverId = discussionInitiators.get(channelId) ?? userId;
            return { userId: approverId, name: playerNameOf(approverId) };
          },
        })
      : null;
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

  // fullText must be declared before the onDelta closure — the reverse order is safe today
  // (only called inside execute) but one refactor away from a TDZ trap.
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

  /** Filled only in the hermes branch — persisted best-effort after the answer is delivered (M6). */
  let persistSessionRef: (() => Promise<void>) | null = null;
  try {
    if (dispatchKind === "hermes") {
      const { response, session } = await hermesAdapter!.execute({
        sessionKey,
        prompt,
        instructions: npcConfig.instructions,
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
        instructions: npcConfig.instructions,
        model:
          typeof npcConfig.adapterConfig.model === "string"
            ? npcConfig.adapterConfig.model
            : undefined,
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
 * Meeting summary. Borrows one participant adapter — whatever the backend.
 *
 * It used to be tied directly to the OpenClaw gateway's chatSend, and callers wrapped it in
 * `gateway && openclawAgentId`, so Hermes meetings skipped the summary entirely.
 * The failure was quiet (empty array + null), so it only looked like the minutes had no conclusion.
 */
async function generateMeetingSummary(
  adapter: NpcAdapter,
  sessionKey: string,
  topic: string,
  transcript: string,
  participants: OutcomeParticipant[] = [],
  locale?: string | null,
): Promise<ParsedMeetingOutcome> {
  try {
    // multiParty: true — the summary must be a one-off run, not that NPC's persistent conversation session.
    // History is emptied; the transcript is already fully in the prompt.
    const { response } = await Promise.race([
      adapter.execute({
        sessionKey,
        prompt: buildMeetingSummaryPrompt(topic, transcript, participants, locale),
        multiParty: true,
        conversationHistory: [],
      }),
      new Promise<{ response: string }>((_, reject) => {
        setTimeout(() => reject(new Error("Summary timeout")), 60_000);
      }),
    ]);
    // Missing or broken JSON comes back as `failed` — an empty value isn't saved as if it succeeded.
    return parseMeetingOutcome(response || "", participants);
  } catch (err) {
    console.warn("[meeting] Summary generation failed:", err);
    return { status: "failed", keyTopics: [], conclusions: null, outcome: null };
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
  outcome?: MeetingOutcome | null;
  summaryStatus?: MeetingSummaryStatus;
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
        outcomeJson: input.outcome ? jsonForDb(input.outcome) : null,
        summaryStatus: input.summaryStatus ?? "ok",
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
  const secret =
    process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? DEV_JWT_SECRET : "");
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
        .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
        .limit(1)
    : [];

  const channelMembershipRows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);

  const access = summarizeChannelParticipationAccess({
    groupId: channel.groupId,
    isPublic: channel.isPublic ?? true,
    hasActiveGroupMembership: groupMembershipRows.length > 0,
    isChannelMember: channel.ownerId === userId || channelMembershipRows.length > 0,
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
  emitToUserFn = (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload);
  toolApprovals = createToolApprovalRegistry({
    emitToUser: (userId, event, payload) => io.to(userRoom(userId)).emit(event, payload),
    emitToMeeting: (channelId, event, payload) =>
      io.to(`meeting-${channelId}`).emit(event, payload),
    emitToRoom: (roomId, event, payload) => io.to(roomSocketRoom(roomId)).emit(event, payload),
    clientFor: (npcId) => getProfileClientForNpc(npcId),
    summarize: createApprovalSummarizer({
      run: runApprovalSummaryAsNpc,
      localeOf: (userId) => {
        // Any open tab of the approver will do — they share the locale cookie.
        for (const socketId of io.sockets.adapter.rooms.get(userRoom(userId)) ?? []) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) return socketLocale(socket);
        }
        return null;
      },
    }),
  });
  const loadMotionLayout = async (channelId: string) => {
    const [[channel], channelNpcs] = await Promise.all([
      db
        .select({
          mapData: channels.mapData,
          mapConfig: channels.mapConfig,
        })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1),
      selectChannelNpcs(channelId),
    ]);
    const layout =
      channel &&
      deriveChannelMotionLayout(
        channel,
        channelNpcs
          .filter((npc) => npc.positionX !== null && npc.positionY !== null)
          .map((npc) => ({ id: npc.id, positionX: npc.positionX!, positionY: npc.positionY! })),
      );
    if (!layout) throw new Error("Channel motion layout unavailable");
    return {
      ...layout,
      spawn: effectiveMapSpawn(channel.mapData, channel.mapConfig),
      revision: mapContentRevision(channel.mapData),
      requiresRevision: isCreativeStudioMap(channel.mapData),
    };
  };
  const selectRuntimeNpc = async (npcId: string) => {
    const npc = await selectNpcById(npcId);
    if (!npc || !npc.active || npc.positionX === null || npc.positionY === null) return npc;
    const [channel] = await db
      .select({ mapData: channels.mapData })
      .from(channels)
      .where(eq(channels.id, npc.channelId))
      .limit(1);
    if (!channel || !isCreativeStudioMap(channel.mapData)) return npc;
    const layout = await loadMotionLayout(npc.channelId);
    const home = layout.npcs.find((home) => home.id === npcId);
    return home ? { ...npc, positionX: home.x / 32 - 0.5, positionY: home.y / 32 - 0.5 } : null;
  };
  const coordination = createNpcCoordination(io, {
    getPlayer: (id) => {
      const player = players.get(id);
      return player &&
        !mapRefresh.isPaused(player.mapId) &&
        !io.sockets.sockets.get(id)?.data.mapRefreshRequired
        ? player
        : undefined;
    },
    loadChannel: loadMotionLayout,
    loadMotionConfig: async (channelId) =>
      (
        await db
          .select({ motionConfig: channels.motionConfig })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1)
      )[0]?.motionConfig,
    onSpatialArrival: (channelId, actorId, generation) =>
      spatial.arrived(channelId, actorId, generation),
    onSpatialBlocked: (channelId, actorId, reason, generation) =>
      spatial.block(channelId, actorId, reason, generation),
    onSpatialPlayerArrival: (channelId, userId, socketId) =>
      spatial.playerArrived(channelId, userId, socketId),
    onSpatialPlayerBlocked: (channelId, userId) =>
      spatial.block(channelId, userId, "participant_left"),
  });
  // Employees the server seats on its own (hiring, quick start) appear on maps already open.
  registerNpcsPlacedNotifier((channelId, npcIds) => {
    void broadcastPlacedNpcs(io, channelId, npcIds, {
      invalidate: (id) => {
        invalidateRoomRuntimesForChannel(id);
        void coordination.invalidate(id);
      },
    }).catch((err) => console.error("[roster] placement broadcast failed", { channelId, err }));
  });
  const spatial: MeetingSpatialCoordinator = createMeetingSpatialCoordinator({
    ...coordination.spatial,
    publish: (state) => io.to(`meeting-${state.channelId}`).emit("meeting:spatial-state", state),
  });

  const mapRefresh = createChannelMapRefresh({
    pause: async (id) => {
      io.to(id).emit("map:refresh", { channelId: id, protocolVersion: 1, phase: "begin" });
    },
    reset: async (id) => {
      // Gathering, seating, return and subscriptions from the previous map are re-approved on the new map.
      spatial.reset(id);
      activeBrokers.get(id)?.stop();
      activeBrokers.delete(id);
      discussionInitiators.delete(id);
      meetingRooms.get(id)?.participants.clear();
      io.in(`meeting-${id}`).socketsLeave(`meeting-${id}`);
      await coordination.reset(id);
      playerResumeStates.clearChannel(id);
      for (const [socketId, player] of players)
        if (player.mapId === id) {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) socket.data.mapRefreshRequired = true;
          players.delete(socketId);
        }
    },
    ready: (id) => {
      io.to(id).emit("map:refresh", { channelId: id, protocolVersion: 1, phase: "ready" });
    },
  });
  const refreshChannelMap = async (
    action: "begin" | "finish",
    channelId: string,
    lease?: string,
  ) => {
    if (action === "begin") return mapRefresh.begin(channelId);
    await mapRefresh.finish(channelId, lease ?? "");
    return null;
  };
  registerMapRefreshHandler(refreshChannelMap);

  // How the minutes' "요약 다시 시도" (retry summary) route reaches the adapter (`meeting-registry.ts`).
  registerMeetingHooks({
    resummarize: createResummarizer({
      getNpcConfigsForChannel,
      resolveAdapter: (npc, ctx) => resolveNpcAdapter(npc, { ...ctx, adapterRegistry }),
      generateMeetingSummary,
    }),
  });

  // Automation event poller for bound channels. Chat and movement must work even if it fails to start, so failures
  // are only logged.
  void startAutomationPollers(io).catch((err: unknown) => {
    console.error("[automation-poller] failed to start:", err);
  });

  // One-time migration of employees created without a seat before this feature. Idempotent; boot continues on
  // failure.
  void import("../lib/npc-seating")
    .then(({ placeAllUnplacedNpcs }) => placeAllUnplacedNpcs())
    .then((r) => {
      if (r.channels > 0) console.log("[seating] backfill", r);
    })
    .catch((err: unknown) => console.error("[seating] backfill failed:", err));

  io.on("connection", async (socket) => {
    const user = await authenticateSocket(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }
    // Every socket of a user joins that user's room — approval cards reach all of their tabs, and a
    // reconnecting tab gets the cards still waiting on it.
    await socket.join(userRoom(user.userId));
    for (const pending of toolApprovals?.pendingFor(user.userId) ?? []) {
      socket.emit("tool-approval:request", pending);
    }

    socket.use((packet, next) => {
      const player = players.get(socket.id);
      const mapId = packet[0] === "player:join" ? packet[1]?.mapId : player?.mapId;
      if (typeof mapId === "string" && mapRefresh.isPaused(mapId)) {
        if (packet[0] === "player:join")
          socket.emit("map:refresh", { channelId: mapId, protocolVersion: 1, phase: "ready" });
        return;
      }
      if (socket.data.mapRefreshRequired && packet[0] !== "player:join") return;
      next();
    });
    coordination.register(socket);

    // ----- player:join -----
    socket.on(
      "player:join",
      async (
        data: {
          /** Optional — if sent, only checks that it's my character. Name and appearance are filled by the server. */
          characterId?: string;
          characterName?: string;
          appearance?: unknown;
          mapId: string;
          mapRevision?: string;
          x: number;
          y: number;
        } | null,
      ) => {
        // A malformed payload is answered before any query — a non-uuid id throws in PostgreSQL,
        // and a thrown async handler leaves the client waiting with no answer.
        if (!data || !isUuid(data.mapId)) {
          socket.emit("channel:access-denied", {
            channelId: typeof data?.mapId === "string" ? data.mapId : null,
            action: "player:join",
            reason: "forbidden",
            errorCode: "invalid_request_body",
          });
          return;
        }
        const mapGeneration = mapRefresh.generation(data.mapId);
        let accessResult: Awaited<ReturnType<typeof getSocketChannelParticipationAccess>>;
        try {
          accessResult = await getSocketChannelParticipationAccess(data.mapId, user.userId);
        } catch (err) {
          console.error("[player:join] channel access lookup failed:", err);
          accessResult = null;
        }
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

        // The server decides "me" — the characterId, name and appearance sent by the client aren't trusted.
        // Entering with someone else's character id would impersonate that character (history, broadcasts), so it's
        // rejected. Rejection comes before the single-session kick below, so a rejected join can't cut the same
        // user's live session. Lookup failures are also folded into rejection — throwing would leave the client
        // without a response and stall the join.
        let mine: MyCharacter | null;
        try {
          mine = await getMyCharacter(user.userId);
        } catch (err) {
          console.error("[player:join] my character lookup failed:", err);
          mine = null;
        }
        if (!mine) {
          console.warn(`[player:join] rejected join without a character from user ${user.userId}`);
          socket.emit("channel:access-denied", {
            channelId: data.mapId,
            action: "player:join",
            reason: "forbidden",
            errorCode: "character_missing",
          });
          return;
        }
        if (data.characterId && !isMyCharacter(mine, data.characterId)) {
          console.warn(`[player:join] rejected character claim from user ${user.userId}`);
          socket.emit("channel:access-denied", {
            channelId: data.mapId,
            action: "player:join",
            reason: "forbidden",
            errorCode: "character_not_yours",
          });
          return;
        }
        socket.data.myCharacterId = mine.id;
        socket.data.userContext = { name: mine.name, bio: mine.bio };

        // Enforce single session per user — disconnect any prior session(s)
        // for this account now that the join is authorized and proceeding.
        const priorSocketIds = getSocketIdsToKick(getSocketIdsForUser(user.userId), socket.id);
        for (const prevSocketId of priorSocketIds) {
          const prevSocket = io.sockets.sockets.get(prevSocketId);
          if (prevSocket) {
            prevSocket.emit("session:kicked", {
              reason: "errors.sessionKickedElsewhere",
            });
            prevSocket.disconnect(true);
          }
          players.delete(prevSocketId);
        }

        if (!socket.connected || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
        const previousChannel = players.get(socket.id)?.mapId;
        if (previousChannel && previousChannel !== data.mapId) {
          await socket.leave(previousChannel);
          socket.to(previousChannel).emit("player:left", { id: socket.id });
          await coordination.left(socket, previousChannel);
          notifyChannelActivity(io, previousChannel);
        }
        const identity = { userId: user.userId, characterId: mine.id, mapId: data.mapId };
        const resume = playerResumeStates.get(identity);
        let spawn = resume ? { x: resume.x, y: resume.y } : { x: data.x, y: data.y };
        let restored = !!resume;
        let admittedMapRevision: string;
        try {
          if (!resume) {
            const [saved] = await db
              .select({ x: channelMembers.lastX, y: channelMembers.lastY })
              .from(channelMembers)
              .where(
                and(
                  eq(channelMembers.channelId, data.mapId),
                  eq(channelMembers.userId, user.userId),
                ),
              )
              .limit(1);
            if (
              saved?.x != null &&
              saved?.y != null &&
              Number.isFinite(saved.x) &&
              Number.isFinite(saved.y)
            ) {
              spawn = { x: saved.x, y: saved.y };
              restored = true;
            }
          }
          const layout = await loadMotionLayout(data.mapId);
          if (
            mapRefresh.isPaused(data.mapId) ||
            mapRefresh.generation(data.mapId) !== mapGeneration
          ) {
            socket.emit("map:refresh", {
              channelId: data.mapId,
              protocolVersion: 1,
              phase: "ready",
            });
            return;
          }
          const missingRevision =
            typeof data.mapRevision !== "string" || data.mapRevision.length === 0;
          if ((layout.requiresRevision || socket.data.mapRefreshRequired) && missingRevision) {
            // Old bundles understand join-error but not map:refresh. They must
            // bootstrap through a fresh channel GET before regaining authority.
            socket.emit("join-error");
            socket.disconnect(true);
            return;
          }
          if (!missingRevision && data.mapRevision !== layout.revision) {
            socket.emit("map:refresh", {
              channelId: data.mapId,
              protocolVersion: 1,
              phase: "ready",
            });
            return;
          }
          if (!restored && layout.spawn)
            spawn = { x: (layout.spawn.col + 0.5) * 32, y: (layout.spawn.row + 0.5) * 32 };
          const liveActors = await coordination.occupancy(data.mapId, socket.id);
          // No await between final allocation and players.set: concurrent joins see this slot.
          const occupied = Array.from(players.values()).filter(
            (player) => player.mapId === data.mapId && player.id !== socket.id,
          );
          const candidate = closestValidUnoccupiedSpawn({ ...layout, npcs: [] }, spawn, [
            ...occupied,
            ...liveActors,
          ]);
          if (
            mapRefresh.isPaused(data.mapId) ||
            mapRefresh.generation(data.mapId) !== mapGeneration
          ) {
            socket.emit("map:refresh", {
              channelId: data.mapId,
              protocolVersion: 1,
              phase: "ready",
            });
            return;
          }
          if (!candidate || !socket.connected) {
            socket.emit("join-error");
            return;
          }
          spawn = candidate;
          admittedMapRevision = layout.revision;
        } catch {
          socket.emit("join-error");
          return;
        }
        socket.data.mapRefreshRequired = false;
        socket.data.mapRevision = admittedMapRevision;
        const playerState: PlayerState = {
          id: socket.id,
          userId: user.userId,
          characterId: mine.id,
          characterName: mine.name,
          appearance: normalizeOfficeAppearance(mine.appearance),
          mapId: data.mapId,
          x: spawn.x,
          y: spawn.y,
          direction: resume?.direction ?? "down",
          animation: resume?.motion ? resume.animation : "idle",
          motion: resume?.motion ?? null,
        };

        players.set(socket.id, playerState);
        playerResumeStates.save(playerState);
        const admissionCurrent = () =>
          players.get(socket.id) === playerState &&
          socket.connected &&
          !socket.data.mapRefreshRequired &&
          !mapRefresh.isPaused(data.mapId) &&
          mapRefresh.generation(data.mapId) === mapGeneration;
        await socket.join(data.mapId);
        if (!admissionCurrent()) return;
        socket.emit("player:spawn", {
          ...spawn,
          direction: playerState.direction,
          animation: playerState.animation,
          restored,
          motion: playerState.motion,
        });
        await coordination.joined(socket, data.mapId);
        if (!admissionCurrent()) return;

        // Send the current automation map state to this socket only, once (R27). Only working NPCs are included —
        // the client default is working:false. Later changes arrive via channel broadcast.
        for (const snapshot of getWorkingSnapshot(data.mapId)) {
          socket.emit(AUTOMATION_SOCKET_EVENTS.working, snapshot);
        }
        // Whether the gateway answered the poller's last tick — absent until the first tick after a restart.
        const health = getGatewayHealth(data.mapId);
        if (health) socket.emit(GATEWAY_HEALTH_EVENT, health);
        notifyChannelActivity(io, data.mapId);

        // Send current players on this map to the joining player
        const mapPlayers = Array.from(players.values()).filter(
          (p) => p.mapId === data.mapId && p.id !== socket.id,
        );
        socket.emit("players:state", { players: mapPlayers });

        // The server doesn't push the room list — the client calls room:list right after join.
        // Which room to open is decided by the client's last-room memory, so if the server pushed first
        // it would arrive ahead of that decision and the screen would change twice.

        // Broadcast to others in the same map
        socket.to(data.mapId).emit("player:joined", playerState);
      },
    );

    // ----- player:move -----
    socket.on(
      "player:move",
      (data: { x: number; y: number; direction: string; animation: string; motion?: unknown }) => {
        const player = players.get(socket.id);
        if (!player) return;

        if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
        void coordination.moved(socket, data.x, data.y);
        player.x = data.x;
        player.y = data.y;
        player.direction = data.direction;
        player.animation = data.animation;
        player.motion = readPlayerDestination(data.motion);
        playerResumeStates.save(player);

        socket.to(player.mapId).emit("player:moved", {
          id: socket.id,
          x: data.x,
          y: data.y,
          direction: data.direction,
          animation: data.animation,
        });
      },
    );

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

    socket.on("map:layout-saved", async () => {
      const player = players.get(socket.id);
      if (!player || !(await isChannelOwner(player.mapId, user.userId))) return;
      await coordination.invalidate(player.mapId);
    });

    // ----- npc:chat -----
    socket.on(
      "npc:chat",
      async (data: {
        npcId: string;
        message: string;
        characterId?: string;
        sourceMessageId?: string;
        files?: Array<{ name: string; type: string; size: number; data: ArrayBuffer }>;
      }) => {
        const { npcId, message, files } = data;
        chatLog(
          `← user msg to ${npcId}:`,
          message?.slice(0, 100),
          files
            ? `+${files.length} files [${files.map((f) => `${f.name}(${(f.size / 1024).toFixed(0)}KB)`).join(", ")}]`
            : "",
        );

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
        const npcConfig = await getNpcConfig(npcId, socketLocale(socket));
        if (!npcConfig) {
          emitNpcSystemResponse(socket, npcId, "npc_not_found");
          return;
        }

        const access = await getSocketChannelParticipationAccess(npcConfig._channelId, user.userId);
        const historyCharacterId = await resolveHistoryCharacterId(
          socket,
          user.userId,
          data.characterId,
        );
        if (!access?.access.allowed || !historyCharacterId) {
          emitNpcSystemResponse(socket, npcId, "npc_not_found");
          return;
        }
        const sourceMessageId =
          typeof data.sourceMessageId === "string" && data.sourceMessageId.length <= 100
            ? data.sourceMessageId
            : crypto.randomUUID();
        const requestId = crypto.randomUUID();
        const scope = dmResponseScope(user.userId, historyCharacterId, npcId);
        const queueKey = `${user.userId}:${npcId}`;
        try {
          if (dmResetting.has(queueKey) || dmResponseQueue.isFull(queueKey)) {
            emitNpcSystemResponse(socket, npcId, "wait_before_sending");
            return;
          }
          const tracker = getDmResponseTracker(io, scope);
          await socket.join(scope);
          await runTrackedDm({
            tracker,
            queue: dmResponseQueue,
            queueKey,
            identity: { requestId, sourceMessageId, npcId, npcName: npcConfig._name || npcId },
            prepare: () =>
              appendNpcHistoryMessage(historyCharacterId, npcId, trimmed, "player", {
                id: sourceMessageId,
              }),
            work: async (capture, isActive, signal) => {
              const responseSocket = new Proxy(socket, {
                get(target, property) {
                  if (property === "emit")
                    return (event: string, payload: Record<string, unknown>) => {
                      if (!isActive()) return target;
                      capture(event, payload);
                      target.emit(
                        event,
                        event === "npc:response" || event === "npc:activity"
                          ? { ...payload, responseRequestId: requestId }
                          : payload,
                      );
                      return target;
                    };
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
              // --- File processing (text-based files only) ---
              let extractedFiles: ExtractedFile[] = [];
              let fileAttachments: GatewayAttachment[] | undefined;

              if (files && files.length > 0) {
                if (files.length > FILE_LIMITS.maxFileCount) {
                  emitNpcSystemResponse(responseSocket, npcId, "too_many_files");
                  return;
                }
                for (const f of files) {
                  if (f.size > FILE_LIMITS.maxFileSize) {
                    emitNpcSystemResponse(responseSocket, npcId, "file_too_large");
                    return;
                  }
                  if (!isAllowedFileType(f.name, f.type)) {
                    emitNpcSystemResponse(responseSocket, npcId, "unsupported_file_type");
                    return;
                  }
                }
                extractedFiles = await Promise.all(
                  files.map((f) =>
                    extractFileContent(Buffer.from(f.data), f.name, f.type, socketLocale(socket)),
                  ),
                );
                fileAttachments = buildAttachments(extractedFiles);
                chatLog(
                  "  extracted:",
                  extractedFiles
                    .map(
                      (f) =>
                        `${f.name}(text=${f.textContent?.length ?? 0}, img=${f.imageBase64 ? (f.imageBase64.length / 1024).toFixed(0) + "KB" : "-"}, trunc=${f.truncated})`,
                    )
                    .join(", "),
                );
              }

              const fileSection = buildFilePromptSection(extractedFiles, socketLocale(socket));
              if (!isActive()) return;
              const messageToSend = trimmed + fileSection;

              // Stream response via OpenClaw
              chatLog(
                `  → gateway (${npcConfig._name}): msgLen=${messageToSend.length}(${(messageToSend.length / 1024).toFixed(0)}KB)`,
                fileAttachments
                  ? `+${fileAttachments.length} att(${fileAttachments.map((a) => `${a.fileName}:${(a.content.length / 1024).toFixed(0)}KB`).join(",")})`
                  : "",
              );
              const response = await streamNpcResponse(
                responseSocket,
                npcId,
                npcConfig,
                user.userId,
                messageToSend,
                fileAttachments,
                undefined,
                undefined,
                signal,
              );
              if (!isActive()) return;
              chatLog(
                `  ← npc response (${npcConfig._name}):`,
                response
                  ? response.slice(0, 150) + (response.length > 150 ? "..." : "")
                  : "(empty)",
              );
              if (response) {
                if (historyCharacterId) {
                  await appendNpcHistoryMessage(historyCharacterId, npcId, response, "npc", {
                    id: requestId,
                    responseRequestId: requestId,
                  });
                }
                responseSocket.emit("npc:response-complete", {
                  npcId,
                  npcName: npcConfig._name || npcId,
                });
              }
              return (response || "").trim();
            },
          });
        } catch (error) {
          console.error("[dm-response] unable to admit request", error);
          emitNpcSystemResponse(socket, npcId, gatewayFailureMessageCode(error));
        }
      },
    );

    // The owner of the history is my character as decided by the server in player:join. The characterId sent by the
    // client is ignored — before join (no socket.data.myCharacterId) it answers with empty history.
    socket.on("npc:history", async ({ npcId }: { npcId: string }) => {
      if (!npcId) return;
      const characterId = myCharacterIdOf(socket);
      if (!characterId) {
        socket.emit("npc:history", { npcId, messages: [] });
        return;
      }

      const historyKey = npcHistoryKey(characterId, npcId);
      let history = npcChatHistory.get(historyKey);
      if (!history) {
        // Cache miss — this is right after a restart. The DB is the source of truth, so fill from there.
        try {
          history = await loadNpcChatHistory(db, { chatMessages }, { characterId, npcId });
          npcChatHistory.set(historyKey, history);
        } catch (err) {
          console.error("[chat-history] failed to load history", { characterId, npcId }, err);
          history = [];
        }
      }
      const scope = dmResponseScope(user.userId, characterId, npcId);
      await socket.join(scope);
      socket.emit("npc:history", { npcId, messages: history });
      socket.emit("npc:response-snapshot", {
        npcId,
        responses: dmResponseTrackers.get(scope)?.snapshot() ?? [],
      });
    });

    // DM rows for the conversation list. Returns only one last-utterance line per employee — that's all
    // the list needs to draw, and name/on-duty status are attached from the roster the client already knows.
    // Ownership follows the same rule as history: before join, the list is empty.
    socket.on("npc:dm-threads", async () => {
      const characterId = myCharacterIdOf(socket);
      if (!characterId) {
        socket.emit("npc:dm-threads", { threads: [] });
        return;
      }
      try {
        const threads = await loadDmThreads(db, { chatMessages }, { characterId });
        // The list is still worth drawing without badges if the read state can't be read.
        const withReads = await attachDmReads(user.userId, characterId, threads).catch((err) => {
          console.error("[reads] failed to attach dm read state", { characterId }, err);
          return threads;
        });
        socket.emit("npc:dm-threads", { threads: withReads });
      } catch (err) {
        // Failing to draw the list doesn't mean the conversation is gone — don't skip silently; record it.
        console.error("[chat-history] failed to load dm threads", { characterId }, err);
        socket.emit("npc:dm-threads", { threads: [] });
      }
    });

    // The stop button. The tracker lives under the requester's own scope (user + character + NPC),
    // so reaching it at all proves ownership; cancelling aborts the adapter, which stops the run.
    socket.on("npc:cancel-response", async (payload: unknown) => {
      const { npcId, requestId, characterId } = (payload ?? {}) as Record<string, unknown>;
      if (typeof npcId !== "string" || typeof requestId !== "string") return;
      const historyCharacterId = await resolveHistoryCharacterId(
        socket,
        user.userId,
        typeof characterId === "string" ? characterId : null,
      );
      if (!historyCharacterId) return;
      const tracker = dmResponseTrackers.get(
        dmResponseScope(user.userId, historyCharacterId, npcId),
      );
      if (!tracker?.isActive(requestId)) return;
      tracker.update(requestId, { status: "cancelled" });
    });

    // "I have seen this room / DM up to here." Only the viewer's own row moves, and only forward;
    // the viewer's other tabs hear the new point so their badges clear too.
    socket.on("conversation:read", async (payload: unknown) => {
      const mark = parseReadMark(payload);
      if (!mark) return;
      try {
        const readAt = await markConversationRead({
          userId: user.userId,
          kind: mark.kind,
          targetId: mark.id,
          at: mark.at,
        });
        io.to(userRoom(user.userId)).emit(CONVERSATION_READ_EVENT, {
          kind: mark.kind,
          id: mark.id,
          readAt,
        });
      } catch (err) {
        console.error("[reads] failed to mark read", { userId: user.userId, kind: mark.kind }, err);
      }
    });

    socket.on("npc:reset-chat", async ({ npcId }: { npcId: string }) => {
      if (!npcId) return;
      const characterId = myCharacterIdOf(socket);
      if (!characterId) return;

      const scope = dmResponseScope(user.userId, characterId, npcId);
      const queueKey = `${user.userId}:${npcId}`;
      dmResetting.add(queueKey);
      try {
        dmResponseTrackers.get(scope)?.cancelAll();
        await dmResponseQueue.idle(queueKey);
        dmResponseTrackers.delete(scope);
        npcChatHistory.delete(npcHistoryKey(characterId, npcId));
        await clearNpcChatHistory(db, { chatMessages }, { characterId, npcId });
        socket.emit("npc:response-snapshot", { npcId, responses: [] });
      } catch (err) {
        console.error("[chat-history] failed to clear history", { characterId, npcId }, err);
      } finally {
        dmResetting.delete(queueKey);
      }
    });

    // NPC movement and seat ownership use the compatible channel coordinator above.

    // NPC management broadcasts (re-broadcast to room)
    //
    // All three branches drop that channel's room runtime cache. The runtime keeps holding the participant
    // list from when it was created, so without dropping it **a fired NPC keeps answering and a newly arrived NPC
    // doesn't come when called.** The next mention rereads the DB and builds a new one.
    socket.on("npc:broadcast-add", (npcData: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      invalidateRoomRuntimesForChannel(player.mapId);
      void coordination.invalidate(player.mapId);
      socket.to(player.mapId).emit("npc:added", npcData);
    });

    socket.on("npc:broadcast-update", (data: unknown) => {
      void broadcastNpcUpdate(socket, data, {
        getPlayer: () => players.get(socket.id),
        admittedRevision: () => socket.data.mapRevision,
        generation: mapRefresh.generation,
        isPaused: mapRefresh.isPaused,
        requiresRefresh: () => !!socket.data.mapRefreshRequired,
        selectNpc: selectRuntimeNpc,
        readRevision: async (id) => {
          const [row] = await db
            .select({ mapData: channels.mapData })
            .from(channels)
            .where(eq(channels.id, id))
            .limit(1);
          return row ? mapContentRevision(row.mapData) : null;
        },
        invalidate: coordination.invalidate,
        invalidateRooms: (id) => invalidateRoomRuntimesForChannel(id),
      });
    });

    socket.on("npc:broadcast-remove", (data: unknown) => {
      const player = players.get(socket.id);
      if (!player) return;
      invalidateRoomRuntimesForChannel(player.mapId);
      void coordination.invalidate(player.mapId);
      socket.to(player.mapId).emit("npc:removed", data);
    });

    registerMeetingSocketHandlers({
      io,
      socket,
      deps: {
        meetingRooms,
        spatial,
        isInMeetingSpace: (channelId, socketId) =>
          coordination.spatial.isInside(channelId, socketId),
        getDiscussionState: (channelId) => activeBrokers.get(channelId)?.discussionState ?? null,
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
          const npcConfigs = await getNpcConfigsForChannel(channelId, socketLocale(socket));
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
                    userContextOf(socket),
                    // Same language the protocol above was resolved in.
                    socketLocale(socket),
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

    registerNpcRosterHandlers({
      io,
      socket,
      deps: {
        activeBrokers,
        user,
        isChannelOwner,
        selectNpcById: selectRuntimeNpc,
        setNpcActive: async (npcId, active) => {
          await setNpcActive(npcId, active);
          const npc = await selectNpcById(npcId);
          if (npc) await coordination.invalidate(npc.channelId);
        },
      },
    });

    // Room chat. The registration strings (`socket.on("room:*")`) live in room-socket.ts, and
    // socket-event-parity.test.ts looks at the union of the three files — listing the names here again
    // would create two registration sites and drift where only one gets fixed.
    registerRoomHandlers({
      io,
      socket,
      deps: {
        user,
        players,
        lastChatTime,
        cooldownMs: CHAT_COOLDOWN_MS,
        getParticipationAccess: getSocketChannelParticipationAccess,
        rooms: chatRooms,
        attachReads: attachRoomReads,
        // Room runtimes are cached per room — the protocol language belongs to whoever first created the runtime.
        getRuntime: (io, room, userId) =>
          getOrCreateRoomRuntime(io, room, userId, { locale: socketLocale(socket) }),
        invalidateRuntime: invalidateRoomRuntime,
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
        // The meeting speaks the language of whoever opened it: turn prompts, minutes and summary.
        locale: socketLocale(socket),
        // Carry the protocol in the UI language of whoever opened the meeting.
        getNpcConfigsForChannel: (channelId: string) =>
          getNpcConfigsForChannel(channelId, socketLocale(socket)),
        // Minutes are written in the channel's Hermes timezone (cached plugin info, no request).
        resolveTimeZone: getChannelTimeZone,
        canControlMeeting: async (channelId, userId) => {
          const access = await getSocketChannelParticipationAccess(channelId, userId);
          return (
            !!access?.access.allowed &&
            (spatial.snapshot(channelId)?.phase !== "idle" && spatial.snapshot(channelId)
              ? spatial.owner(channelId) === userId || (await isChannelOwner(channelId, userId))
              : await canControlMeeting(channelId, userId))
          );
        },
        spatial,
        announceOutcome: announceMeetingOutcome,
        // The meeting's opener answers its NPCs' tool approvals; the others only see "waiting".
        wrapParticipantAdapter: (channelId, npcId, adapter) =>
          routeToolApprovals(adapter, {
            npcId,
            channelId,
            context: "meeting",
            approver: () => {
              const approverId = discussionInitiators.get(channelId);
              return approverId ? { userId: approverId, name: playerNameOf(approverId) } : null;
            },
          }),
        canStartMeeting: async (channelId, userId) => {
          const access = await getSocketChannelParticipationAccess(channelId, userId);
          return (
            !!access?.access.allowed &&
            !!meetingRooms.get(channelId)?.participants.has(socket.id) &&
            players.get(socket.id)?.mapId === channelId
          );
        },
        generateMeetingSummary,
        persistMeetingMinutes,
      },
    });

    // ----- disconnect -----
    // ----- tool-approval:decide ----- only the approver may answer; the registry checks it.
    socket.on("tool-approval:decide", async (data: unknown, ack?: unknown) => {
      const { key, choice } = (data ?? {}) as { key?: unknown; choice?: unknown };
      const result = toolApprovals
        ? await toolApprovals.decide(user.userId, key, choice)
        : ("closed" as const);
      if (typeof ack === "function") ack({ result });
    });

    // ----- npc:answer ----- only the user the question was put to may answer; npc-questions checks it.
    socket.on("npc:answer", async (data: unknown, ack?: unknown) => {
      const { npcId, questionId, response } = (data ?? {}) as Record<string, unknown>;
      const valid =
        typeof npcId === "string" && typeof questionId === "string" && typeof response === "string";
      const result = valid
        ? await answerNpcQuestion({ userId: user.userId, npcId, questionId, response }).catch(
            () => "failed" as const,
          )
        : ("invalid" as const);
      if (result === "answered")
        io.to(userRoom(user.userId)).emit(NPC_QUESTION_EVENTS.answered, {
          npcId,
          questionId,
          response,
        });
      if (typeof ack === "function") ack({ result });
    });

    socket.on("disconnect", () => {
      const player = players.get(socket.id);
      if (player) {
        playerResumeStates.save(player);
        socket.to(player.mapId).emit("player:left", { id: socket.id });

        // Save last position to DB
        const px = Math.round(player.x);
        const py = Math.round(player.y);
        void (async () => {
          await db
            .update(channelMembers)
            .set({ lastX: px, lastY: py })
            .where(
              and(
                eq(channelMembers.channelId, player.mapId),
                eq(channelMembers.userId, player.userId),
              ),
            );
        })().catch((error: unknown) => {
          console.error(
            "[socket] Position save failed:",
            error instanceof Error ? error.message : "unknown",
          );
        });

        players.delete(socket.id);
        notifyChannelActivity(io, player.mapId);
      }

      // Clean up meeting room participation
      for (const [channelId, room] of meetingRooms.entries()) {
        if (room.participants.has(socket.id)) {
          room.participants.delete(socket.id);
          void spatial.leavePlayer(channelId, user.userId, socket.id);
          socket.to(`meeting-${channelId}`).emit("meeting:participant-left", { id: socket.id });
        }
      }

      for (const channelId of [...activeBrokers.keys()]) {
        const room = meetingRooms.get(channelId);
        if (room && room.participants.size === 0) {
          settleMeeting({ activeBrokers, discussionInitiators, spatial }, channelId, {
            stopBroker: true,
            context: "host left",
          });
        }
      }

      lastChatTime.delete(socket.id);
    });
  });
  return { refreshChannelMap };
}
