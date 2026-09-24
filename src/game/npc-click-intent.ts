// Decide what to do when an NPC is clicked.
//
// There used to be only "walk over and talk on arrival". So when already standing next to the NPC
// no path formed (length 0–1), no arrival event came, and nothing happened —
// the click registered but only the selection marker changed on screen, an unresponsiveness whose cause the user could not know.
//
// On top of that `targetNpcId` remained even in that case, so later, the moment you walked somewhere else
// and arrived, a conversation with an unrelated NPC opened.
export type NpcClickIntent =
  | "interact-now" // Already in reach — open the conversation right there
  | "walk-then-interact" // Walk over, then open the conversation on arrival
  | "walk-only"; // Not a click on an NPC — only move

/**
 * @param pathLength Length of the computed path. It includes the start tile, so 1 or less means "no need to move".
 * @param clickedNpcId The id of the NPC at the click point, or null if none.
 */
export function decideNpcClick(input: {
  pathLength: number;
  clickedNpcId: string | null;
}): NpcClickIntent {
  if (!input.clickedNpcId) return "walk-only";
  return input.pathLength > 1 ? "walk-then-interact" : "interact-now";
}

/** Remember the target only when setting up an arrival wait. Otherwise a polluted target remains. */
export function shouldRememberTarget(intent: NpcClickIntent): boolean {
  return intent === "walk-then-interact";
}
