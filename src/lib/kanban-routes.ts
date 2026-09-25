/**
 * The shared body for the kanban REST route handlers.
 *
 * Keep the route files (`src/app/api/channels/[id]/kanban/**`) thin — the order of body
 * parsing, the gatekeeper (`kanban-access.ts`), the Hermes call, one dispatch (R9),
 * immediate polling (R24), and response assembly is fixed here in one place.
 *
 * Hermes is the source of truth. Card status isn't reinterpreted (R6) — the response is
 * passed through as-is, and Hermes errors go out with their original status code and
 * `{code, message}` (R32). The only things we decide here are permissions and
 * assignee validation.
 */

import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db, gatewayResources } from "@/db";
import { schedulePollNow } from "@/lib/automation-poll-trigger";
import { dispatchOnce } from "@/lib/kanban-dispatch";
import { resolveProposal } from "@/lib/card-proposals";
import { liveResolveDeps, proposalFailureResponse } from "@/lib/card-proposals-live";
import { readWorkingSnapshot } from "@/lib/automation-registry";
import {
  cronError,
  ensureAutomationPlugin,
  pluginFailureResponse,
  requireChannelMember,
} from "@/lib/cron-access";
import { getChannelGatewayBinding } from "@/lib/gateway-resources";
import type {
  CreateTaskBody,
  KanbanTaskAction,
  UpdateOrchestrationBody,
  UpdateTaskBody,
  WorkspaceKind,
  KanbanReviewPolicy,
} from "@/lib/hermes/deskrpg-plugin-types";
import { restorePluginInfo } from "@/lib/hermes/plugin-cache-update";
import {
  supportsBoardAttachmentList,
  supportsReviewPolicy,
  swarmGate,
} from "@/lib/hermes/plugin-capability";
import type { KanbanTaskActionInput } from "@/lib/hermes/plugin-client-types";
import { pluginUpgradeRequired } from "@/lib/hermes/plugin-errors";
import { rawFailureResponse, streamProxyResponse } from "@/lib/hermes/stream-proxy";
import { getUserId } from "@/lib/internal-rpc";
import {
  AUTOMATION_MIN_PLUGIN_VERSION,
  attachmentsUnsupportedResponse,
  commentAuthorFor,
  loadChannelRoster,
  resolveAssignee,
  resolveKanbanChannelContext,
  supportsAttachments,
  type KanbanChannelContext,
} from "@/lib/kanban-access";
import { channelBoardSlug, getChannelBoard } from "@/lib/kanban-boards";
import { getMyCharacter } from "@/lib/my-character";
import { readLocaleCookie } from "@/lib/i18n/server";
import { appendRequesterLine } from "@/lib/user-context";

export type ChannelParams = { params: Promise<{ id: string }> };
export type TaskParams = { params: Promise<{ id: string; taskId: string }> };
export type AttachmentParams = { params: Promise<{ id: string; attachmentId: string }> };

// ---------------------------------------------------------------------------
// Body / query
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

/** JSON body. null if empty or malformed — the caller returns a 400. */
async function readJsonBody(req: NextRequest): Promise<JsonBody | null> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : null;
  } catch {
    return null;
  }
}

/** For actions that don't require a body (approve, reclaim, etc.) — an empty object if empty. */
async function readOptionalJsonBody(req: NextRequest): Promise<JsonBody> {
  return (await readJsonBody(req)) ?? {};
}

function invalidBody(message: string) {
  return cronError(400, "invalid_body", message);
}

const WORKSPACE_KINDS: readonly WorkspaceKind[] = ["scratch", "worktree", "dir"];

function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : undefined;
}

/** Pick only string fields. Unknown keys are dropped — they must not leak into the body sent to Hermes. */
const TASK_STRING_FIELDS = [
  "body",
  "tenant",
  "priority",
  "workspace_path",
  "model_override",
  "provider_override",
  "reasoning_effort",
  "project_id",
] as const;
const TASK_NUMBER_FIELDS = ["max_runtime_seconds", "goal_max_turns"] as const;

