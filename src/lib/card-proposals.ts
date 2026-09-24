/**
 * Domain logic for resolving a card proposal — "only once, roll back on failure".
 *
 * This function runs when a user picks either `card` (register as an issue card) or
 * `inline` (handle it here) for a work-card proposal an NPC raised during conversation
 * (`card_proposal` in `chat_room_messages.notice_json`). Hermes is the source of truth for
 * proposals and cards, so DeskRPG keeps no copy table — the only thing written here is the
 * notice's `resolved`.
 *
 * The order is itself the rule.
 *
 *   1. The DeskRPG gate (login → member → gateway 409 → plugin 428 → board 503) and the
 *      proposal lookup are passed **first**. If blocked here, the plugin is never touched —
 *      this narrows the window for a later failure.
 *   2. Mark it resolved with the plugin. If already resolved (409), **stop right there.**
 *      This is the gate that ensures a card is only ever created once — the plugin's
 *      judgment is the source of truth, not DeskRPG's own state.
 *   3. If `card`, resolve the assignee. If the proposing NPC clocked out or the gateway
 *      changed, proceed with no assignee and leave `assigneeDropped: true` — Hermes puts an
 *      unassigned card into triage.
 *   4. Create the card.
 *   5. If card creation fails, roll back step 2 (`unresolve`). Without the rollback, a state
 *      of "no card exists, but the button can't be pressed either" would remain. After
 *      rolling back, `notice_json` is **left untouched** — the notice must stay unresolved
 *      so the user can choose again. If the rollback itself fails, that is surfaced as an
 *      error (silently swallowing it would leave a human unable to act).
 *   6. On success, write `resolved` to the notice.
 *
 * `inline` skips 3-5. The follow-up conversation is handled by the **existing path** of
 * room message → NPC response, and nothing is created here.
 *
 * All DB/HTTP access is injected via `ResolveDeps`. This file only makes the judgment call;
 * the route does the wiring — which lets tests pin down ordering and rollback with stubs alone.
 */

import type { NextResponse } from "next/server";

import type { RoomNotice } from "@/lib/chat-rooms-policy";

export type CardProposalNotice = Extract<RoomNotice, { kind: "card_proposal" }>;

/** The one notice a resolve touches. `messageId` is the target to rewrite `notice_json` on. */
export type ProposalRecord = {
  messageId: string;
  notice: CardProposalNotice;
};

/** The payload of the card to create — carried over as-is from the proposal. A missing field simply has no key. */
export type ProposalTaskInput = {
  title: string;
  body?: string;
  acceptance?: string;
  /** Assigned profile name. Absent if the assignee was dropped. */
  assignee?: string;
};

export type ResolveChoice = "card" | "inline";

/**
 * The gate result. A failure is described via `status`/`code`, and if the route has
 * already built a response, it's carried through as `response` as-is (the gate's own
 * wording is never reconstructed here).
 */
export type ProposalGateResult<Ctx> =
  | { ok: true; ctx: Ctx }
  | { ok: false; status: number; code: string; message?: string; response?: NextResponse };

export type ProposalAssigneeResult =
  { ok: true; profileName: string } | { ok: false; code: string };

