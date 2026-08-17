// Pure predicate for whether NpcHireModal's submit handler should call
// POST /api/npcs/{id}/rebind before saving. Extracted so the decision gating a
// live-credential mutation is unit-tested, not buried inline in the event handler.

export function shouldRebindProfile(
  adapterType: string,
  selectedProfileId: string | null,
  currentProfileId: string | null | undefined,
): boolean {
  if (adapterType !== "hermes") return false;
  if (!selectedProfileId) return false;
  return selectedProfileId !== currentProfileId;
}