function pickTaskFields(body: JsonBody): Omit<CreateTaskBody, "title" | "assignee"> {
  const out: Omit<CreateTaskBody, "title" | "assignee"> = {};
  for (const key of TASK_STRING_FIELDS) {
    if (typeof body[key] === "string") out[key] = body[key] as string;
  }
  for (const key of TASK_NUMBER_FIELDS) {
    if (typeof body[key] === "number" && Number.isFinite(body[key] as number)) {
      out[key] = body[key] as number;
    }
  }
  if (isWorkspaceKind(body.workspace_kind)) out.workspace_kind = body.workspace_kind;
  const parents = stringList(body.parents);
  if (parents) out.parents = parents;
  const skills = stringList(body.skills);
  if (skills) out.skills = skills;
  if (typeof body.goal_mode === "boolean") out.goal_mode = body.goal_mode;
  if (typeof body.triage === "boolean") out.triage = body.triage;
  return out;
}

/**
 * The assignee field. `assignee` is received as npcId (R8) — the server converts it
 * to profile_name. `null` passes through as "clear the assignee" (PATCH only).
 */
async function resolveAssigneeField(
  ctx: KanbanChannelContext,
  body: JsonBody,
): Promise<{ ok: true; assignee?: string | null } | { ok: false; response: NextResponse }> {
  if (!("assignee" in body)) return { ok: true };
  if (body.assignee === null) return { ok: true, assignee: null };
  if (typeof body.assignee !== "string" || !body.assignee) {
    return { ok: false, response: invalidBody("assignee must be an npcId") };
  }
  const resolved = await resolveAssignee(ctx, body.assignee);
  if (!resolved.ok) return resolved;
  return { ok: true, assignee: resolved.profileName };
}

function reviewPolicyRequired() {
  return cronError(
    428,
    "review_policy_required",
    "Update Hermes and the plugin to enable approval policies",
  );
}

async function resolveReviewPolicy(
  ctx: KanbanChannelContext,
  body: JsonBody,
  assignee?: string | null,
): Promise<{ ok: true; policy: KanbanReviewPolicy } | { ok: false; response: NextResponse }> {
  const raw = body.reviewPolicy;
  if (raw === undefined)
    return { ok: true, policy: { version: 1, mode: "human", reviewer_profile: null } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, response: invalidBody("reviewPolicy must be an object") };
  const policy = raw as JsonBody;
  if (Object.keys(policy).some((key) => !["mode", "reviewerNpcId"].includes(key)))
    return { ok: false, response: invalidBody("Unknown approval policy field") };
  if (policy.mode === "human" && !policy.reviewerNpcId)
    return { ok: true, policy: { version: 1, mode: "human", reviewer_profile: null } };
  if (policy.mode !== "agent" || typeof policy.reviewerNpcId !== "string" || !assignee)
    return { ok: false, response: invalidBody("AI approval requires an assignee and reviewer") };
  const reviewer = await resolveAssignee(ctx, policy.reviewerNpcId);
  if (!reviewer.ok) return reviewer;
  if (reviewer.profileName.trim().toLowerCase() === assignee.trim().toLowerCase())
    return { ok: false, response: invalidBody("Reviewer must be a different employee") };
  return {
    ok: true,
    policy: { version: 1, mode: "agent", reviewer_profile: reviewer.profileName },
  };
}

// ---------------------------------------------------------------------------
// Shared flow
// ---------------------------------------------------------------------------

/**
 * The board the request points to. undefined if `?board=` is absent, in which case the
 * context uses the channel's event-receiving board — this is the point that keeps the
 * meaning unchanged for old clients that don't know about boards.
 *
 * Only format validation happens here. **Whether it's this channel's board** is decided
 * by `kanban-access` with a 404 — a well-formed but someone-else's board slug can't be
 * filtered out by format validation alone.
 */
function requestedBoardSlug(req: NextRequest): string | undefined | null {
  const raw = req.nextUrl.searchParams.get("board");
  if (raw === null || raw === "") return undefined;
  return BOARD_SLUG.test(raw) ? raw : null;
}

/** Same as the plugin's board slug rule (`BOARD_SLUG_RE`). */
const BOARD_SLUG = /^[a-z0-9-]{1,64}$/;

