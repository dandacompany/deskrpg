import { getRoomResponseSnapshot } from "./room-runtime";
// Socket layer for per-room chat. Replaces the old `chat:*` (one channel = one conversation).
//
// Socket room names are `room-<roomId>`. The prefix keeps them from colliding with channel rooms (`<channelId>`) —
// a collision would leak room messages to everyone on the map.
//
// **Never drop silently.** A rejected `room:send` always emits one `room:error`.
// The old `handleChatSend` swallowed cooldowns and empty messages as `ignored`, which looked to the user like
// "only the input box cleared and nothing happened" (docs/BACKLOG.md 2026-09-09).

import type { Server } from "socket.io";
import { resolveRoomAccessDecision, type RoomAccess } from "@/lib/chat-rooms-policy";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import { readLocaleCookie } from "@/lib/i18n/server";
import type { UserContext } from "@/lib/user-context";
import type * as chatRooms from "@/lib/chat-rooms";
import type { PlayerState } from "./socket-handlers";
import type { getOrCreateRoomRuntime, invalidateRoomRuntime } from "./room-runtime";
import { broadcastRoomMessage, roomSocketRoom } from "./room-broadcast";

export type RoomErrorCode =
  "forbidden" | "not_found" | "not_open" | "empty" | "cooldown" | "not_joined" | "invalid";

/** Max length of a single human message. Carried over as-is from the old `handleChatSend` rule. */
const MAX_MESSAGE_LENGTH = 500;
/** Number of past conversation lines returned by `room:open`. */
const HISTORY_LIMIT = 60;

type RoomSocket = {
  id: string;
  /** Set by player:join. `userContext` is the caller's name and bio (goes into the transcript preamble). */
  data?: { userContext?: UserContext | null };
  /** The language cookie rides on the handshake — it decides the language of what the server writes for this user. */
  handshake?: { headers?: { cookie?: string } };
  on(event: string, handler: (payload: unknown) => unknown): void;
  emit(event: string, payload: unknown): void;
  join(room: string): void;
  leave(room: string): void;
};

type RoomIo = {
  to(room: string): { emit(event: string, payload: unknown): void };
};

export { broadcastRoomMessage, roomSocketRoom } from "./room-broadcast";

export type RegisterRoomHandlersArgs = {
  io: Server;
  socket: RoomSocket;
  deps: {
    user: { userId: string; nickname: string };
    players: Map<string, PlayerState>;
    lastChatTime: Map<string, number>;
    cooldownMs: number;
    getParticipationAccess: (
      channelId: string,
      userId: string,
    ) => Promise<{ access: { allowed: boolean } } | null>;
    rooms: typeof chatRooms;
    getRuntime: typeof getOrCreateRoomRuntime;
    invalidateRuntime: typeof invalidateRoomRuntime;
    now?: () => number;
  };
};

