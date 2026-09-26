/**
 * The body of the attention-inbox REST endpoint. The route file is a 3-line delegate (`src/app/api/AGENTS.md`).
 *
 * The judgment that builds rows lives in `attention-inbox.ts`; the judgment that counts lives in
 * `needs-attention.ts` — kept outside this file so the screen and operational metrics share the
 * same function. This file only **collects**.
 */
import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { approvals, chatRoomMessages, chatRooms, db, npcs } from "@/db";
import { buildAttentionInbox, type AttentionInboxInput } from "@/lib/attention-inbox";
import { approvalBoardSlug, approvalTargetsByApproval } from "@/lib/approvals";
import { parseRoomNotice } from "@/lib/chat-rooms-policy";
import { visibleToSql } from "@/lib/room-audience";
import { pluginFailureResponse } from "@/lib/cron-access";
import { getUserId } from "@/lib/internal-rpc";
import { countNeedsAttention } from "@/lib/needs-attention";
import { answerNpcQuestion, listUserQuestions } from "@/lib/npc-questions";
import { readJsonObject } from "@/lib/api-body";
import { cronError } from "@/lib/cron-access";
import { taskTimeMs } from "@/lib/plugin-time";
import { resolveKanbanChannelContext } from "@/lib/kanban-access";

/**
 * A row time as ISO 8601. PG hands back a `Date` (and `String(Date)` is "Sun Sep 20 2026 …"),
 * SQLite the ISO text it stored; both leave here in the same shape the card rows use.
 */
export function attentionTime(value: unknown): string {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? String(value) : new Date(ms).toISOString();
}

export type ChannelParams = { params: Promise<{ id: string }> };

/**
 * Crons whose **latest** result in the office room is a failure — one row per job. A later success
 * clears it, and repeated failures don't stack: each run posts its own notice, and listing them all
 * duplicated the row (and its `cron_failed:<jobId>` key) with every failure.
 */
const CRON_SCAN_LIMIT = 200;

async function recentCronFailures(channelId: string) {
  const [office] = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.channelId, channelId), eq(chatRooms.kind, "office")))
    .limit(1);
  if (!office) return [];
  const rows = await db
    .select({
      id: chatRoomMessages.id,
      noticeJson: chatRoomMessages.noticeJson,
      createdAt: chatRoomMessages.createdAt,
    })
    .from(chatRoomMessages)
    .where(eq(chatRoomMessages.roomId, office.id))
    .orderBy(desc(chatRoomMessages.createdAt))
    .limit(CRON_SCAN_LIMIT);
  const out: AttentionInboxInput["cronFailures"][number][] = [];
  // Newest first, so the first result seen for a job is its latest one.
  const settled = new Set<string>();
  for (const row of rows) {
    const notice = parseRoomNotice(row.noticeJson);
    if (!notice || notice.kind !== "cron_result" || settled.has(notice.jobId)) continue;
    settled.add(notice.jobId);
    if (notice.status !== "error") continue;
    out.push({
      messageId: row.id,
      jobId: notice.jobId,
      jobName: notice.jobName,
      createdAt: attentionTime(row.createdAt),
    });
  }
  return out;
}

/**
 * Unresolved `approval_blocked` notices addressed to this viewer. The audience filter is here, on the server —
 * nobody else's blocked runs leave the database for this response.
 */
async function recentBlockedRuns(
  channelId: string,
  viewerUserId: string,
  isGatewayOwner: boolean,
): Promise<NonNullable<AttentionInboxInput["blockedRuns"]>> {
  const [office] = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.channelId, channelId), eq(chatRooms.kind, "office")))
    .limit(1);
  if (!office) return [];
  const rows = await db
    .select({
      id: chatRoomMessages.id,
      noticeJson: chatRoomMessages.noticeJson,
      createdAt: chatRoomMessages.createdAt,
    })
    .from(chatRoomMessages)
    .where(and(eq(chatRoomMessages.roomId, office.id), visibleToSql(viewerUserId)))
    .orderBy(desc(chatRoomMessages.createdAt))
    .limit(CRON_SCAN_LIMIT);
  const out: NonNullable<AttentionInboxInput["blockedRuns"]>[number][] = [];
  for (const row of rows) {
    const notice = parseRoomNotice(row.noticeJson);
    if (notice?.kind !== "approval_blocked" || notice.audience !== viewerUserId) continue;
    if (notice.resolved) continue;
    out.push({
      title: notice.jobName ?? notice.taskTitle ?? notice.jobId ?? notice.taskId ?? notice.tool,
      createdAt: attentionTime(row.createdAt),
      detail: {
        messageId: row.id,
        npcId: notice.npcId,
        npcName: notice.npcName,
        source: notice.source,
        blockKind: notice.blockKind,
        tool: notice.tool,
        command: notice.command ?? null,
        patternKey: notice.patternKey ?? null,
        patternDescription: notice.patternDescription ?? null,
        mcpServer: notice.mcpServer ?? null,
        jobName: notice.jobName ?? null,
        taskTitle: notice.taskTitle ?? null,
        subtitle: notice.command ?? notice.tool,
        canAllowlist: isGatewayOwner,
      },
    });
  }
  return out;
}