async function resolve(req: NextRequest, channelId: string) {
  const boardSlug = requestedBoardSlug(req);
  if (boardSlug === null) {
    return {
      ok: false as const,
      response: cronError(400, "invalid_board", "board slug is malformed"),
    };
  }
  return resolveKanbanChannelContext({ userId: getUserId(req), channelId, boardSlug });
}

// ---------------------------------------------------------------------------
// Board / task
// ---------------------------------------------------------------------------

export async function getBoard(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";
  const [res, npcs] = await Promise.all([
    ctx.client.kanban.getBoard(ctx.boardSlug, { includeArchived }),
    loadChannelRoster(ctx),
  ]);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ ...res.data, npcs });
}

/**
 * `GET /api/channels/:id/kanban/links` — parent/child pairs across the whole board.
 *
 * If the plugin has no batch lookup, the 404 propagates as-is. The screen then falls
 * back to fetching details card by card — papering over it with an empty list here
 * would make "there are no links" and "we can't ask" indistinguishable.
 */
export async function listLinks(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const res = await resolved.ctx.client.kanban.listLinks(resolved.ctx.boardSlug);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

/**
 * `GET /api/channels/:id/kanban/runs?from=&to=&limit=` — run history within a window.
 *
 * The query is passed through as-is. The plugin validates it (400 `invalid_query`);
 * validating again here would let the two rules diverge. Non-numeric values aren't
 * passed through, so they're left to the plugin's judgment.
 */
export async function listRuns(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const q = req.nextUrl.searchParams;
  const num = (key: string) => {
    const raw = q.get(key);
    if (raw === null || raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const res = await resolved.ctx.client.kanban.listRuns(resolved.ctx.boardSlug, {
    from: num("from"),
    to: num("to"),
    limit: num("limit"),
  });
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

export async function getTask(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const res = await resolved.ctx.client.kanban.getTask(resolved.ctx.boardSlug, taskId);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

export async function createTask(req: NextRequest, channelId: string) {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return invalidBody("title is required");

  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  const assignee = await resolveAssigneeField(ctx, body);
  if (!assignee.ok) return assignee.response;

  if (!supportsReviewPolicy(ctx.info)) return reviewPolicyRequired();
  const review = await resolveReviewPolicy(ctx, body, assignee.assignee);
  if (!review.ok) return review.response;
  const task: CreateTaskBody = {
    review_policy: review.policy,
    title,
    ...pickTaskFields(body),
    ...(typeof assignee.assignee === "string" ? { assignee: assignee.assignee } : {}),
  };
  // Note who requested it at the end of the card body. If there's no character, leave it as-is.
  const mine = await getMyCharacter(ctx.userId);
  // Written in the requester's language; no language cookie falls back to English.
  if (mine) {
    const locale = readLocaleCookie(req.headers.get("cookie"));
    task.body = appendRequesterLine(task.body, { name: mine.name, bio: mine.bio }, locale);
  }
  const res = await ctx.client.kanban.createTask(ctx.boardSlug, task, ctx.userId);
  if (!res.ok) return pluginFailureResponse(res);

  await dispatchOnce(ctx);
  schedulePollNow(ctx.channelId);
  return NextResponse.json(
    { task: res.data.task, ...(res.data.warning ? { warning: res.data.warning } : {}) },
    { status: 201 },
  );
}

export async function updateTask(req: NextRequest, channelId: string, taskId: string) {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");

  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  const assignee = await resolveAssigneeField(ctx, body);
  if (!assignee.ok) return assignee.response;

  const update: UpdateTaskBody = { ...pickTaskFields(body) };
  if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim();
  // Status values aren't validated (R6) — if Hermes returns 400, it's passed through as-is.
  if (typeof body.status === "string") update.status = body.status as UpdateTaskBody["status"];
  if (assignee.assignee !== undefined) {
    update.assignee = (assignee.assignee ?? undefined) as UpdateTaskBody["assignee"];
  }

  if ("reviewPolicy" in body) {
    if (!supportsReviewPolicy(ctx.info)) return reviewPolicyRequired();
    const existing = await ctx.client.kanban.getTask(ctx.boardSlug, taskId);
    if (!existing.ok) return pluginFailureResponse(existing);
    const review = await resolveReviewPolicy(
      ctx,
      body,
      assignee.assignee ?? existing.data.task.assignee,
    );
    if (!review.ok) return review.response;
    if (!Number.isInteger(body.expected_revision) || Number(body.expected_revision) < 1)
      return invalidBody("expected_revision is required");
    update.review_policy = review.policy;
    update.expected_revision = Number(body.expected_revision);
  }
  const res = await ctx.client.kanban.updateTask(ctx.boardSlug, taskId, update);
  if (!res.ok) return pluginFailureResponse(res);

  if (update.status !== undefined) await dispatchOnce(ctx);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ task: res.data.task });
}

export async function deleteTask(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  const res = await ctx.client.kanban.deleteTask(ctx.boardSlug, taskId);
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ ok: true });
}

export async function addComment(req: NextRequest, channelId: string, taskId: string) {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");
  const text = typeof body.body === "string" ? body.body : "";
  if (!text.trim()) return invalidBody("body is required");

  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  const res = await ctx.client.kanban.addComment(ctx.boardSlug, taskId, {
    author: await commentAuthorFor(ctx.userId),
    body: text,
  });
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ comment: res.data.comment }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Task actions (R10, R13)
// ---------------------------------------------------------------------------

/** Actions that change status — request one dispatch right after success (R9). */
const DISPATCH_AFTER: ReadonlySet<KanbanTaskAction> = new Set<KanbanTaskAction>([
  "approve",
  "request-changes",
  "unblock",
  "reassign",
  "reclaim",
]);

export async function runTaskAction(
  req: NextRequest,
  channelId: string,
  taskId: string,
  action: KanbanTaskAction,
) {
  const body = await readOptionalJsonBody(req);
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  let res;
  switch (action) {
    case "approve": {
      const input: KanbanTaskActionInput<"approve"> = {};
      if (typeof body.submission_id === "string") input.submission_id = body.submission_id;
      if (typeof body.request_id === "string") input.request_id = body.request_id;
      res = await ctx.client.kanban.runTaskAction(ctx.boardSlug, taskId, "approve", input, {
        userId: ctx.userId,
        name: (await commentAuthorFor(ctx.userId)).slice("deskrpg:".length).slice(0, 200),
      });
      break;
    }
    case "reassign": {
      const npcId = typeof body.npcId === "string" ? body.npcId : "";
      if (!npcId) return invalidBody("npcId is required");
      const assignee = await resolveAssignee(ctx, npcId);
      if (!assignee.ok) return assignee.response;
      const input: KanbanTaskActionInput<"reassign"> = {
        profile: assignee.profileName,
        reclaim_first: true,
      };
      res = await ctx.client.kanban.runTaskAction(ctx.boardSlug, taskId, "reassign", input);
      break;
    }
    case "request-changes": {
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";
      if (!comment) return invalidBody("comment is required");
      res = await ctx.client.kanban.runTaskAction(ctx.boardSlug, taskId, "request-changes", {
        comment,
      });
      break;
    }
    case "unblock": {
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";
      res = await ctx.client.kanban.runTaskAction(
        ctx.boardSlug,
        taskId,
        "unblock",
        comment ? { comment } : {},
      );
      break;
    }
    default:
      res = await ctx.client.kanban.runTaskAction(ctx.boardSlug, taskId, action, {});
  }
  if (!res.ok) return pluginFailureResponse(res);

  if (DISPATCH_AFTER.has(action)) await dispatchOnce(ctx);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ task: res.data.task });
}

