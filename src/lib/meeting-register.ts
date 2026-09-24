/**
 * The body of "register as a project" — hands a meeting's follow-up work off as a single approval batch.
 *
 * Registering **only creates cards**. Cards start out pending approval (`blocked`), and
 * execution starts only after the user approves it (`createApprovalBatch`). Saying "Sophie will
 * research this" in a meeting doesn't make work start moving on its own.
 *
 * The only thing written back to the meeting minutes is the list of created card ids (a link) —
 * card content is not duplicated. Routes stay thin; the judgment happens here. DB and Hermes are
 * both received entirely through `deps`.
 */
import type { MeetingOutcome, MeetingOutcomeRegistered } from "./meeting-outcome";
import type { OutcomeRegistration } from "./meeting-outcome-draft";
import { translateServer } from "./i18n/server";
import { isTenantSlug } from "./tenant-slug";

export type RegisterBatchInput = {
  type: "task_execution";
  title: string;
  requestedBy: string;
  source: { kind: "meeting"; id: string };
  boardSlug?: string;
  items: Array<{
    title: string;
    body?: string;
    npcId?: string;
    tenant?: string;
    /** A position within this batch. Not the meeting outcome's index number. */
    parents?: number[];
    idempotencyKey: string;
  }>;
};

export type RegisterBatchResult =
  | {
      ok: true;
      approvalId: string;
      taskIds: (string | null)[];
      failed?: Array<{ index: number; errorCode: string }>;
    }
  | { ok: false; errorCode: string };

type RegisterContext = { isChannelOwner: boolean; boardSlug: string };

export type RegisterMeetingDeps<Ctx extends RegisterContext = RegisterContext> = {
  loadMinutes: (minutesId: string) => Promise<{
    id: string;
    channelId: string;
    topic: string;
    initiatorId: string | null;
    outcome: MeetingOutcome | null;
  } | null>;
  loadChannelOwner: (channelId: string) => Promise<string | null>;
  /** Kanban gate chain (login → member → gateway 409 → plugin 428 → board membership 404 → board provisioning 503). */
  resolveContext: (input: {
    userId: string;
    channelId: string;
    boardSlug?: string;
  }) => Promise<{ ok: true; ctx: Ctx } | { ok: false; response: Response }>;
  /** Provisions the subproject meta row. A silent no-op if one already exists. */
  ensureSubproject: (
    ctx: Ctx,
    tenant: { slug: string; name: string },
    minutesId: string,
  ) => Promise<void>;
  createBatch: (ctx: Ctx, input: RegisterBatchInput) => Promise<RegisterBatchResult>;
  saveRegistered: (minutesId: string, registered: MeetingOutcomeRegistered) => Promise<void>;
  requesterForUser: (userId: string) => string;
  now: () => string;
};

export type RegisterMeetingResult =
  | { ok: true; registered: MeetingOutcomeRegistered; approvalId: string }
  | { ok: false; response: Response }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502;
      errorCode: string;
      /** Returned as the meeting outcome's index number — so the screen can point at which row. */
      failed?: Array<{ index: number; errorCode: string }>;
    };

type Body = OutcomeRegistration & { boardSlug?: string };

function invalid(errorCode: string): RegisterMeetingResult {
  return { ok: false, status: 400, errorCode };
}

