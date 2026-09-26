/**
 * A collection of judgments — collects **only what a human needs to answer**.
 *
 * Same criterion as Paperclip's inbox: a line that can't answer "what moves this forward" is
 * never included. Neglected items are surfaced rather than auto-reassigned.
 *
 * A pure function — assembly must live in one place for the screen and the metrics to see the
 * same list. Counting is `needs-attention.ts`'s job; this file **builds the rows.**
 */
export type AttentionRowKind =
  "approval" | "blocked" | "review" | "cron_failed" | "approval_blocked";

/**
 * What an unattended run hit — flattened onto `approval_blocked` rows, which only their audience receives. The
 * screen reads these fields from the row itself (`AttentionInboxPanel.approvalBlockedFields`).
 */
export type BlockedRunDetail = {
  /** The office-room notice this row comes from (also the row id) — sent back with [Add to allowlist]. */
  messageId: string;
  npcId: string;
  npcName: string;
  source: "cron" | "kanban";
  blockKind: "command" | "mcp";
  tool: string;
  command: string | null;
  /** Hermes' rule key for the command — what [Add to allowlist] adds when present. */
  patternKey: string | null;
  patternDescription: string | null;
  mcpServer: string | null;
  jobName: string | null;
  taskTitle: string | null;
  /** One line of what was blocked: the (redacted) command, else the tool (the MCP tool for MCP blocks). */
  subtitle: string;
  /**
   * The viewer owns the gateway and may change the NPC's run policy. Whether the allowlist can unblock it is
   * `patternKey` — the screen offers [Add to allowlist] with a key and [Open run policy] without one.
   */
  canAllowlist: boolean;
};

type AttentionRowBase = {
  kind: AttentionRowKind;
  /** approvalId for an approval, taskId for a card, jobId for a cron job. */
  id: string;
  title: string;
  /** When it occurred (ISO). Null only for a card the plugin couldn't provide it for. */
  at: string | null;
  requestedBy: string | null;
  /** The number of bundled cards for an approval, 1 for everything else. */
  count: number;
  /**
   * On a blocked card: failures in a row. Present when > 0 — the card was blocked after repeated
   * failed runs and only runs again once someone fixes the cause and unblocks it.
   */
  failures?: number;
};

export type AttentionRow =
  | (AttentionRowBase & { kind: Exclude<AttentionRowKind, "approval_blocked"> })
  | (AttentionRowBase & { kind: "approval_blocked" } & BlockedRunDetail);

export type AttentionInboxInput = {
  /** `at` is the value the caller read with `taskTimeMs` and converted to ISO. Null if it couldn't be read. */
  cards: readonly {
    id: string;
    status: string;
    title: string;
    at?: string | null;
    /** `consecutive_failures` from the board (plugin 0.21.0+); absent on older plugins. */
    failures?: number;
  }[];
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
  /** Blocked unattended runs addressed to the viewer (already filtered by audience, unresolved only). */
  blockedRuns?: readonly {
    title: string;
    createdAt: string;
    detail: BlockedRunDetail;
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
        ...(card.failures && card.failures > 0 ? { failures: card.failures } : {}),
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

  for (const run of input.blockedRuns ?? [])
    rows.push({
      kind: "approval_blocked",
      id: run.detail.messageId,
      title: run.title,
      at: run.createdAt,
      requestedBy: null,
      count: 1,
      ...run.detail,
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