// ---------------------------------------------------------------------------
// Attachments (R12)
// ---------------------------------------------------------------------------

async function resolveForAttachments(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved;
  if (!supportsAttachments(resolved.ctx)) {
    return { ok: false as const, response: attachmentsUnsupportedResponse() };
  }
  return resolved;
}

/**
 * Attachments for cards across the whole board — the artifact gallery follows behind this.
 *
 * Files the worker made are wiped along with the `scratch` workspace when the card
 * finishes, and **only the attachment remains.** So if the gallery doesn't know about
 * the attachment, a finished card's deliverable is invisible anywhere.
 *
 * If the plugin doesn't know how to list them (no `kanban_attachment_list` capability),
 * this doesn't error — it answers `supported: false` so the screen still renders the
 * artifact and notes **why there's no attachment** in one line. It does not fake this
 * with N+1 calls fetching each card's detail.
 */
export async function listBoardAttachments(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  if (!supportsAttachments(ctx) || !supportsBoardAttachmentList(ctx.info))
    return NextResponse.json({ supported: false, attachments: [], next_cursor: null });
  const q = req.nextUrl.searchParams;
  const rawLimit = q.get("limit");
  // The plugin validates this (`invalid_query`) — validating again at the REST layer would let the two rules diverge.
  const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
  const res = await ctx.client.kanban.listBoardAttachments(ctx.boardSlug, {
    limit,
    cursor: q.get("cursor") || undefined,
  });
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({
    supported: true,
    attachments: res.data.attachments,
    next_cursor: res.data.next_cursor ?? null,
  });
}

