// Free-chat runtime for a single room. Moves the former `createOpenChat` (one per channel) to room scope.
//
// With one per channel, there was only one participant set: "every on-duty NPC in this channel". With rooms
// it splits in two — the office room is still the whole channel, and a group room is only that room's NPC members.
// The session scope must also split per room (`room-<id>`): if the same NPC used the same session in two rooms,
// one room's conversation would leak into the other room's prompt.

import { ChatResponseTracker } from "./chat-response-tracker";
import type { Server } from "socket.io";
import { OpenChatRuntime } from "@/lib/conversation/open-chat-runtime";
import type { OpenChatCallbacks, OpenChatDeps } from "@/lib/conversation/open-chat-runtime";
import type { EngineParticipant } from "@/lib/conversation/types";
import type { ChatLine } from "@/lib/open-chat-formatter";
import type { UserContext } from "@/lib/user-context";
import { decideResponders } from "@/lib/chat-rooms-policy";
import {
  appendRoomMessage,
  recentRoomMessages,
  roomNpcMemberIds,
  roomUserMemberIds,
} from "@/lib/chat-rooms";
import type { RoomRow } from "@/lib/chat-rooms";
import { resolveNpcAdapter } from "./meeting-discussion";
import { broadcastRoomActivity, broadcastRoomMessage } from "./room-broadcast";
import { getOrCreateCached } from "./promise-cache";
import {
  adapterRegistry,
  getNpcConfigsForChannel,
  playerNameOf,
  routeToolApprovals,
} from "./socket-handlers";

/** Number of recent conversation lines to put in the prompt. Same as the old channel history's `slice(-10)`. */
const RECENT_LIMIT = 10;

/**
 * `OpenChatDeps.recent()` is **synchronous**. Messages now live in the DB rather than an in-memory array, so
 * the last few lines are read at creation time and then kept current by pushing in each message as it flows.
 *
 * Dedup is by **message id**. Deduping by content would silently drop from the prompt the second "yes" from someone
 * who sent it twice 3 seconds apart — the cooldown is only 2 seconds, so that is a legitimate repeat.
 */
type RecentEntry = { id: string; sender: string; content: string };

class RecentCache {
  private entries: RecentEntry[] = [];

  seed(entries: RecentEntry[]) {
    this.entries = entries.slice(-RECENT_LIMIT);
  }

  push(id: string, sender: string, content: string) {
    if (this.entries.some((e) => e.id === id)) return;
    this.entries.push({ id, sender, content });
    if (this.entries.length > RECENT_LIMIT) this.entries = this.entries.slice(-RECENT_LIMIT);
  }

  readThrough(sourceMessageId: string): ChatLine[] {
    const end = this.entries.findIndex((entry) => entry.id === sourceMessageId);
    const entries = end < 0 ? this.entries : this.entries.slice(0, end + 1);
    return entries.slice(-RECENT_LIMIT).map(({ sender, content }) => ({ sender, content }));
  }

  read(): ChatLine[] {
    return this.entries.map(({ sender, content }) => ({ sender, content }));
  }
}

/**
 * Recent DB lines in a shape the cache can consume. System messages are JSON structures, so they are excluded.
 *
 * **Filter, then trim.** Reading only 10 lines and then removing system messages would shrink the conversation
 * in the transcript for rooms with frequent invites/renames. Read generously, filter, then cut the tail.
 */
async function loadRecentEntries(roomId: string): Promise<RecentEntry[]> {
  // No viewer: private notices never reach an NPC transcript.
  return (await recentRoomMessages(roomId, RECENT_LIMIT * 3, null))
    .filter((m) => m.senderKind !== "system")
    .slice(-RECENT_LIMIT)
    .map((m) => ({ id: m.id, sender: m.senderName, content: m.content }));
}

/** Saved human source IDs enter the cache synchronously before queue admission.
 * Each request snapshots history through its own source, so later calls cannot rewrite its prompt.
 */
class RoomChatRuntime extends OpenChatRuntime {
  private readonly recent: RecentCache;
  private readonly roomId: string;

  constructor(
    recent: RecentCache,
    roomId: string,
    deps: OpenChatDeps,
    callbacks: OpenChatCallbacks,
  ) {
    super(deps, callbacks);
    this.recent = recent;
    this.roomId = roomId;
  }

