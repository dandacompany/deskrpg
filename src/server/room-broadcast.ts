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

export function broadcastRoomMessage(io: RoomIo, roomId: string, message: RoomMessage): void {
  const audience = noticeAudience(message.notice);
  io.to(audience ? userSocketRoom(audience) : roomSocketRoom(roomId)).emit("room:message", {
    roomId,
    message,
  });
}
