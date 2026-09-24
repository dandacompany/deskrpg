/**
 * The body of the approval-decision REST endpoint. Route files stay thin, and the order is
 * pinned in this one place (`src/app/api/AGENTS.md`).
 *
 * **Why this isn't owner-only:** any channel member can make a decision. Members can already
 * `unblock` a card directly (existing behavior in `kanban-routes.ts`), so narrowing it here
 * wouldn't actually reduce access — it would just mean more waiting for approval.
 *
 * The gate order matches Kanban — `resolveKanbanChannelContext` guarantees
 * login → member → gateway 409 → plugin 428 → board membership 404 → board 503.
 * No bypass path is created here.
 *
 * Approval reaches the employee **as card state**. Once `unblock` happens, the dispatcher
 * picks it up, so there's no separate notification path — this is why the design doesn't
 * need a new channel.
 */
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { approvalTargets, approvals, db, nowForDb } from "@/db";
import { approvalBoardSlug, approvalTargetIds } from "@/lib/approvals";
import {
  decideTargets,
  nextApprovalStatus,
  parseDecision,
  type TargetDecision,
} from "@/lib/approval-decision";
import { rewriteRoomNotices } from "@/lib/room-notice-rewrite";
import { cronError } from "@/lib/cron-access";
import { initialStatusGate } from "@/lib/hermes/plugin-capability";
import { pluginUpgradeRequired } from "@/lib/hermes/plugin-errors";
import { getUserId } from "@/lib/internal-rpc";
import { resolveKanbanChannelContext } from "@/lib/kanban-access";
import { dispatchOnce } from "@/lib/kanban-dispatch";
import { schedulePollNow } from "@/lib/automation-poll-trigger";

export type ApprovalParams = { params: Promise<{ id: string; approvalId: string }> };

function readTargets(raw: unknown): TargetDecision[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: TargetDecision[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const taskId = (entry as { task_id?: unknown }).task_id;
    const decision = parseDecision((entry as { decision?: unknown }).decision);
    if (typeof taskId !== "string" || !taskId || !decision) return null;
    out.push({ taskId, decision });
  }
  return out;
}

