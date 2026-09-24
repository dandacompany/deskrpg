/**
 * The request that map placement sends. `GamePageClient` cannot be rendered in node, so the body is
 * built and tested here.
 *
 * Putting any field other than the seat in the body makes the route reject it with 400 `unsupported_npc_field`
 * — the old placement path sent name, persona and appearance along (back then it created the
 * NPC), and the Hermes profile is now the source of truth for those fields.
 */
export function buildPlacementRequest(
  npcId: string,
  col: number,
  row: number,
): { url: string; init: RequestInit } {
  return {
    url: `/api/npcs/${encodeURIComponent(npcId)}`,
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionX: col, positionY: row }),
    },
  };
}

/**
 * What to send to other players after placement.
 *
 * For a seat **move**, sending only `npc:broadcast-add` leaves other screens standing on the old cell —
 * because the receiving `npc:added` ignores an existing NPC with `if (this.npcSprites.some(n => n.id === id)) return;`
 * (OfficeSimulation.addNpc). So a move first removes, then re-adds.
 * The first placement has nothing to remove, so it is a single add.
 */
export type PlacementBroadcastStep = "remove" | "add";

export function placementBroadcastPlan(prevPlaced: boolean): PlacementBroadcastStep[] {
  return prevPlaced ? ["remove", "add"] : ["add"];
}

/**
 * Placement request response status → whether to keep placement mode.
 *
 * 409 means "another employee is already on that cell". The user can just click another cell, so placement
 * mode is kept. Previously only the comment said so, and the `return` could not skip the `finally`
 * cleanup (setPlacementMode(false)), so clicking a cell did nothing
 * except make placement mode disappear — the very kind of silent failure this branch set out to remove.
 */
export function keepsPlacementMode(status: number): boolean {
  return status === 409;
}