export async function listAttachments(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolveForAttachments(req, channelId);
  if (!resolved.ok) return resolved.response;
  const res = await resolved.ctx.client.kanban.listAttachments(resolved.ctx.boardSlug, taskId);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ attachments: res.data.attachments });
}

/** Passes the multipart `file` part straight through to Hermes. */
export async function uploadAttachment(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolveForAttachments(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  let file: File | null = null;
  try {
    const form = await req.formData();
    const part = form.get("file");
    if (part instanceof File) file = part;
  } catch {
    file = null;
  }
  if (!file) return invalidBody("multipart field 'file' is required");

  const res = await ctx.client.kanban.uploadAttachment(ctx.boardSlug, taskId, {
    filename: file.name || "attachment",
    content: file,
  });
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ attachment: res.data.attachment }, { status: 201 });
}

/** Attachment id shape. `.`, `..`, `/` let URL normalization reach a different path with the owner token — block them before calling out. */
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function attachmentNotFound() {
  return cronError(404, "attachment_not_found", "attachment not found");
}

export async function getAttachment(req: NextRequest, channelId: string, attachmentId: string) {
  const resolved = await resolveForAttachments(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!ATTACHMENT_ID_RE.test(attachmentId)) return attachmentNotFound();
  const res = await resolved.ctx.client.kanban.attachmentContent(
    resolved.ctx.boardSlug,
    attachmentId,
    { range: req.headers.get("range") },
  );
  if (!res.ok) return rawFailureResponse(res);
  return streamProxyResponse(res.response, { forceAttachment: true });
}

export async function deleteAttachment(req: NextRequest, channelId: string, attachmentId: string) {
  const resolved = await resolveForAttachments(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!ATTACHMENT_ID_RE.test(attachmentId)) return attachmentNotFound();
  const ctx = resolved.ctx;
  const res = await ctx.client.kanban.deleteAttachment(ctx.boardSlug, attachmentId);
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Links (R14) · dispatch · logs
// ---------------------------------------------------------------------------

export async function mutateLink(req: NextRequest, channelId: string, op: "add" | "remove") {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");
  const parentId = typeof body.parent_id === "string" ? body.parent_id : "";
  const childId = typeof body.child_id === "string" ? body.child_id : "";
  if (!parentId || !childId) return invalidBody("parent_id and child_id are required");

  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  const link = { parent_id: parentId, child_id: childId };
  const res =
    op === "add"
      ? await ctx.client.kanban.addLink(ctx.boardSlug, link)
      : await ctx.client.kanban.removeLink(ctx.boardSlug, link);
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ ok: true });
}

export async function dispatchBoard(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;
  const rawMax = Number(req.nextUrl.searchParams.get("max"));
  const max = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined;
  const res = await ctx.client.kanban.dispatch(
    ctx.boardSlug,
    max !== undefined ? { max } : undefined,
  );
  if (!res.ok) return pluginFailureResponse(res);
  schedulePollNow(ctx.channelId);
  return NextResponse.json(res.data);
}

// ---------------------------------------------------------------------------
// Swarm — the path into Hermes's `create_swarm`. Hermes builds the topology.
// ---------------------------------------------------------------------------

