/**
 * "Card needs attention" verdict — the decision-collection screen and the operations
 * metrics use **the same function**.
 *
 * If the two counted it separately, they'd land on different numbers and nobody could tell
 * which one is right. It's a pure function, so it's safe in the client bundle too (it uses
 * neither `node:*` nor `@/db`).
 */
export type AttentionKind = "awaiting_approval" | "blocked" | "review";

type CardLike = { id: string; status: string };

/**
 * Why this card is waiting on a human. Or null.
 *
 * `blocked` does double duty — it means both "awaiting approval" and "blocked by an
 * error". The only thing that tells them apart is **whether this card is in the set of
 * pending approvals**. Kanban columns are fixed at nine, so this is shown as a badge
 * rather than as a separate column (`src/components/kanban/AGENTS.md`).
 */
export function attentionOf(
  card: CardLike,
  pendingApprovalTaskIds: ReadonlySet<string>,
): AttentionKind | null {
  if (card.status === "review") return "review";
  if (card.status !== "blocked") return null;
  return pendingApprovalTaskIds.has(card.id) ? "awaiting_approval" : "blocked";
}

export type AttentionCounts = Record<AttentionKind, number> & { total: number };

export function countNeedsAttention(
  cards: readonly CardLike[],
  pendingApprovalTaskIds: ReadonlySet<string>,
): AttentionCounts {
  const counts: AttentionCounts = {
    awaiting_approval: 0,
    blocked: 0,
    review: 0,
    total: 0,
  };
  for (const card of cards) {
    const kind = attentionOf(card, pendingApprovalTaskIds);
    if (!kind) continue;
    counts[kind] += 1;
    counts.total += 1;
  }
  return counts;
}
