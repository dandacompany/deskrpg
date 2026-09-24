/**
 * Card creation order within an approval batch.
 *
 * Batch 1 (meeting → follow-up work) passes **precedence as in-batch indices** within a
 * single batch — there are no card ids yet to point to. So the entry point creates the
 * predecessors first, then fills in later items' `parents` with the resulting ids. This
 * file decides only that order.
 *
 * Cycles have to be caught here. In Hermes, cards that wait on each other never get
 * promoted by `recompute_ready` (the parent gate in `kanban_db.py`) — they become cards
 * that are **stuck with no error at all**.
 */
export type ApprovalBatchItem = { parents?: readonly number[] };

export type ApprovalBatchOrder =
  | { ok: true; order: number[] }
  | { ok: false; error: "parent_out_of_range" | "parent_cycle"; index: number };

export function orderApprovalBatch(items: readonly ApprovalBatchItem[]): ApprovalBatchOrder {
  const n = items.length;
  for (let i = 0; i < n; i++) {
    for (const p of items[i].parents ?? []) {
      if (!Number.isInteger(p) || p < 0 || p >= n)
        return { ok: false, error: "parent_out_of_range", index: i };
      if (p === i) return { ok: false, error: "parent_cycle", index: i };
    }
  }
  // Topological sort. Among items whose predecessors are all done, pull out **whichever
  // comes first in input order**, so the same input always yields the same order — if the
  // order wobbles, an idempotency key ends up attached to the wrong card.
  const remaining = new Set<number>();
  for (let i = 0; i < n; i++) remaining.add(i);
  const order: number[] = [];
  while (remaining.size > 0) {
    let picked = -1;
    for (const i of remaining) {
      const parents = items[i].parents ?? [];
      if (parents.every((p) => !remaining.has(p))) {
        picked = i;
        break;
      }
    }
    if (picked === -1) {
      // Everything remaining is waiting on each other — a cycle. Report the earliest index.
      return { ok: false, error: "parent_cycle", index: Math.min(...remaining) };
    }
    remaining.delete(picked);
    order.push(picked);
  }
  return { ok: true, order };
}