export type RoomHandlers = {
  list: (payload: unknown) => Promise<void>;
  open: (payload: unknown) => Promise<void>;
  close: (payload: unknown) => Promise<void>;
  send: (payload: unknown) => Promise<void>;
  create: (payload: unknown) => Promise<void>;
  invite: (payload: unknown) => Promise<void>;
  leave: (payload: unknown) => Promise<void>;
  rename: (payload: unknown) => Promise<void>;
  delete: (payload: unknown) => Promise<void>;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function memberKey(member: { kind: string; id: string }): string {
  return `${member.kind}:${member.id}`;
}

/**
 * For system messages the server puts in structure rather than hardcoding Korean sentences — the client renders
 * them in its own locale. If the server built the sentence, a room's record would be frozen in the language of
 * whoever was connected at the time.
 */
function systemContent(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function registerRoomHandlers({ io, socket, deps }: RegisterRoomHandlersArgs): RoomHandlers {
  const {
    user,
    players,
    lastChatTime,
    cooldownMs,
    getParticipationAccess,
    rooms,
    getRuntime,
    invalidateRuntime,
    now = () => Date.now(),
  } = deps;
  const roomIo = io as unknown as RoomIo;

  /** Rooms this socket is currently viewing. `room:send` rejects rooms not in here. */
  const openRooms = new Set<string>();
  /**
   * The office room this socket is **listening to**. A different concept from `openRooms` (rooms it can send to).
   *
   * Automation notices (card review, blocked, done, cron failure) are broadcast to the office room. If the broadcast
   * only went to sockets that did `room:open`, users viewing a DM or another group room, or with the panel collapsed,
   * wouldn't get the notice until they returned to that room — exactly the users who need to be told.
   * There's one office room per channel and everyone who can enter the channel can see it (hard gate 4), so we
   * always listen from `room:list`, which has checked channel permission.
   */
  let listeningOfficeId: string | null = null;

  const socketRoom = roomSocketRoom;

  function fail(roomId: string | null, code: RoomErrorCode) {
    socket.emit("room:error", { roomId, code });
  }

  async function channelAllowed(channelId: string): Promise<boolean> {
    const result = await getParticipationAccess(channelId, user.userId);
    return Boolean(result?.access.allowed);
  }

  async function resolveAccess(roomId: string): Promise<RoomAccess> {
    const room = await rooms.getRoom(roomId);
    if (!room) return { ok: false, code: "not_found" };
    return resolveRoomAccessDecision({
      room,
      channelAllowed: await channelAllowed(room.channelId),
      isMember: room.kind === "group" ? await rooms.isRoomMember(roomId, user.userId) : false,
    });
  }

  /**
   * One room summary. Produced by rerunning `listRoomsForUser` — the rules for assembling member display names and
   * the last message must live in one place so the list and update notices don't diverge.
   */
  async function summaryFor(
    channelId: string,
    roomId: string,
    forUserId = user.userId,
  ): Promise<RoomSummary | null> {
    const all = await rooms.listRoomsForUser(channelId, forUserId);
    return all.find((r) => r.id === roomId) ?? null;
  }

  /** That user's sockets connected to this process. Invite/create notices are pushed straight into them. */
  function socketIdsForUsers(userIds: Set<string>): string[] {
    const ids: string[] = [];
    for (const [socketId, player] of players) {
      if (socketId !== socket.id && userIds.has(player.userId)) ids.push(socketId);
    }
    return ids;
  }

  async function appendSystemMessage(roomId: string, payload: Record<string, unknown>) {
    const message = await rooms.appendRoomMessage({
      roomId,
      senderKind: "system",
      senderId: null,
      senderName: "",
      content: systemContent(payload),
    });
    broadcastRoomMessage(roomIo, roomId, message);
  }

  const handlers: RoomHandlers = {
    async list(payload) {
      const { channelId } = (payload ?? {}) as { channelId?: unknown };
      const id = asString(channelId);
      if (!id) return fail(null, "invalid");
      if (!(await channelAllowed(id))) return fail(null, "forbidden");
      // The office room is the channel's default, so its existence is ensured when the list is asked for — it isn't
      // created at channel creation time (there are pre-migration channels), so this is the only ensuring point.
      // The owner is the **channel owner**. Using the caller would make whichever guest came first the office
      // room's createdBy.
      const ownerId = await rooms.getChannelOwnerId(id);
      if (!ownerId) return fail(null, "not_found");
      const office = await rooms.ensureOfficeRoom(id, ownerId);
      // When asked again after moving channels, stop listening to the previous channel's office room (keep it if
      // it's open).
      if (listeningOfficeId && listeningOfficeId !== office.id && !openRooms.has(listeningOfficeId))
        socket.leave(socketRoom(listeningOfficeId));
      listeningOfficeId = office.id;
      socket.join(socketRoom(office.id));
      socket.emit("room:list-response", {
        channelId: id,
        // The client has no way to know its own user id (there's no viewer identity endpoint).
        // This value is needed to tell whether it created the room.
        viewerUserId: user.userId,
        rooms: await rooms.listRoomsForUser(id, user.userId),
      });
      // Recent lines are sent along so notices piled up before connecting count in the badge. The client's report
      // queue is derived only from received messages, so without this it stays empty until the room is opened.
      // `history` only fills `messages[roomId]` — it doesn't make the room appear opened.
      socket.emit("room:history", {
        roomId: office.id,
        messages: await rooms.recentRoomMessages(office.id, HISTORY_LIMIT, user.userId),
      });
    },

    async open(payload) {
      const { roomId } = (payload ?? {}) as { roomId?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");
      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);
      openRooms.add(id);
      socket.join(socketRoom(id));
      socket.emit("room:history", {
        roomId: id,
        messages: await rooms.recentRoomMessages(id, HISTORY_LIMIT, user.userId),
      });
      socket.emit("room:response-snapshot", { roomId: id, responses: getRoomResponseSnapshot(id) });
    },

    async close(payload) {
      const { roomId } = (payload ?? {}) as { roomId?: unknown };
      const id = asString(roomId);
      if (!id) return;
      openRooms.delete(id);
      // The office room keeps listening even when closed — only sending is blocked (removed from `openRooms`, so
      // not_open).
      if (id !== listeningOfficeId) socket.leave(socketRoom(id));
    },

    async send(payload) {
      const { roomId, message } = (payload ?? {}) as { roomId?: unknown; message?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");

      // New socket.id after reconnect — the client gets this code and sends player:join again.
      const player = players.get(socket.id);
      if (!player) return fail(id, "not_joined");

      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);

      if (!openRooms.has(id)) return fail(id, "not_open");

      const content = String(message ?? "")
        .trim()
        .slice(0, MAX_MESSAGE_LENGTH);
      if (!content) return fail(id, "empty");

      const at = now();
      if (at - (lastChatTime.get(socket.id) || 0) < cooldownMs) return fail(id, "cooldown");
      lastChatTime.set(socket.id, at);

      const senderName = player.characterName || user.nickname;
      const saved = await rooms.appendRoomMessage({
        roomId: id,
        senderKind: "user",
        senderId: user.userId,
        senderName,
        content,
      });
      broadcastRoomMessage(roomIo, id, saved);

      // Runtime assembly (DB + adapter resolution) is awaited, but **the NPC's turn is not.**
      // A turn takes tens of seconds, so awaiting here would block the next message.
      try {
        const runtime = await getRuntime(io, access.room, user.userId);
        if (runtime) {
          void runtime
            .handleHumanMessage(
              senderName,
              content,
              socket.id,
              saved.id,
              socket.data?.userContext ?? null,
              readLocaleCookie(socket.handshake?.headers?.cookie),
            )
            .catch((err) => console.error("[room] turn failed:", err));
        }
      } catch (err) {
        console.error("[room] runtime unavailable:", err);
      }
    },

    async create(payload) {
      const {
        channelId,
        name,
        npcIds: rawNpcIds,
        userIds: rawUserIds,
        requestId: rawRequestId,
      } = (payload ?? {}) as {
        channelId?: unknown;
        name?: unknown;
        npcIds?: unknown;
        userIds?: unknown;
        requestId?: unknown;
      };
      // Only the creator's screen enters the new room. The client doesn't know its own user id, so
      // the ticket sent in the request is returned as-is — it isn't included in invitees' notices.
      const requestId =
        typeof rawRequestId === "string" && rawRequestId.length > 0 && rawRequestId.length <= 64
          ? rawRequestId
          : null;
      const id = asString(channelId);
      if (!id) return fail(null, "invalid");
      const npcIds = asStringArray(rawNpcIds);
      // A room without NPCs is an empty humans-only room — not the purpose of this feature, and creating it would
      // pile up dead rooms in the list where nobody answers no matter who is mentioned.
      if (npcIds.length === 0) return fail(null, "invalid");
      if (!(await channelAllowed(id))) return fail(null, "forbidden");

      const userIds = asStringArray(rawUserIds);
      const room = await rooms.createRoom({
        channelId: id,
        name: typeof name === "string" ? name : "",
        createdBy: user.userId,
        npcIds,
        userIds,
        locale: readLocaleCookie(socket.handshake?.headers?.cookie),
      });
      const summary = await summaryFor(id, room.id);
      if (!summary) return fail(room.id, "not_found");

      socket.emit("room:created", requestId ? { room: summary, requestId } : { room: summary });
      for (const socketId of socketIdsForUsers(new Set(userIds))) {
        roomIo.to(socketId).emit("room:created", { room: summary });
      }
    },

    async invite(payload) {
      const {
        roomId,
        npcIds: rawNpcIds,
        userIds: rawUserIds,
      } = (payload ?? {}) as { roomId?: unknown; npcIds?: unknown; userIds?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");
      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);
      // Office room membership is decided by the roster — touching it here would create two sources of truth.
      if (access.room.kind !== "group") return fail(id, "invalid");

      const npcIds = asStringArray(rawNpcIds);
      const userIds = asStringArray(rawUserIds);
      if (npcIds.length === 0 && userIds.length === 0) return fail(id, "invalid");

      const before = await summaryFor(access.room.channelId, id);
      const beforeKeys = new Set((before?.members ?? []).map(memberKey));

      await rooms.addMembers(id, user.userId, npcIds, userIds);
      // The participant roster changed — the runtime lives with the roster from when it was created, so
      // unless dropped, new members won't come when called.
      invalidateRuntime(id);

      const after = await summaryFor(access.room.channelId, id);
      if (!after) return fail(id, "not_found");
      const added = after.members.filter((m) => !beforeKeys.has(memberKey(m)));
      if (added.length > 0) {
        await appendSystemMessage(id, { kind: "invited", names: added.map((m) => m.name) });
      }
      roomIo.to(socketRoom(id)).emit("room:updated", { room: after });
      // Newly invited people aren't in this socket room yet — push the very fact that the room exists.
      for (const socketId of socketIdsForUsers(new Set(userIds))) {
        roomIo.to(socketId).emit("room:created", { room: after });
      }
    },

    async leave(payload) {
      const { roomId } = (payload ?? {}) as { roomId?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");
      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);
      // The office room can't be left — it's the default room always visible while in the channel.
      if (access.room.kind !== "group") return fail(id, "invalid");

      const before = await summaryFor(access.room.channelId, id);
      const myName =
        before?.members.find((m) => m.kind === "user" && m.id === user.userId)?.name ??
        user.nickname;

      await rooms.removeUserMember(id, user.userId);
      invalidateRuntime(id);

      await appendSystemMessage(id, { kind: "left", name: myName });
      if (before) {
        roomIo.to(socketRoom(id)).emit("room:updated", {
          room: {
            ...before,
            members: before.members.filter((m) => !(m.kind === "user" && m.id === user.userId)),
          },
        });
      }
      openRooms.delete(id);
      socket.leave(socketRoom(id));
      // For the person who left, it's as if the room vanished. Tell them to remove it from the list.
      socket.emit("room:deleted", { roomId: id });
    },

    async rename(payload) {
      const { roomId, name } = (payload ?? {}) as { roomId?: unknown; name?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");
      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);
      if (access.room.kind !== "group") return fail(id, "invalid");
      // Only the creator can rename/delete — if every member could, other people's room names would keep changing.
      if (access.room.createdBy !== user.userId) return fail(id, "forbidden");

      const next = String(name ?? "")
        .trim()
        .slice(0, 60);
      if (!next) return fail(id, "invalid");

      await rooms.renameRoom(id, next);
      await appendSystemMessage(id, { kind: "renamed", name: next });
      const summary = await summaryFor(access.room.channelId, id);
      if (summary) roomIo.to(socketRoom(id)).emit("room:updated", { room: summary });
    },

    async delete(payload) {
      const { roomId } = (payload ?? {}) as { roomId?: unknown };
      const id = asString(roomId);
      if (!id) return fail(null, "invalid");
      const access = await resolveAccess(id);
      if (!access.ok) return fail(id, access.code);
      if (access.room.kind !== "group") return fail(id, "invalid");
      if (access.room.createdBy !== user.userId) return fail(id, "forbidden");

      await rooms.deleteRoom(id);
      invalidateRuntime(id);
      openRooms.delete(id);
      roomIo.to(socketRoom(id)).emit("room:deleted", { roomId: id });
      socket.leave(socketRoom(id));
    },
  };

  socket.on("room:list", (p) => handlers.list(p));
  socket.on("room:open", (p) => handlers.open(p));
  socket.on("room:close", (p) => handlers.close(p));
  socket.on("room:send", (p) => handlers.send(p));
  socket.on("room:create", (p) => handlers.create(p));
  socket.on("room:invite", (p) => handlers.invite(p));
  socket.on("room:leave", (p) => handlers.leave(p));
  socket.on("room:rename", (p) => handlers.rename(p));
  socket.on("room:delete", (p) => handlers.delete(p));

  return handlers;
}