export async function createSwarm(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  // Native swarm's instant-complete route can't guarantee per-card approval. Existing swarm reads are kept.
  return cronError(
    428,
    "swarm_review_policy_unsupported",
    "New team tasks require a policy-aware Hermes swarm contract",
  );
}

export async function getBlackboard(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  // Same gate as createSwarm — the blackboard is also a swarm feature, so it returns the same 428.
  const gate = swarmGate(ctx.info);
  if (!gate.ok) {
    const failure = pluginUpgradeRequired(gate);
    return cronError(428, failure.code, failure.message, failure.details);
  }

  const res = await ctx.client.kanban.getBlackboard(ctx.boardSlug, taskId);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

export async function getTaskLog(req: NextRequest, channelId: string, taskId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const rawTail = Number(req.nextUrl.searchParams.get("tail"));
  const tail = Number.isInteger(rawTail) && rawTail >= 0 ? rawTail : undefined;
  const res = await resolved.ctx.client.kanban.getTaskLog(resolved.ctx.boardSlug, taskId, {
    tail,
  });
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

// ---------------------------------------------------------------------------
// Settings — board work folder (channel owner) · host orchestration settings (read = channel owner, write = gateway owner)
// ---------------------------------------------------------------------------

function settingsForbidden() {
  return cronError(403, "settings_forbidden", "You cannot change this setting");
}

async function readBoardMeta(ctx: KanbanChannelContext) {
  const res = await ctx.client.kanban.listBoards();
  if (!res.ok) return res;
  const meta = res.data.boards.find((b) => b.slug === ctx.boardSlug) ?? null;
  return { ok: true as const, data: meta };
}

async function buildSettingsResponse(ctx: KanbanChannelContext) {
  // Reading orchestration settings is the channel owner's privilege, but a shape where the
  // gateway owner who can edit them can't see what they changed doesn't make sense — write
  // permission implies read permission. Regular members get null.
  const canReadOrchestration = ctx.isChannelOwner || ctx.isGatewayOwner;
  const [board, orchestration] = await Promise.all([
    readBoardMeta(ctx),
    canReadOrchestration ? ctx.client.kanban.getOrchestration() : Promise.resolve(null),
  ]);
  if (!board.ok) return pluginFailureResponse(board);
  if (orchestration && !orchestration.ok) return pluginFailureResponse(orchestration);
  return NextResponse.json({
    board: {
      slug: ctx.boardSlug,
      name: board.data?.name ?? null,
      default_workdir: board.data?.default_workdir ?? null,
      editable: ctx.isChannelOwner,
    },
    orchestration: orchestration ? { ...orchestration.data, editable: ctx.isGatewayOwner } : null,
    hints: { default_assignee_recommend_empty: true },
  });
}

export async function getSettings(req: NextRequest, channelId: string) {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  return buildSettingsResponse(resolved.ctx);
}

function parseOrchestrationPatch(raw: JsonBody): UpdateOrchestrationBody {
  const patch: UpdateOrchestrationBody = {};
  for (const key of ["orchestrator_profile", "default_assignee"] as const) {
    if (key in raw && (typeof raw[key] === "string" || raw[key] === null)) {
      patch[key] = raw[key] as string | null;
    }
  }
  if (typeof raw.auto_decompose === "boolean") patch.auto_decompose = raw.auto_decompose;
  for (const key of ["max_in_progress", "max_in_progress_per_profile"] as const) {
    if (typeof raw[key] === "number" && Number.isInteger(raw[key])) patch[key] = raw[key] as number;
  }
  return patch;
}

/** PATCH `{board?:{default_workdir}, orchestration?:{...}}`. If any part lacks permission, 403. */
export async function patchSettings(req: NextRequest, channelId: string) {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");
  const boardPatch =
    typeof body.board === "object" && body.board !== null ? (body.board as JsonBody) : null;
  const orchestrationPatch =
    typeof body.orchestration === "object" && body.orchestration !== null
      ? (body.orchestration as JsonBody)
      : null;
  if (!boardPatch && !orchestrationPatch) {
    return invalidBody("board or orchestration is required");
  }

  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const ctx = resolved.ctx;

  // Check all permissions before calling Hermes — a 403 must not go out after only half applied.
  if (boardPatch && !ctx.isChannelOwner) return settingsForbidden();
  if (orchestrationPatch && !ctx.isGatewayOwner) return settingsForbidden();

  if (boardPatch) {
    if (typeof boardPatch.default_workdir !== "string") {
      return invalidBody("board.default_workdir must be a string");
    }
    const res = await ctx.client.kanban.updateBoard(ctx.boardSlug, {
      default_workdir: boardPatch.default_workdir,
    });
    if (!res.ok) return pluginFailureResponse(res);
  }
  if (orchestrationPatch) {
    const res = await ctx.client.kanban.updateOrchestration(
      parseOrchestrationPatch(orchestrationPatch),
    );
    if (!res.ok) return pluginFailureResponse(res);
  }
  return buildSettingsResponse(ctx);
}

// ---------------------------------------------------------------------------
// Automation status — must show "why" even when the gate isn't cleared, so no 428/503 here.
// ---------------------------------------------------------------------------

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function getAutomationStatus(req: NextRequest, channelId: string) {
  const userId = getUserId(req);
  if (!userId) return cronError(401, "unauthorized", "unauthorized");
  const access = await requireChannelMember(channelId, userId);
  if (!access.ok) return access.response;

  const binding = await getChannelGatewayBinding(channelId);
  if (!binding) return cronError(409, "gateway_not_bound", "Channel has no gateway bound");

  // If the cache is stale, it's refreshed here. The judgment result itself isn't used — status is read from the cache.
  await ensureAutomationPlugin(binding.resource);
  const [gateway] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, binding.resource.id))
    .limit(1);
  const info = restorePluginInfo(gateway?.pluginInfoJson);
  const boardRow = await getChannelBoard(channelId);

  return NextResponse.json({
    pluginStatus: gateway?.pluginStatus ?? null,
    pluginVersion: gateway?.pluginVersion ?? info?.version ?? null,
    capabilities: info?.capabilities ?? [],
    timezone: info?.timezone ?? null,
    boardSlug: boardRow?.boardSlug ?? channelBoardSlug(channelId),
    dispatcherPresent: info?.kanban.dispatcher_present ?? false,
    attachments: info?.kanban.attachments ?? false,
    lastPolledAt: isoOrNull(boardRow?.lastPolledAt),
    lastError: boardRow?.lastError ?? null,
    minVersion: AUTOMATION_MIN_PLUGIN_VERSION,
    working: readWorkingSnapshot(channelId),
  });
}

