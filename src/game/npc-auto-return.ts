/**
 * The pure decision of "when to send an NPC who came and waits beside us back to their seat".
 *
 * An NPC called directly (`calledForRoom=null`) goes back after a while if there is no 1:1 dialog — the original rule.
 * An NPC who came because they were mentioned in a room (`calledForRoom="r1"`) stays **while that room is visible**.
 * When the room changes, they are sent back right away without a timer.
 */

export type ReturnCandidate = {
  moveState: "idle" | "moving-to-player" | "waiting" | "returning" | "strolling";
  calledForRoom: string | null;
};

export type ReturnContext = { dialogOpen: boolean; visibleRoomId: string | null };

/** Whether to run the wait timer and send them back when time is up. */
export function shouldAutoReturn(npc: ReturnCandidate, ctx: ReturnContext): boolean {
  if (npc.moveState !== "waiting") return false;
  if (ctx.dialogOpen) return false;
  if (npc.calledForRoom && npc.calledForRoom === ctx.visibleRoomId) return false;
  return true;
}

/** Whether to send them back right away without a timer the moment the visible room changes. */
export function shouldReturnOnRoomChange(
  npc: ReturnCandidate,
  visibleRoomId: string | null,
): boolean {
  return (
    npc.moveState === "waiting" && npc.calledForRoom !== null && npc.calledForRoom !== visibleRoomId
  );
}
