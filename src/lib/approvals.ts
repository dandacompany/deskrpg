/**
 * Pre-execution approval gate — sets a card to `blocked` and creates an approval record alongside it.
 *
 * Why `blocked`: a card created with `initial_status="blocked"` in Hermes is **sticky**,
 * so `recompute_ready` won't promote it — only `unblock_task` releases it (confirmed
 * 2026-09-21). `triage` can't be used as a holding state because the gateway
 * auto-decomposes it every tick.
 *
 * Why there's no source field on the Hermes card: whether approval is needed is
 * decided by **whether it went through this path**. Cards made by cron, swarm, or a
 * worker don't go through here, so they run unmarked as-is.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

// Import via the dialect-neutral path — `@/db/schema` is PG-only, and `now()` leaks through on SQLite.
import { approvalTargets, approvals, db } from "@/db";
import type { CreateTaskBody } from "@/lib/hermes/deskrpg-plugin-types";
import { orderApprovalBatch } from "@/lib/approval-batch-order";
import type { KanbanChannelContext } from "@/lib/kanban-access";
import { resolveAssignee, reviewPolicyFailure } from "@/lib/kanban-access";
import { requestEmitRoomMessage } from "@/lib/automation-registry";
import { appendRoomMessage, ensureOfficeRoom } from "@/lib/chat-rooms";
import { getChannelOwnerId } from "@/lib/chat-rooms";
import { parseRequester } from "@/lib/approval-requester";

export type ApprovalSource = {
  kind: "meeting" | "manual" | "chat_proposal";
  id: string;
};

export type ApprovalBatchInput = {
  type: string;
  title: string;
  /** The requesting profile name (employee), not a user id. */
  requestedBy: string;
  source: ApprovalSource;
  /** If dev3's `?board=` comes in, just pass this argument through. Otherwise the channel's single board. */
  boardSlug?: string;
  items: readonly ApprovalBatchItemInput[];
};

export type ApprovalBatchItemInput = {
  title: string;
  body?: string;
  /** The assigned NPC. The profile name is resolved server-side — the screen doesn't need to know it. */
  npcId?: string;
  tenant?: string;
  /** The **index** of a preceding item within the same batch. No card id yet to point at. */
  parents?: readonly number[];
  /** Keeps a retry from creating a card twice. E.g. `meeting:{minutesId}:{index}` */
  idempotencyKey?: string;
};

export type ApprovalBatchFailure = {
  index: number;
  errorCode: string;
};

export type ApprovalBatchResult =
  | {
      ok: true;
      approvalId: string;
      /** In input order. A slot that couldn't be created is null. */
      taskIds: (string | null)[];
      failed?: ApprovalBatchFailure[];
    }
  | { ok: false; errorCode: string; index?: number };

/**
 * Creates the cards and bundles them into a single approval.
 *
 * Cards live in Hermes and approvals live in DeskRPG, so **this can't be one transaction.**
 * The order is cards first, record second — reversing it would leave a targetless
 * approval behind if card creation fails. If record creation fails, the card stays
 * `blocked` and the "blocked cards" row in the judgment queue surfaces it as an orphan
 * with no approval record.
 *
 * **If not a single card could be made, no approval is created.** An approval with
 * nothing to press is just noise.
 */