/** POST — decides on a single approval and `unblock`s the approved card(s). */
export async function decideApproval(req: NextRequest, channelId: string, approvalId: string) {
  const userId = getUserId(req);
  if (!userId) return cronError(401, "unauthorized", "unauthorized");

  // Read the approval **first**. We need to know which board the card is on to resolve
  // context against that board. Resolving against the default board would leave `unblock`
  // unable to reach a card on a different board.
  // This lookup happens before the permission check, so **its result isn't put in the
  // response** — existence isn't allowed to leak, so the 404/409 split only happens after
  // the member check below passes.
  const [row] = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      payloadJson: approvals.payloadJson,
    })
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.channelId, channelId)))
    .limit(1);

  const resolved = await resolveKanbanChannelContext({
    userId,
    channelId,
    // An old row (no payload) belongs to the channel's default board. The slug still goes
    // through the membership check (404) again.
    ...(row ? { boardSlug: approvalBoardSlug(row.payloadJson) ?? undefined } : {}),
  });
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  // Is this a plugin capable of the gate at all? Recording just the decision without it
  // would leave the card blocked forever.
  const gate = initialStatusGate(ctx.info);
  if (!gate.ok) {
    const failure = pluginUpgradeRequired(gate);
    return cronError(428, failure.code, failure.message, failure.details);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return cronError(400, "invalid_body", "JSON body required");
  const decision = parseDecision(body.decision);
  if (!decision)
    return cronError(400, "invalid_decision", "decision must be approve|reject|request_revision");
  const targets = readTargets(body.targets);
  if (targets === null)
    return cronError(400, "invalid_targets", "targets must be [{task_id, decision}]");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";

  // Only approvals from this channel. Even if someone passes another channel's approval id,
  // fold it into a 404 so existence doesn't leak.
  if (!row) return cronError(404, "approval_not_found", "approval not found");
  if (row.status !== "pending")
    return cronError(409, "approval_already_decided", "approval already decided");

  const targetIds = await approvalTargetIds(approvalId);
  const plan = decideTargets(targetIds, targets, decision);
  if (!plan.ok) return cronError(400, plan.error, `${plan.error}: ${plan.taskId}`);

  // Close the status first. Even if two tabs click at the same time, only one wins — without
  // the `status = 'pending'` condition, both would pass and `unblock` would fire twice.
  const closed = await db
    .update(approvals)
    .set({
      status: nextApprovalStatus(decision),
      decidedBy: ctx.userId,
      decidedAt: nowForDb(),
      ...(note ? { decisionNote: note } : {}),
    })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (closed.length === 0)
    return cronError(409, "approval_already_decided", "approval already decided");

  for (const t of plan.perTarget)
    await db
      .update(approvalTargets)
      .set({ decision: t.decision })
      .where(and(eq(approvalTargets.approvalId, approvalId), eq(approvalTargets.taskId, t.taskId)));

  // Partial failures aren't hidden. Successful ones aren't rolled back either — the rollback
  // itself could also fail, and execution may already have started.
  const failed: { task_id: string; code: string }[] = [];
  for (const taskId of plan.unblock) {
    const res = await ctx.client.kanban.runTaskAction(ctx.boardSlug, taskId, "unblock", {});
    if (!res.ok) failed.push({ task_id: taskId, code: res.failure.code || "unblock_failed" });
  }

  // If there was something to unblock but **none** of it could be, the gateway simply wasn't
  // reachable at that moment. Leaving only the approval closed would force the user to
  // unblock cards one by one by hand, with no pending state left to click again.
  // Since a transaction isn't available, roll back as compensation. A partial failure isn't
  // rolled back — some cards have already started executing, and the rest show up in the
  // blocked-card row of the decision list.
  if (plan.unblock.length > 0 && failed.length === plan.unblock.length) {
    await db
      .update(approvals)
      .set({ status: "pending", decidedBy: null, decidedAt: null })
      .where(eq(approvals.id, approvalId));
    return cronError(502, "unblock_failed", "could not unblock any task", { failed });
  }

  // If any card was unblocked, request one dispatch. The card action route does this after
  // unblock too, but this route sends unblock directly, so it has to be called separately —
  // without it, the card is left to the gateway's built-in dispatcher cycle and sits at ready
  // (about 5 minutes on staging). Even if this fails, the approval is still a success.
  if (plan.unblock.length > failed.length) {
    await dispatchOnce(ctx);
    schedulePollNow(channelId);
  }

  // Comments also go to the same `ctx.boardSlug` — because context was resolved against the
  // approval's board above.
  // A rejection or revision-request message is left as a card comment — the employee reads
  // it when they pick the card back up.
  // No comment is left for an empty note (it would just be noise).
  if (note && decision !== "approve")
    for (const taskId of targetIds)
      await ctx.client.kanban.addComment(ctx.boardSlug, taskId, {
        author: "deskrpg",
        body: note,
      });

  // Have the room's approval-request line report the outcome — otherwise "open approval"
  // would still show even after a decision is made.
  await rewriteRoomNotices({
    channelId,
    needle: approvalId,
    update: (notice) =>
      notice.kind === "approval_requested" && notice.approvalId === approvalId
        ? {
            ...notice,
            resolved: {
              decision: nextApprovalStatus(decision),
              by: ctx.userId,
              at: new Date().toISOString(),
            },
          }
        : null,
  });

  return NextResponse.json({
    ok: true,
    status: nextApprovalStatus(decision),
    unblocked: plan.unblock.filter((id) => !failed.some((f) => f.task_id === id)),
    ...(failed.length > 0 ? { failed } : {}),
  });
}
