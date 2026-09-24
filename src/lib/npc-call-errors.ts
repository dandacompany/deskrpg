// Picks the message shown to the user when an employee call (`npc:call`) is rejected.
//
// The server returns the rejection reason via ack (`handle` in `npc-coordination.ts`),
// but there used to be no receiving side, so it **looked like the click didn't
// register.** Keeping a message per reason in one place is what prevents a silent empty
// string from going out when a new reason is added — the test below enforces that.

/** Rejection reasons the server can return for `npc:call`. */
export const NPC_CALL_REJECTIONS = [
  "unknown_npc",
  "meeting_reserved",
  "already_claimed",
  "forbidden",
  "unavailable",
] as const;

export type NpcCallRejection = (typeof NPC_CALL_REJECTIONS)[number];

const MESSAGE_KEYS: Record<NpcCallRejection, string> = {
  unknown_npc: "game.npcCall.unknownNpc",
  meeting_reserved: "game.npcCall.meetingReserved",
  already_claimed: "game.npcCall.alreadyClaimed",
  forbidden: "game.npcCall.forbidden",
  unavailable: "game.npcCall.unavailable",
};

/**
 * Rejection reason -> translation key. An unknown reason is **never left without a
 * message** — even without knowing the cause, the user needs to know "can't call right
 * now" to stop clicking repeatedly.
 */
export function npcCallErrorKey(error: unknown): string {
  return typeof error === "string" && error in MESSAGE_KEYS
    ? MESSAGE_KEYS[error as NpcCallRejection]
    : MESSAGE_KEYS.unavailable;
}

/** Does the ack indicate success? A case where the ack never even arrives (timeout) also counts as failure. */
export function isNpcCallRejected(result: unknown): boolean {
  return !(
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === true
  );
}