export type ResolveDeps<Ctx = unknown> = {
  /** The DeskRPG gate. Just wrap `resolveKanbanChannelContext` as-is. */
  gate(input: {
    userId: string;
    channelId: string;
    choice: "card" | "inline";
  }): Promise<ProposalGateResult<Ctx>>;
  /** The proposal notice for this channel. null → 404 if absent. */
  loadProposal(input: { channelId: string; proposalId: string }): Promise<ProposalRecord | null>;
  /**
   * Marks it resolved with the plugin (`POST /deskrpg/card-proposals/:id/resolve`).
   * `false` means already resolved (409) — a judgment, not an error. Any other failure throws.
   */
  markResolved(input: { ctx: Ctx; proposalId: string; choice: ResolveChoice }): Promise<boolean>;
  /**
   * Rolls back the resolved marker (`POST /deskrpg/card-proposals/:id/unresolve`). Throws on
   * failure — this state must not be swallowed. The plugin only unresolves while
   * `resolved_task_id` is empty, so there's no path for a proposal with a recorded card to
   * reopen.
   */
  unresolve(input: { ctx: Ctx; proposalId: string }): Promise<void>;
  /** Assignee resolution (`resolveAssignee`). Failure codes are not reinterpreted here. */
  resolveAssignee(input: { ctx: Ctx; npcId: string }): Promise<ProposalAssigneeResult>;
  /** Creates the card. Throws on failure — a `ProposalStepError` carries its status/code straight up. */
  createTask(input: { ctx: Ctx; task: ProposalTaskInput }): Promise<{ task: { id: string } }>;
  /**
   * Records the created card's id on the proposal (`POST /deskrpg/card-proposals/:id/task`).
   * Since resolving happens before card creation, the plugin's "a proposal with a recorded
   * card can't be unresolved" guard is only kept alive by this call. **A failure here isn't
   * fatal** — all that's lost is a second line of defense, so it doesn't block the flow, only
   * logs. Throw if you want the failure surfaced (the caller catches and logs it).
   */
  recordTask(input: { ctx: Ctx; proposalId: string; taskId: string }): Promise<void>;
  /** Writes `resolved` to the notice. Throws on failure. */
  writeResolved(input: {
    record: ProposalRecord;
    resolved: NonNullable<CardProposalNotice["resolved"]>;
  }): Promise<void>;
  /** The decision timestamp. Injected so tests can pin it. Defaults to the current time. */
  now?(): Date;
};

export type ResolveOutcome =
  | { ok: true; choice: "card"; taskId: string; assigneeDropped: boolean }
  | { ok: true; choice: "inline" }
  // `message`/`response` are left as `undefined` — so a failure branch can be read in one shot without narrowing.
  | { ok: false; status: 409; code: "already_resolved"; message?: undefined; response?: undefined }
  | {
      ok: false;
      status: number;
      code: string;
      message?: string;
      /** The response the gate already built — the route passes it straight through if present. */
      response?: NextResponse;
    };

/** Carries a step failure up as status/code. Stubs and the client throw in the same shape. */
export class ProposalStepError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ProposalStepError";
    this.status = status;
    this.code = code;
  }
}

/** An unrecognized exception is folded into 502 — the original text is kept in `message`. */
function asStepFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ProposalStepError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 502, code: "upstream_error", message };
}