  override async handleHumanMessage(
    senderName: string,
    text: string,
    callerSocketId: string | null = null,
    sourceMessageId?: string,
    callerContext: UserContext | null = null,
    callerLocale?: string | null,
    callerUserId: string | null = null,
  ): Promise<void> {
    if (sourceMessageId) {
      // Admission must stay synchronous: an awaited refresh lets a later send overtake this one.
      this.recent.push(sourceMessageId, senderName, text);
    } else {
      // Compatibility for callers predating source IDs; production room:send always supplies one.
      this.recent.seed(await loadRecentEntries(this.roomId));
    }
    await super.handleHumanMessage(
      senderName,
      text,
      callerSocketId,
      sourceMessageId,
      callerContext,
      callerLocale,
      callerUserId,
    );
  }
}

/**
 * Per-room runtime. The value is a **promise** rather than a runtime for the same reason as the channel version — if
 * a second mention arriving during creation's two DB round trips created a second instance, the speaking guard and
 * the budget, both per instance, would be defeated at once.
 */
const roomRuntimes = new Map<string, Promise<OpenChatRuntime | null>>();
/** roomId → channelId. Channel-level invalidation (hiring/firing NPCs) must know which rooms to drop. */
const roomChannels = new Map<string, string>();
const roomGenerations = new Map<string, symbol>();
const responseTrackers = new Map<string, ChatResponseTracker>();

/** roomId → stops one reply of that room's live runtime, if the given user asked for it. */
const roomCancelers = new Map<string, (requestId: string, userId: string) => boolean>();

/**
 * The stop button in a room. Only the human whose message started the turn — kept through
 * chained NPC turns — may stop it. False when that is someone else or the reply already ended.
 */
export function cancelRoomResponse(roomId: string, requestId: string, userId: string): boolean {
  return roomCancelers.get(roomId)?.(requestId, userId) ?? false;
}

export function getRoomResponseSnapshot(roomId: string) {
  return responseTrackers.get(roomId)?.snapshot() ?? [];
}

/**
 * Injection point for adapter resolution and NPC roster lookup. The defaults are the real wiring — this lets tests
 * observe this file's assembly rules (participant filtering, policy wiring, cache, callbacks) without a gateway or CLI.
 */
export type RoomRuntimeDeps = {
  getNpcConfigs?: typeof getNpcConfigsForChannel;
  resolveAdapter?: typeof resolveNpcAdapter;
  /** Display language of the user who created the runtime. Sets the response language of the NPC protocol. */
  locale?: string | null;
  /** Live tool approvals — wraps each participant adapter. Defaults to the socket server's registry. */
  routeApprovals?: typeof routeToolApprovals;
  /** A user's display name for "waiting for <name>'s approval". */
  nameOf?: (userId: string) => string;
};

export function getOrCreateRoomRuntime(
  io: Server,
  room: RoomRow,
  callerUserId: string,
  deps: RoomRuntimeDeps = {},
): Promise<OpenChatRuntime | null> {
  const existing = roomRuntimes.get(room.id);
  if (existing) return existing;
  const generation = Symbol(room.id);
  roomGenerations.set(room.id, generation);
  roomChannels.set(room.id, room.channelId);
  return getOrCreateCached(roomRuntimes, room.id, () =>
    createRoomRuntime(io, room, callerUserId, deps, generation),
  );
}

/** Call when members change or the room disappears. The next mention re-reads the DB and builds anew. */
export function invalidateRoomRuntime(roomId: string): void {
  roomGenerations.delete(roomId);
  const pending = roomRuntimes.get(roomId);
  responseTrackers.get(roomId)?.cancelAll();
  responseTrackers.delete(roomId);
  roomRuntimes.delete(roomId);
  roomChannels.delete(roomId);
  void pending?.then((runtime) => runtime?.dispose()).catch(() => {});
}

/**
 * The channel's NPC roster changed (hire/edit/fire) — drop every room runtime of that channel.
 * The office room takes the whole channel as participants, and a group room may still hold a fired NPC as a member,
 * so dropping only one room would leave the rest calling ghost NPCs.
 */
