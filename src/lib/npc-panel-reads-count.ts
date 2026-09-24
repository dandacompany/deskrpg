/** Count of assigned cards not yet seen. */
export function unseenCardCount(assignedIds: string[], seenIds: string[]): number {
  const seen = new Set(seenIds);
  return assignedIds.filter((id) => !seen.has(id)).length;
}

/**
 * Shrinks the set of seen ids down to its intersection with the currently assigned cards.
 * `KanbanTask` has no `updated_at`, so a time watermark can't be used, and ids are
 * accumulated instead — without pruning, that set grows forever. A card no longer assigned
 * will never be shown again, so it's safe to drop.
 */
export function pruneSeenIds(assignedIds: string[], seenIds: string[]): string[] {
  const assigned = new Set(assignedIds);
  return seenIds.filter((id) => assigned.has(id));
}

/** Count of cron notices later than `seenAt`. The same timestamp counts as already seen. */
export function unseenCronCount(noticeTimes: string[], seenAt: string | null): number {
  if (!seenAt) return noticeTimes.length;
  return noticeTimes.filter((t) => t > seenAt).length;
}