export async function resolveProposal<Ctx>(
  input: { channelId: string; userId: string; proposalId: string; choice: ResolveChoice },
  deps: ResolveDeps<Ctx>,
): Promise<ResolveOutcome> {
  if (input.choice !== "card" && input.choice !== "inline") {
    return { ok: false, status: 400, code: "invalid_field" };
  }

  // 1. Gate — if blocked here, the plugin is never touched.
  const gate = await deps.gate({
    userId: input.userId,
    channelId: input.channelId,
    choice: input.choice,
  });
  if (!gate.ok) {
    return {
      ok: false,
      status: gate.status,
      code: gate.code,
      ...(gate.message ? { message: gate.message } : {}),
      ...(gate.response ? { response: gate.response } : {}),
    };
  }
  const ctx = gate.ctx;

  const record = await deps.loadProposal({
    channelId: input.channelId,
    proposalId: input.proposalId,
  });
  if (!record) return { ok: false, status: 404, code: "card_proposal_not_found" };
  // A cheap early check — the plugin's own 409 is still the source of truth.
  if (record.notice.resolved) return { ok: false, status: 409, code: "already_resolved" };

  // 2. Mark resolved — the gate that ensures a card is only ever created once.
  let marked: boolean;
  try {
    marked = await deps.markResolved({ ctx, proposalId: input.proposalId, choice: input.choice });
  } catch (error) {
    return { ok: false, ...asStepFailure(error) };
  }
  if (!marked) return { ok: false, status: 409, code: "already_resolved" };

  let taskId: string | undefined;
  let assigneeDropped = false;

  if (input.choice === "card") {
    // 3. Resolve the assignee — a failure doesn't block the card. Create it with no assignee and flag the fact.
    const assignee = await deps.resolveAssignee({ ctx, npcId: record.notice.npcId });
    assigneeDropped = !assignee.ok;

    // 4. Create the card.
    const task: ProposalTaskInput = {
      title: record.notice.title,
      ...(record.notice.body ? { body: record.notice.body } : {}),
      ...(record.notice.acceptance ? { acceptance: record.notice.acceptance } : {}),
      ...(assignee.ok ? { assignee: assignee.profileName } : {}),
    };
    try {
      const created = await deps.createTask({ ctx, task });
      taskId = created.task.id;
    } catch (error) {
      // 5. Roll back. `notice_json` is left untouched — the user must still be able to choose again.
      const failure = asStepFailure(error);
      try {
        await deps.unresolve({ ctx, proposalId: input.proposalId });
      } catch (rollbackError) {
        const rollback = asStepFailure(rollbackError);
        return {
          ok: false,
          status: 500,
          code: "resolve_rollback_failed",
          message: `${failure.code}: ${failure.message} / rollback ${rollback.code}: ${rollback.message}`,
        };
      }
      return { ok: false, ...failure };
    }

    // Records the card id on the proposal — this is what keeps the plugin's "can't be
    // unresolved" guard alive. A failure doesn't block the flow: the card already exists,
    // the proposal is already resolved, and all that's lost is a second line of defense.
    // But it's not swallowed silently — the fact that a proposal is missing its guard must land in the log.
    try {
      await deps.recordTask({ ctx, proposalId: input.proposalId, taskId });
    } catch (error) {
      const failure = asStepFailure(error);
      console.warn(
        `[card-proposals] recordTask(${input.proposalId}, ${taskId}) failed: ${failure.code}: ${failure.message}`,
      );
    }
  }

  // 6. Write the decision to the notice. The card already exists in Hermes, so it's not rolled back —
  //    a failure here is surfaced as-is so a human finds out (taskId is kept in the message).
  const at = (deps.now?.() ?? new Date()).toISOString();
  try {
    await deps.writeResolved({
      record,
      resolved: {
        choice: input.choice,
        by: input.userId,
        at,
        ...(taskId ? { taskId } : {}),
      },
    });
  } catch (error) {
    const failure = asStepFailure(error);
    // The two branches are asymmetric. If a card exists (`taskId`), it is not rolled back —
    // that card is the source of truth in Hermes, and rolling back the resolution so the
    // user picks again would spawn a duplicate card. Only the failure itself is honestly
    // surfaced. (Whether the plugin's `resolved_task_id` got filled in is a separate matter —
    // it may be empty since the `recordTask` failure right above is swallowed, but that
    // doesn't change this judgment.)
    // If there's no card (`inline`, or a branch that never created one), this is the only
    // half-state that can be rolled back: it must be, so the user can choose again and take
    // the follow-up conversation path.
    if (taskId === undefined) {
      try {
        await deps.unresolve({ ctx, proposalId: input.proposalId });
      } catch (rollbackError) {
        const rollback = asStepFailure(rollbackError);
        return {
          ok: false,
          status: 500,
          code: "resolve_rollback_failed",
          message: `notice_write_failed: ${failure.message} / rollback ${rollback.code}: ${rollback.message}`,
        };
      }
      return { ok: false, status: 500, code: "notice_write_failed", message: failure.message };
    }
    return {
      ok: false,
      status: 500,
      code: "notice_write_failed",
      message: `task ${taskId} created but notice not updated: ${failure.message}`,
    };
  }

  return input.choice === "card"
    ? { ok: true, choice: "card", taskId: taskId as string, assigneeDropped }
    : { ok: true, choice: "inline" };
}
