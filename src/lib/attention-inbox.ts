/**
 * A collection of judgments — collects **only what a human needs to answer**.
 *
 * Same criterion as Paperclip's inbox: a line that can't answer "what moves this forward" is
 * never included. Neglected items are surfaced rather than auto-reassigned.
 *
 * A pure function — assembly must live in one place for the screen and the metrics to see the
 * same list. Counting is `needs-attention.ts`'s job; this file **builds the rows.**
 */
export type AttentionRowKind = "approval" | "blocked" | "review" | "cron_failed";

export type AttentionRow = {
  kind: AttentionRowKind;
  /** approvalId for an approval, taskId for a card, jobId for a cron job. */
  id: string;
  title: string;
  /** When it occurred (ISO). Null only for a card the plugin couldn't provide it for. */
  at: string | null;
  requestedBy: string | null;
  /** The number of bundled cards for an approval, 1 for everything else. */
  count: number;
};

export type AttentionInboxInput = {
  /** `at` is the value the caller read with `taskTimeMs` and converted to ISO. Null if it couldn't be read. */
  cards: readonly { id: string; status: string; title: string; at?: string | null }[];
  approvals: readonly {
    id: string;
    title: string;
    requestedBy: string;
    createdAt: string;
    taskIds: readonly string[];
  }[];
  cronFailures: readonly {
    messageId: string;
    jobId: string;
    jobName: string;
    createdAt: string;
  }[];
};

export function buildAttentionInbox(input: AttentionInboxInput): AttentionRow[] {
  const rows: AttentionRow[] = [];
  // Cards awaiting approval are collected as **one approval row**, not individually — that's the unit a user unblocks with a single click.
  const claimed = new Set<string>();
  for (const approval of input.approvals) {
    for (const taskId of approval.taskIds) claimed.add(taskId);
    rows.push({
      kind: "approval",
      id: approval.id,
      title: approval.title,
      at: approval.createdAt,
      requestedBy: approval.requestedBy,
      count: approval.taskIds.length,
    });
  }
  for (const card of input.cards) {
    // Emitting a blocked card that's already bundled into an approval would show the user the same thing twice.
    if (card.status === "blocked" && !claimed.has(card.id))
      rows.push({
        kind: "blocked",
        id: card.id,
        title: card.title,
        at: card.at ?? null,
        requestedBy: null,
        count: 1,
      });
    else if (card.status === "review")
      rows.push({
        kind: "review",
        id: card.id,
        title: card.title,
        at: card.at ?? null,
        requestedBy: null,
        count: 1,
      });
  }
  for (const cron of input.cronFailures)
    rows.push({
      kind: "cron_failed",
      id: cron.jobId,
      title: cron.jobName,
      at: cron.createdAt,
      requestedBy: null,
      count: 1,
    });

  // Oldest goes to the top — surfacing neglect is this screen's job. Only rows whose time
  // couldn't be read go last, tie-broken by id, so the same input always yields the same order.
  return rows.sort((a, b) => {
    if (a.at && b.at) return a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1;
    if (a.at) return -1;
    if (b.at) return 1;
    return a.id.localeCompare(b.id);
  });
}
