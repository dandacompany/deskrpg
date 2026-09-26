// Policy for **surfacing** 1:1 conversations (DMs) with employees in the conversation list.
//
// A DM isn't a room (`chat_rooms`) — it's a (character_id, npc_id) pair in `chat_messages`.
// The record persists, but with no entry point in the list, closing the panel meant you had to
// go find that employee on the map and call them again just to keep talking. This converts that
// pair into "one conversation line."
//
// The part that touches the DB lives in `npc-chat-history.ts`; this file holds only pure functions.

export type DmThreadRow = {
  npcId: string;
  role: string;
  content: string;
  createdAt: Date | null;
};

export type DmThread = {
  npcId: string;
  /** The last message used for the list preview. Also shows who said it. */
  lastMessage: { role: "player" | "npc"; content: string };
  lastAt: number;
  /** The viewer's employee replies after their read point (`conversation_reads`). */
  unread?: number;
  readAt?: string | null;
};

/**
 * Folds multiple rows for the same employee into one line — keeps only the last message and
 * sorts most-recent-first.
 *
 * Rows with no timestamp (`createdAt` null) aren't dropped either. The order is already decided
 * by the query, and all that's lost here is the display timestamp — same reasoning as
 * `toHistoryMessages`.
 */
export function summarizeDmThreads(rows: DmThreadRow[]): DmThread[] {
  const byNpc = new Map<string, DmThread>();
  for (const row of rows) {
    if (row.role !== "player" && row.role !== "npc") continue;
    const content = row.content.trim();
    if (!content) continue;
    const at = row.createdAt ? row.createdAt.getTime() : 0;
    const current = byNpc.get(row.npcId);
    // At the same timestamp, the row read later wins — since the query is ascending, that's the last message.
    if (current && current.lastAt > at) continue;
    byNpc.set(row.npcId, {
      npcId: row.npcId,
      lastMessage: { role: row.role, content },
      lastAt: at,
    });
  }
  return [...byNpc.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export type DmThreadNpc = { id: string; name: string; active: boolean };

export type DmThreadEntry = DmThread & { npcName: string; active: boolean };

/**
 * Builds the lines to render in the list.
 *
 * **An employee who has clocked out is not hidden** — the record belongs to the user, and hiding
 * it would bring back the exact defect this fixes (having no entry point and needing to go back
 * to the map). It's shown as inactive but still readable. On the other hand, **an employee not
 * in the roster at all is excluded** — deleting one cascades to delete `chat_messages` too
 * (schema's onDelete: cascade), so what's left here is just a stale listing.
 */
export function buildDmThreadEntries(threads: DmThread[], npcs: DmThreadNpc[]): DmThreadEntry[] {
  const known = new Map(npcs.map((npc) => [npc.id, npc]));
  const entries: DmThreadEntry[] = [];
  for (const thread of threads) {
    const npc = known.get(thread.npcId);
    if (!npc) continue;
    entries.push({ ...thread, npcName: npc.name, active: npc.active });
  }
  return entries;
}

/**
 * Whether sending a message in a DM opened from the list needs to call that employee over.
 *
 * Dante's instruction: **opening it alone doesn't call them — the call happens at send time.**
 * If they're already nearby or already on the way, they aren't called again — the same
 * decision rule room chat (`handleRoomSend`) uses.
 */
export function needsCallBeforeDmSend(moveState: string | undefined | null): boolean {
  return moveState !== "waiting" && moveState !== "moving-to-player";
}
