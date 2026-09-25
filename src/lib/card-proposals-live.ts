import { reviewPolicyFailure } from "@/lib/kanban-access";
/**
 * The **real wiring** for card proposal resolution. Judgment lives in `card-proposals.ts`;
 * this file fills its `ResolveDeps` holes with the DB and the plugin client.
 *
 * All wiring is collected in one place so the route stays thin. Two rules apply.
 *
 * - **Reuse the existing gate as-is** (`resolveKanbanChannelContext`). The response the gate
 *   built is passed through as `response`, its wording never rebuilt.
 * - **A plugin failure never loses its status/code.** It's thrown as `ProposalStepError` so
 *   domain logic decides whether to roll back, and the route sends that status down.
 */

import { and, eq, like } from "drizzle-orm";
import type { NextResponse } from "next/server";

import { chatRoomMessages, chatRooms, db } from "@/db";
import {
  ProposalStepError,
  type CardProposalNotice,
  type ProposalRecord,
  type ResolveDeps,
} from "@/lib/card-proposals";
import { parseRoomNotice } from "@/lib/chat-rooms-policy";
import { cronError } from "@/lib/cron-access";
import type { PluginResponse } from "@/lib/hermes/plugin-client-types";
import {
  resolveAssignee,
  resolveKanbanChannelContext,
  type KanbanChannelContext,
} from "@/lib/kanban-access";

/** Throws a plugin failure while preserving its status/code. A 0 status (network) becomes 503. */
function throwPluginFailure(res: Extract<PluginResponse<unknown>, { ok: false }>): never {
  const status = res.status > 0 ? res.status : res.failure.code === "timeout" ? 504 : 503;
  throw new ProposalStepError(status, res.failure.code, res.failure.message);
}

/**
 * The one proposal-notice message, among this channel's room messages. Since `notice_json`
 * is a string, `like` narrows the candidates first and parsing then accepts only an **exact**
 * match (so a partial match doesn't grab someone else's proposal).
 */
async function loadProposalRecord(input: {
  channelId: string;
  proposalId: string;
}): Promise<ProposalRecord | null> {
  const rows = await db
    .select({ messageId: chatRoomMessages.id, noticeJson: chatRoomMessages.noticeJson })
    .from(chatRoomMessages)
    .innerJoin(chatRooms, eq(chatRooms.id, chatRoomMessages.roomId))
    .where(
      and(
        eq(chatRooms.channelId, input.channelId),
        like(chatRoomMessages.noticeJson, `%${input.proposalId}%`),
      ),
    );
  for (const row of rows) {
    const notice = parseRoomNotice(row.noticeJson);
    if (notice?.kind !== "card_proposal" || notice.proposalId !== input.proposalId) continue;
    return { messageId: row.messageId, notice };
  }
  return null;
}

/** Writes back the notice's `resolved` field. The message's other fields are left untouched. */
async function writeProposalResolved(input: {
  record: ProposalRecord;
  resolved: NonNullable<CardProposalNotice["resolved"]>;
}): Promise<void> {
  const next: CardProposalNotice = { ...input.record.notice, resolved: input.resolved };
  await db
    .update(chatRoomMessages)
    .set({ noticeJson: JSON.stringify(next) })
    .where(eq(chatRoomMessages.id, input.record.messageId));
}

/**
 * The card body. The plugin's `CreateTaskBody` has no `acceptance` field, so it's appended to
 * the body — dropping the proposal's completion criteria would leave the card thinner than the
 * proposal it came from. The heading is markdown an agent reads, so it's independent of the
 * human screen's locale.
 */
function taskBody(task: { body?: string; acceptance?: string }): string | undefined {
  const parts = [task.body, task.acceptance ? `## Acceptance\n${task.acceptance}` : undefined];
  const joined = parts.filter(Boolean).join("\n\n");
  return joined || undefined;
}

/**
 * One set of real deps + a window for reading back the context the gate resolved. The route
 * **never runs the gate again** just to dispatch/poll after success — running the gate twice
 * in one request also means two Hermes calls.
 */
export function liveResolveDeps(): {
  deps: ResolveDeps<KanbanChannelContext>;
  gatedContext(): KanbanChannelContext | null;
} {
  let gated: KanbanChannelContext | null = null;
  const deps: ResolveDeps<KanbanChannelContext> = {
    gate: async ({ userId, channelId, choice }) => {
      const gate = await resolveKanbanChannelContext({ userId, channelId });
      if (gate.ok) {
        const failure = choice === "card" ? reviewPolicyFailure(gate.ctx) : null;
        if (failure)
          return { ok: false, status: 428, code: "review_policy_required", response: failure };
        gated = gate.ctx;
        return { ok: true, ctx: gate.ctx };
      }
      // Passes the gate's response through as-is — wording/extra are never rebuilt.
      const status = gate.response.status;
      return { ok: false, status, code: `gate_${status}`, response: gate.response };
    },

    loadProposal: loadProposalRecord,

    markResolved: async ({ ctx, proposalId, choice }) => {
      const res = await ctx.client.cardProposals.resolve(proposalId, { choice });
      if (res.ok) return true;
      // 409 is not an error, it's a verdict — someone already made the choice.
      if (res.status === 409) return false;
      throwPluginFailure(res);
    },

    unresolve: async ({ ctx, proposalId }) => {
      const res = await ctx.client.cardProposals.unresolve(proposalId);
      if (!res.ok) throwPluginFailure(res);
    },

    /**
     * The real `resolveAssignee` reports failure as `{ok:false, response}` — no code. Since
     * there's exactly one failure branch (not an NPC currently working in this channel), the
     * code is attached here. Without it, the assignee-resolution failure would flow into
     * domain logic in a different shape.
     */
    resolveAssignee: async ({ ctx, npcId }) => {
      const result = await resolveAssignee(ctx, npcId);
      return result.ok
        ? { ok: true, profileName: result.profileName }
        : { ok: false, code: "assignee_not_in_channel" };
    },

    createTask: async ({ ctx, task }) => {
      const body = taskBody(task);
      const res = await ctx.client.kanban.createTask(
        ctx.boardSlug,
        {
          title: task.title,
          review_policy: { version: 1, mode: "human", reviewer_profile: null },
          ...(body ? { body } : {}),
          ...(task.assignee ? { assignee: task.assignee } : {}),
        },
        // Whoever accepted the proposal ordered the work.
        ctx.userId,
      );
      if (!res.ok) throwPluginFailure(res);
      return { task: { id: res.data.task.id } };
    },

    /**
     * Records the created card's id on the proposal — the plugin's "a proposal with a
     * recorded card can't be reverted" guard only comes alive through this call (resolution
     * happens before card creation, so it can't be carried on `resolve`). A failure is thrown
     * as `ProposalStepError`, and whether it blocks the flow is up to domain logic (it
     * doesn't).
     */
    recordTask: async ({ ctx, proposalId, taskId }) => {
      const res = await ctx.client.cardProposals.recordTask(proposalId, { task_id: taskId });
      if (!res.ok) throwPluginFailure(res);
    },

    writeResolved: writeProposalResolved,
  };
  return { deps, gatedContext: () => gated };
}

/** A single failure response. Passes the gate's response through if there is one, otherwise builds one from the code/message. */
export function proposalFailureResponse(outcome: {
  status: number;
  code: string;
  message?: string;
  response?: NextResponse;
}): NextResponse {
  if (outcome.response) return outcome.response;
  return cronError(outcome.status, outcome.code, outcome.message ?? outcome.code);
}
