/**
 * The one way a room message reaches browsers (`room:message`). Human and NPC lines and automation
 * notices all go through here so the client needs one listener — and so a private notice
 * (`audience`) goes only to that user's sockets, never to the room.
 */
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import { noticeAudience } from "@/lib/room-audience";

type RoomIo = {
  to(room: string): { emit(event: string, payload: unknown): void };
};

/** Socket room name for room `roomId`. Prefixed so it doesn't collide with channel rooms (`<channelId>`). */
export function roomSocketRoom(roomId: string): string {
  return `room-${roomId}`;
}

/** Every socket of a user joins this on connection (`socket-handlers.ts`). */
export function userSocketRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * A group room's new line, for members who have **another** room open. A socket joins only the room
 * it has open (and the office), so without this the list's preview and unread badge of a group
 * room stay stale until the list is asked for again. The office never needs it — every socket
 * listens to it.
 */
export function broadcastRoomActivity(
  io: RoomIo,
  userIds: readonly string[],
  roomId: string,
  message: RoomMessage,
): void {
  if (noticeAudience(message.notice)) return;
  for (const userId of userIds)
    io.to(userSocketRoom(userId)).emit("room:activity", { roomId, message });
}

export function broadcastRoomMessage(io: RoomIo, roomId: string, message: RoomMessage): void {
  const audience = noticeAudience(message.notice);
  io.to(audience ? userSocketRoom(audience) : roomSocketRoom(roomId)).emit("room:message", {
    roomId,
    message,
  });
}