export function invalidateRoomRuntimesForChannel(channelId: string): void {
  for (const [roomId, id] of roomChannels) {
    if (id === channelId) invalidateRoomRuntime(roomId);
  }
}

async function createRoomRuntime(
  io: Server,
  room: RoomRow,
  callerUserId: string,
  deps: RoomRuntimeDeps,
  generation: symbol,
): Promise<OpenChatRuntime | null> {
  const loadNpcConfigs = deps.getNpcConfigs ?? getNpcConfigsForChannel;
  const resolveAdapter = deps.resolveAdapter ?? resolveNpcAdapter;
  const npcConfigs = await loadNpcConfigs(room.channelId, deps.locale);
  // Office room: every on-duty NPC in the channel; group room: only invited NPCs.
  const allowed = room.kind === "group" ? new Set(await roomNpcMemberIds(room.id)) : null;
  const candidates = allowed ? npcConfigs.filter((npc) => allowed.has(npc.id)) : npcConfigs;

  const routeApprovals = deps.routeApprovals ?? routeToolApprovals;
  const nameOf = deps.nameOf ?? playerNameOf;
  // npcId → the user whose turn that NPC is answering right now. A room NPC speaks one turn at a time (the runtime
  // queues per NPC), so the request that arrives mid-turn belongs to that turn's caller — through chained NPC turns
  // too, since the original human is carried along. Without one, the room's creator (the channel owner for the
  // office room) is asked.
  const turnCallers = new Map<string, string>();

  const participants: EngineParticipant[] = [];
  for (const npc of candidates) {
    const resolved = await resolveAdapter(npc, {
      sessionScope: `room-${room.id}`,
      userId: callerUserId,
      adapterRegistry,
    });
    if ("excluded" in resolved) continue;
    participants.push({
      npcId: resolved.participant.npcId,
      displayName: resolved.participant.displayName,
      seated: true,
      turnCount: 0,
      lastSpokeAt: 0,
      adapter: routeApprovals(resolved.adapter, {
        npcId: resolved.participant.npcId,
        channelId: room.channelId,
        context: "room",
        roomId: room.id,
        approver: () => {
          const userId = turnCallers.get(resolved.participant.npcId) ?? room.createdBy;
          return userId ? { userId, name: nameOf(userId) } : null;
        },
      }),
      sessionKey: resolved.sessionKey,
      role: resolved.participant.role,
      passPolicy: resolved.participant.passPolicy,
      instructions: resolved.participant.instructions ?? null,
    });
  }
  if (participants.length === 0) return null;

  const recent = new RecentCache();
  recent.seed(await loadRecentEntries(room.id));

  if (roomGenerations.get(room.id) !== generation) return null;

  const memberNpcIds = participants.map((p) => p.npcId);
  const socketRoom = `room-${room.id}`;
  const tracker = new ChatResponseTracker((response) => {
    io.to(socketRoom).emit("room:response-state", { roomId: room.id, response });
  });
  responseTrackers.set(room.id, tracker);
  const buffers = new Map<string, string>();
  // requestId → the human whose message started that turn; the only one who may stop it.
  const requestCallers = new Map<string, string>();
  let disposed = false;

  const runtime = new RoomChatRuntime(
    recent,
    room.id,
    {
      participants,
      recent: () => recent.read(),
      recentForSource: (sourceMessageId) => recent.readThrough(sourceMessageId),
      turnTimeout: { idleMs: 180_000, maxMs: 600_000 },
      // Office (mention) answers only when mentioned; group (members) has every member answer when there is no mention.
      selectResponders: (mentioned) => decideResponders(room.replyPolicy, mentioned, memberNpcIds),
    },
    {
      onTurnQueued: (npcId, npcName, context) => {
        if (context.callerUserId) requestCallers.set(context.requestId, context.callerUserId);
        tracker.accept({ ...context, npcId, npcName });
      },
      onDisposed: () => {
        disposed = true;
        if (roomCancelers.get(room.id) === cancel) roomCancelers.delete(room.id);
        tracker.cancelAll();
        buffers.clear();
        requestCallers.clear();
      },
      onTurnCancelled: (npcId, context) => {
        buffers.delete(context.requestId);
        requestCallers.delete(context.requestId);
        turnCallers.delete(npcId);
        tracker.update(context.requestId, { status: "cancelled" });
      },
      onQueueFull: (npcId) => {
        io.to(socketRoom).emit("room:npc-aborted", {
          roomId: room.id,
          npcId,
          npcName: participants.find((p) => p.npcId === npcId)?.displayName ?? npcId,
          reason: "queue_full",
        });
      },
      onTurnChunk: (_npcId, chunk, context) => {
        if (!tracker.isActive(context.requestId)) return;
        const content = (buffers.get(context.requestId) ?? "") + chunk;
        buffers.set(context.requestId, content);
        tracker.update(context.requestId, { status: "streaming", content });
      },
      onTurnStart: (npcId, _displayName, callerSocketId, context) => {
        if (context.callerUserId) turnCallers.set(npcId, context.callerUserId);
        else turnCallers.delete(npcId);
        tracker.update(context.requestId, { status: "thinking" });
        // Walking and speaking start together — no waiting for arrival. targetPlayerId must
        // be a real socket id for the client to run A* (if null, nobody walks).
        if (!callerSocketId) return;
        // NPC movement must be seen by the whole map, so it goes out to the channel room. roomId is included
        // so the client can tell "is this a call for the room I am viewing".
        io.to(room.channelId).emit("npc:come-to-player", {
          npcId,
          targetPlayerId: callerSocketId,
          reason: "map-chat",
          roomId: room.id,
        });
      },
      onTurnEnd: async (npcId, fullResponse, meta, context) => {
        buffers.delete(context.requestId);
        requestCallers.delete(context.requestId);
        turnCallers.delete(npcId);
        if (disposed) return;
        const npc = participants.find((x) => x.npcId === npcId);
        if (meta?.aborted || !fullResponse) {
          tracker.update(context.requestId, {
            status: "failed",
            error: meta?.reason ?? "empty_response",
          });
          io.to(socketRoom).emit("room:npc-aborted", {
            roomId: room.id,
            npcId,
            npcName: npc?.displayName || npcId,
            reason: meta?.reason || "empty_response",
          });
          return;
        }
        try {
          const message = await appendRoomMessage({
            roomId: room.id,
            senderKind: "npc",
            senderId: npcId,
            senderName: npc?.displayName || npcId,
            content: fullResponse,
          });
          if (disposed) return;
          recent.push(message.id, message.senderName, message.content);
          // Deliver the persisted ID before the DB message so the client replaces the draft.
          tracker.update(context.requestId, {
            status: "complete",
            content: fullResponse,
            messageId: message.id,
          });
          broadcastRoomMessage(io, room.id, message);
          // Members with another room open only hear about it this way. Best effort.
          if (room.kind === "group")
            void roomUserMemberIds(room.id)
              .then((userIds) => broadcastRoomActivity(io, userIds, room.id, message))
              .catch((err) => console.error("[rooms] failed to announce room activity", err));
          return message.id;
        } catch (error) {
          tracker.update(context.requestId, { status: "failed", error: "persistence_error" });
          throw error;
        }
      },
      onMentionSkipped: (npcId, reason) => {
        const npc = participants.find((x) => x.npcId === npcId);
        io.to(socketRoom).emit("room:mention-skipped", {
          roomId: room.id,
          npcId,
          npcName: npc?.displayName || npcId,
          reason,
        });
      },
      onMentionNoMatch: (callerSocketId) => {
        // A mention that matches no member — notify only the caller (not broadcast to the whole room).
        const target = callerSocketId ? io.to(callerSocketId) : io.to(socketRoom);
        target.emit("room:mention-skipped", { roomId: room.id, reason: "no_match" });
      },
      onError: (err, npcId) => {
        console.error("[room]", room.id, npcId, err);
      },
    },
  );
  // Marking the reply cancelled first answers the button at once; the runtime then drops a
  // queued turn or aborts the running one.
  const cancel = (requestId: string, userId: string): boolean => {
    if (requestCallers.get(requestId) !== userId || !tracker.isActive(requestId)) return false;
    tracker.update(requestId, { status: "cancelled" });
    runtime.cancelTurn(requestId);
    return true;
  };
  roomCancelers.set(room.id, cancel);
  return runtime;
}