/** GET — only what needs a human answer. */
export async function getAttentionInbox(req: NextRequest, channelId: string) {
  const resolved = await resolveKanbanChannelContext({ userId: getUserId(req), channelId });
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  const pending = await db
    .select({
      id: approvals.id,
      title: approvals.title,
      requestedBy: approvals.requestedBy,
      createdAt: approvals.createdAt,
      payloadJson: approvals.payloadJson,
    })
    .from(approvals)
    .where(and(eq(approvals.channelId, channelId), eq(approvals.status, "pending")));
  const targets = await approvalTargetsByApproval(pending.map((a) => a.id));

  // Reading only the default board would **drop pending-approval cards from other boards out of
  // the row**. The boards pointed at by pending approvals are also read. If one board fails,
  // only that board is skipped — one board's failure blanking the whole screen would leave the
  // user seeing nothing.
  const slugs = new Set<string>([ctx.boardSlug]);
  for (const a of pending) {
    const slug = approvalBoardSlug(a.payloadJson);
    if (slug) slugs.add(slug);
  }
  const cardsBySlug: AttentionInboxInput["cards"][number][] = [];
  let anyBoardOk = false;
  for (const slug of slugs) {
    const board = await ctx.client.kanban.getBoard(slug, {});
    if (!board.ok) {
      // If the default board fails, the screen must show why — that one isn't hidden either.
      if (slug === ctx.boardSlug) return pluginFailureResponse(board);
      continue;
    }
    anyBoardOk = true;
    for (const column of board.data.columns)
      for (const task of column.tasks) {
        const ms = taskTimeMs(task.created_at);
        cardsBySlug.push({
          id: task.id,
          status: task.status,
          title: task.title,
          at: ms === null ? null : new Date(ms).toISOString(),
          failures: task.consecutive_failures,
          assignee: task.assignee ?? null,
        });
      }
  }
  if (!anyBoardOk)
    return NextResponse.json({ rows: [], counts: countNeedsAttention([], new Set()) });

  // Card timestamps arrive as **epoch seconds** — calling `Date.parse` on them yields NaN,
  // silently losing the elapsed time. That judgment is kept in exactly one place, `taskTimeMs`
  // (already applied in the loop above).
  const cards = cardsBySlug;
  const input: AttentionInboxInput = {
    cards,
    approvals: pending.map((a) => ({
      id: a.id,
      title: a.title,
      requestedBy: a.requestedBy,
      createdAt: attentionTime(a.createdAt),
      taskIds: targets.get(a.id) ?? [],
    })),
    cronFailures: await recentCronFailures(channelId),
    blockedRuns: await recentBlockedRuns(channelId, ctx.userId, ctx.isGatewayOwner),
    // A gateway that can't be read only drops its questions — never the whole inbox.
    questions: await listUserQuestions(channelId, ctx.userId).catch(() => []),
  };

  const pendingTaskIds = new Set<string>();
  for (const list of targets.values()) for (const id of list) pendingTaskIds.add(id);

  return NextResponse.json({
    rows: buildAttentionInbox(input),
    counts: countNeedsAttention(cards, pendingTaskIds),
  });
}

/**
 * POST — answers an NPC's question from the inbox. Only the user it was put to may; for anyone else,
 * and for an NPC outside this channel, it reads as not found.
 */
export async function postQuestionAnswer(req: NextRequest, channelId: string, questionId: string) {
  const resolved = await resolveKanbanChannelContext({ userId: getUserId(req), channelId });
  if (!resolved.ok) return resolved.response;
  const body = await readJsonObject(req);
  const npcId = body?.npcId;
  const response = body?.response;
  if (typeof npcId !== "string" || typeof response !== "string" || !response.trim())
    return cronError(400, "invalid_body", "npcId and response are required");

  const [npc] = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(and(eq(npcs.id, npcId), eq(npcs.channelId, channelId)))
    .limit(1);
  if (!npc) return cronError(404, "question_not_found", "question not found");

  const outcome = await answerNpcQuestion({
    userId: resolved.ctx.userId,
    npcId,
    questionId,
    response,
  }).catch(() => "failed" as const);
  if (outcome === "answered") return NextResponse.json({ answered: true });
  if (outcome === "invalid") return cronError(400, "invalid_response", "not one of the choices");
  if (outcome === "not_found") return cronError(404, "question_not_found", "question not found");
  return cronError(502, "question_answer_failed", "the gateway did not take the answer");
}