// ---------------------------------------------------------------------------
// Resolving card proposals (T7)
// ---------------------------------------------------------------------------

export type ProposalParams = { params: Promise<{ id: string; proposalId: string }> };

/**
 * `POST .../kanban/proposals/{proposalId}/resolve` — body `{choice:"card"|"inline"}`.
 *
 * The judgment is made by `resolveProposal` (domain); the wiring is done by
 * `liveResolveDeps` (DB/plugin). All that happens here is parsing the body, wiring the
 * two together, mapping the result to a status code, and — when a card was created —
 * one dispatch + immediate polling (R9, R24).
 */
export async function resolveCardProposal(req: NextRequest, channelId: string, proposalId: string) {
  const body = await readJsonBody(req);
  if (!body) return invalidBody("JSON body required");
  const choice = body.choice;
  if (choice !== "card" && choice !== "inline") {
    return cronError(400, "invalid_field", "choice must be 'card' or 'inline'");
  }

  const { deps, gatedContext } = liveResolveDeps();
  const outcome = await resolveProposal(
    { channelId, userId: getUserId(req) ?? "", proposalId, choice },
    deps,
  );
  if (!outcome.ok) return proposalFailureResponse(outcome);

  if (outcome.choice === "inline") return NextResponse.json({ choice: "inline" });

  // A card was created, so do the same post-processing as the card creation route — reuse the gate already passed.
  const ctx = gatedContext();
  if (ctx) {
    await dispatchOnce(ctx);
    schedulePollNow(channelId);
  }
  return NextResponse.json({
    choice: "card",
    taskId: outcome.taskId,
    assigneeDropped: outcome.assigneeDropped,
  });
}