export async function createApprovalBatch(
  ctx: KanbanChannelContext,
  input: ApprovalBatchInput,
): Promise<ApprovalBatchResult> {
  if (reviewPolicyFailure(ctx)) return { ok: false, errorCode: "review_policy_required" };
  const ordered = orderApprovalBatch(input.items);
  if (!ordered.ok) return { ok: false, errorCode: ordered.error, index: ordered.index };

  const board = input.boardSlug ?? ctx.boardSlug;
  const taskIds: (string | null)[] = input.items.map(() => null);
  const failed: ApprovalBatchFailure[] = [];

  for (const index of ordered.order) {
    const item = input.items[index];
    const parentIndexes = item.parents ?? [];
    const parents = parentIndexes.map((p) => taskIds[p]);
    if (parents.some((id) => id === null)) {
      // A predecessor failed. Creating this card would leave it waiting on a parent that never resolves.
      failed.push({ index, errorCode: "parent_failed" });
      continue;
    }

    let assignee: string | undefined;
    if (item.npcId) {
      const resolved = await resolveAssignee(ctx, item.npcId);
      if (!resolved.ok) {
        // `resolveAssignee` is built for routes, so it returns a NextResponse. Here only one
        // line of the batch failed, so the response is discarded and only the code is kept
        // — the rest of the cards keep being created.
        failed.push({ index, errorCode: "assignee_not_in_channel" });
        continue;
      }
      assignee = resolved.profileName;
    }

    const body: CreateTaskBody = {
      title: item.title,
      review_policy: { version: 1, mode: "human", reviewer_profile: null },
      // The heart of the gate — set from the start. Changing status after creation lets a dispatch slip through in between.
      initial_status: "blocked",
      ...(item.body ? { body: item.body } : {}),
      ...(assignee ? { assignee } : {}),
      ...(item.tenant ? { tenant: item.tenant } : {}),
      ...(parents.length > 0 ? { parents: parents as string[] } : {}),
      ...(item.idempotencyKey ? { idempotency_key: item.idempotencyKey } : {}),
    };
    const res = await ctx.client.kanban.createTask(board, body);
    if (!res.ok) {
      failed.push({ index, errorCode: res.failure.code || "create_failed" });
      continue;
    }
    taskIds[index] = res.data.task.id;
  }

  const created = taskIds.filter((id): id is string => id !== null);
  if (created.length === 0) return { ok: false, errorCode: "no_tasks_created" };

  // Retries are a path the design promises — if some fail, the button stays and the user
  // presses it again. Thanks to the idempotency key, Hermes returns the same card, but
  // unconditionally creating a new approval here would leave **one more pending approval
  // pointing at the same card**. If the user approves one of the two, the card unblocks
  // while the other sits pending in the judgment queue forever.
  // Serialize by naming the fields explicitly. `JSON.stringify(input.source)` follows
  // **key order**, so if a caller builds `{id, kind}` instead, the same source produces a
  // different string and a new approval gets created.
  const sourceJson = JSON.stringify({ kind: input.source.kind, id: input.source.id });
  const [existing] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.channelId, ctx.channelId),
        eq(approvals.type, input.type),
        eq(approvals.status, "pending"),
        eq(approvals.sourceJson, sourceJson),
      ),
    )
    .limit(1);

  let approvalId: string;
  if (existing) {
    approvalId = existing.id;
    const already = new Set(await approvalTargetIds(approvalId));
    // The PK does block duplicate inserts, but instead of silently swallowing that, only insert what's missing.
    const missing = created.filter((taskId) => !already.has(taskId));
    if (missing.length > 0)
      await db.insert(approvalTargets).values(missing.map((taskId) => ({ approvalId, taskId })));
  } else {
    approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      channelId: ctx.channelId,
      type: input.type,
      status: "pending",
      requestedBy: input.requestedBy,
      title: input.title,
      sourceJson,
      // **Which board** this approval's cards are on. Without this, a decision would
      // always send `unblock` to the channel's default board, and if the cards are on a
      // different board every one would fail with `task_not_found` — but the approval is
      // already closed by then. The user approved it, and nothing happened.
      payloadJson: JSON.stringify({ boardSlug: board }),
    });
    try {
      await db.insert(approvalTargets).values(created.map((taskId) => ({ approvalId, taskId })));
    } catch (error) {
      // The two inserts can't be wrapped in one transaction — the better-sqlite3 driver
      // rejects a transaction callback that returns a Promise ("Transaction function
      // cannot return a promise", confirmed 2026-09-21). So a compensating delete
      // recreates the same guarantee: a `task_execution` approval with zero targets has
      // nothing to press, so it's just noise and isn't left behind.
      await db.delete(approvals).where(eq(approvals.id, approvalId));
      throw error;
    }
  }

  await announceApproval(ctx.channelId, approvalId, input, created.length);

  return {
    ok: true,
    approvalId,
    taskIds,
    ...(failed.length > 0 ? { failed: failed.sort((a, b) => a.index - b.index) } : {}),
  };
}

/** Card ids being held by undecided approvals in this channel. Used by the badge and the judgment queue. */
export async function pendingApprovalTaskIds(channelId: string): Promise<Set<string>> {
  const rows = await db
    .select({ taskId: approvalTargets.taskId })
    .from(approvalTargets)
    .innerJoin(approvals, eq(approvals.id, approvalTargets.approvalId))
    .where(and(eq(approvals.channelId, channelId), eq(approvals.status, "pending")));
  return new Set(rows.map((r) => r.taskId));
}

/** The card ids this approval targets. The list the decision route sends `unblock` to. */
export async function approvalTargetIds(approvalId: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: approvalTargets.taskId })
    .from(approvalTargets)
    .where(eq(approvalTargets.approvalId, approvalId));
  return rows.map((r) => r.taskId);
}

/** Targets for multiple approvals at once. Avoids N+1 queries. */
export async function approvalTargetsByApproval(
  approvalIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (approvalIds.length === 0) return out;
  const rows = await db
    .select({ approvalId: approvalTargets.approvalId, taskId: approvalTargets.taskId })
    .from(approvalTargets)
    .where(inArray(approvalTargets.approvalId, [...approvalIds]));
  for (const row of rows) {
    const list = out.get(row.approvalId);
    if (list) list.push(row.taskId);
    else out.set(row.approvalId, [row.taskId]);
  }
  return out;
}

/**
 * Announces the approval request in the office room.
 *
 * **This is a system message.** Rendering a batch whose requester is a person
 * (`user:<id>`) as employee speech would make it look like the employee said something
 * they didn't. Even when an employee requested it, this is unified as "the system asking
 * the human", and the notice body uses `parseRequester` to spell out who actually
 * requested it.
 *
 * **Doesn't throw even on failure.** A notice showing up late and an approval never
 * being created at all carry different weight. If the row is saved, the user sees it
 * when they open the room; if only the broadcast fails, it shows up on the next refresh.
 */
async function announceApproval(
  channelId: string,
  approvalId: string,
  input: ApprovalBatchInput,
  targetCount: number,
): Promise<void> {
  try {
    const ownerId = await getChannelOwnerId(channelId);
    if (!ownerId) return;
    const room = await ensureOfficeRoom(channelId, ownerId);
    const requester = parseRequester(input.requestedBy);
    const message = await appendRoomMessage({
      roomId: room.id,
      senderKind: "system",
      senderId: null,
      senderName: "",
      // A locale-agnostic fallback. The renderer builds the actual sentence in the viewer's language.
      content: input.title,
      notice: {
        kind: "approval_requested",
        approvalId,
        title: input.title,
        npcName: requester.kind === "profile" ? requester.profileName : "",
        targetCount,
      },
    });
    requestEmitRoomMessage(room.id, message);
  } catch {
    // A notice failure doesn't fail approval creation.
  }
}

/** The board this approval's cards are on. An old row (no `payload_json`) is read as the channel's default board. */
export function approvalBoardSlug(payloadJson: string | null | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { boardSlug?: unknown };
    return typeof parsed.boardSlug === "string" && parsed.boardSlug ? parsed.boardSlug : null;
  } catch {
    return null;
  }
}