function cardBody(
  followUp: MeetingOutcome["followUps"][number],
  minutes: { id: string; topic: string },
  locale: string | null,
): string {
  return [
    followUp.summary,
    followUp.acceptance
      ? translateServer(locale, "meeting.cardAcceptance", { acceptance: followUp.acceptance })
      : null,
    // The link back to the meeting decision the card came from. The card detail view renders this line as "open minutes."
    translateServer(locale, "meeting.cardSource", { id: minutes.id, topic: minutes.topic }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function registerMeetingOutcome<Ctx extends RegisterContext>(
  args: {
    minutesId: string;
    userId: string;
    body: Body;
    /** Language of the card body labels — the registering user's. Omitted keeps Korean. */
    locale?: string | null;
  },
  deps: RegisterMeetingDeps<Ctx>,
): Promise<RegisterMeetingResult> {
  const minutes = await deps.loadMinutes(args.minutesId);
  if (!minutes) return { ok: false, status: 404, errorCode: "not_found" };

  const ownerId = await deps.loadChannelOwner(minutes.channelId);
  const canManage =
    (ownerId !== null && ownerId === args.userId) ||
    (minutes.initiatorId !== null && minutes.initiatorId === args.userId);
  if (!canManage) return { ok: false, status: 403, errorCode: "forbidden" };

  const outcome = minutes.outcome;
  if (!outcome || outcome.followUps.length === 0) return invalid("nothing_to_register");
  if (outcome.registered) return { ok: false, status: 409, errorCode: "already_registered" };

  // --- Body validation: the index numbers the screen sent aren't trusted as-is ---
  const { items, tenant } = args.body;
  if (!Array.isArray(items) || items.length === 0) return invalid("nothing_to_register");
  const position = new Map<number, number>();
  for (const [at, item] of items.entries()) {
    if (!Number.isInteger(item.index) || !outcome.followUps[item.index])
      return invalid("invalid_followup_index");
    if (position.has(item.index)) return invalid("invalid_followup_index");
    if (typeof item.title !== "string" || !item.title.trim()) return invalid("invalid_title");
    position.set(item.index, at);
  }
  for (const item of items) {
    // If it waits on an item that isn't being registered this time, that card can never start.
    if (!Array.isArray(item.after) || item.after.some((target) => !position.has(target)))
      return invalid("invalid_followup_after");
  }
  if (tenant && (!isTenantSlug(tenant.slug) || !tenant.name?.trim()))
    return invalid("invalid_tenant_slug");

  const resolved = await deps.resolveContext({
    userId: args.userId,
    channelId: minutes.channelId,
    boardSlug: args.body.boardSlug,
  });
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const ctx = resolved.ctx;

  // Project meta is a table only the channel owner can change (`requireOwner` in `project-routes.ts`).
  // The chair's registration must not quietly widen that rule — the card still gets the tenant
  // attached, and a tenant with no meta still shows up as its slug in the view.
  if (tenant && ctx.isChannelOwner) await deps.ensureSubproject(ctx, tenant, minutes.id);

  const batch = await deps.createBatch(ctx, {
    type: "task_execution",
    title: minutes.topic,
    requestedBy: deps.requesterForUser(args.userId),
    source: { kind: "meeting", id: minutes.id },
    boardSlug: ctx.boardSlug,
    items: items.map((item) => ({
      title: item.title.trim(),
      body: cardBody(
        outcome.followUps[item.index],
        minutes,
        args.locale === undefined ? "ko" : args.locale,
      ),
      ...(item.npcId ? { npcId: item.npcId } : {}),
      ...(tenant ? { tenant: tenant.slug } : {}),
      parents: item.after.map((target) => position.get(target) as number),
      // The same item in the same meeting is always one card, no matter how many times it's clicked.
      idempotencyKey: `meeting:${minutes.id}:${item.index}`,
    })),
  });

  if (!batch.ok) return { ok: false, status: 502, errorCode: batch.errorCode };

  if (batch.failed?.length || batch.taskIds.some((id) => id === null)) {
    // Not marked as fully registered. The button stays, and thanks to the idempotency key and approval reuse, clicking again is safe.
    return {
      ok: false,
      status: 502,
      errorCode: "partially_registered",
      failed: (batch.failed ?? []).map((failure) => ({
        index: items[failure.index]?.index ?? failure.index,
        errorCode: failure.errorCode,
      })),
    };
  }

  const registered: MeetingOutcomeRegistered = {
    boardSlug: ctx.boardSlug,
    tenant: tenant?.slug ?? null,
    taskIds: batch.taskIds as string[],
    by: args.userId,
    at: deps.now(),
  };
  await deps.saveRegistered(minutes.id, registered);
  return { ok: true, registered, approvalId: batch.approvalId };
}
