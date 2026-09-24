/**
 * The pure judgment for an approval decision — it answers exactly one thing: "what should be
 * unblocked".
 *
 * Leaving this in the route would make it untestable. Partial approval isn't just "only the
 * chosen ones" — "anything not chosen follows the decision of the approval as a whole" — a
 * rule that sounds right in words but is easy to get wrong in implementation.
 */
export type ApprovalDecision = "approve" | "reject" | "request_revision";

const DECISIONS: readonly ApprovalDecision[] = ["approve", "reject", "request_revision"];

export function parseDecision(raw: unknown): ApprovalDecision | null {
  return typeof raw === "string" && (DECISIONS as readonly string[]).includes(raw)
    ? (raw as ApprovalDecision)
    : null;
}

export function nextApprovalStatus(decision: ApprovalDecision): string {
  if (decision === "approve") return "approved";
  if (decision === "reject") return "rejected";
  return "revision_requested";
}

export type TargetDecision = { taskId: string; decision: ApprovalDecision };

export type DecideTargetsResult =
  | { ok: true; unblock: string[]; perTarget: TargetDecision[] }
  | { ok: false; error: "target_not_in_approval" | "target_duplicated"; taskId: string };

/**
 * The list of cards to unblock. If `targets` isn't given, everything follows the decision of
 * the approval as a whole.
 *
 * `request_revision` never unblocks anything — work that was asked to be revised must not
 * start.
 */
export function decideTargets(
  targetIds: readonly string[],
  targets: readonly TargetDecision[] | undefined,
  decision: ApprovalDecision,
): DecideTargetsResult {
  const known = new Set(targetIds);
  const chosen = new Map<string, ApprovalDecision>();
  for (const t of targets ?? []) {
    if (!known.has(t.taskId))
      return { ok: false, error: "target_not_in_approval", taskId: t.taskId };
    if (chosen.has(t.taskId)) return { ok: false, error: "target_duplicated", taskId: t.taskId };
    chosen.set(t.taskId, t.decision);
  }
  const unblock = targetIds.filter((id) => {
    const per = chosen.get(id);
    // During a revision request, not even an individual approval unblocks anything. That's
    // what this decision means.
    if (decision === "request_revision") return false;
    return (per ?? decision) === "approve";
  });
  return {
    ok: true,
    unblock,
    perTarget: [...chosen].map(([taskId, d]) => ({ taskId, decision: d })),
  };
}
