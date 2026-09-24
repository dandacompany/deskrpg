/** The 7 room error codes the server sends (`RoomErrorCode` in `src/server/room-socket.ts`). */
const ROOM_ERROR_CODES = [
  "forbidden",
  "not_found",
  "not_open",
  "empty",
  "cooldown",
  "not_joined",
  "invalid",
] as const;
type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export type ChatErrorDecision = {
  toastKey: string;
  /** A socket rejoin is needed — the server considers this socket not in the room. */
  rejoin: boolean;
  /** This room can no longer be seen (gone or no permission) — go back to the list and fetch fresh. */
  backToList: boolean;
};

function isRoomErrorCode(code: unknown): code is RoomErrorCode {
  return ROOM_ERROR_CODES.includes(code as RoomErrorCode);
}

/** Translate the server's `room:error` into UI actions. It knows neither React nor socket, so node:test can cover it. */
export function decideChatError(payload: unknown): ChatErrorDecision {
  const code = (payload as { code?: unknown } | null)?.code;
  if (!isRoomErrorCode(code)) {
    return { toastKey: "game.channelChatFailed", rejoin: false, backToList: false };
  }
  return {
    toastKey: `game.room.error.${code}`,
    rejoin: code === "not_joined",
    backToList: code === "not_found" || code === "forbidden",
  };
}
