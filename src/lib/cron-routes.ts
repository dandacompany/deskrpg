/**
 * The shared body for the cron REST route handlers.
 *
 * Keep the route files (`src/app/api/channels/[id]/cron/**`) thin — the order of body
 * parsing, the gatekeeper (`cron-access.ts`), the origin ledger (`cron-origins.ts`), the
 * Hermes call, and response assembly is fixed here in one place. pause/resume/run/PUT/
 * DELETE all follow the same "origin channel members only" rule, so they're consolidated
 * into a single `mutateCronJob`.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { schedulePollNow } from "@/lib/automation-poll-trigger";
import {
  cronError,
  listNpcProfileClients,
  pluginFailureResponse,
  pluginFailureSummary,
  resolveCronChannelContext,
  resolveNpcProfileClient,
  type CronChannelContext,
  type NpcProfileClient,
} from "@/lib/cron-access";
import {
  cleanupOrphanCronOrigins,
  computeEditable,
  deleteCronOrigin,
  enrichJob,
  findCronOrigin,
  loadCronOriginIndex,
  recordCronOrigin,
  type EnrichedCronJob,
} from "@/lib/cron-origins";
import type {
  CreateCronJobBody,
  CronJob,
  InstantiateBlueprintBody,
  UpdateCronJobBody,
} from "@/lib/hermes/deskrpg-plugin-types";
import type { PluginResponse } from "@/lib/hermes/plugin-client-types";
import { getUserId } from "@/lib/internal-rpc";
import { readJsonObject } from "@/lib/api-body";

export type RouteParams = { params: Promise<{ id: string; jobId?: string }> };

// ---------------------------------------------------------------------------
// Body / query
// ---------------------------------------------------------------------------

type JsonBody = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidBody(message: string) {
  return cronError(400, "invalid_body", message);
}

/**
 * R17 create body. `npcId` is stripped off here — it must not leak into the body sent
 * to Hermes. Since the preset-to-expression conversion happens client-side, `schedule`
 * is passed through as a plain string. `prompt` is required unless this is a
 * script-only job (has `script`) — a 400 if both are empty.
 */
export function parseCreateBody(
  body: JsonBody,
): { ok: true; npcId: string; job: CreateCronJobBody } | { ok: false; response: NextResponse } {
  const npcId = requiredString(body.npcId);
  if (!npcId) return { ok: false, response: invalidBody("npcId is required") };
  const name = requiredString(body.name);
  const prompt = requiredString(body.prompt);
  const script = requiredString(body.script);
  const schedule = optionalString(body.schedule);
  if (!name || schedule === undefined) {
    return { ok: false, response: invalidBody("name and schedule are required") };
  }
  if (!prompt && !script) {
    return { ok: false, response: invalidBody("prompt is required unless script is given") };
  }
  const skills = Array.isArray(body.skills)
    ? body.skills.filter((s): s is string => typeof s === "string")
    : undefined;
  const job: CreateCronJobBody = {
    name,
    ...(prompt ? { prompt } : {}),
    ...(script ? { script } : {}),
    schedule,
    deliver: optionalString(body.deliver) ?? "local",
    ...(optionalString(body.model) !== undefined ? { model: body.model as string } : {}),
    ...(optionalString(body.provider) !== undefined ? { provider: body.provider as string } : {}),
    ...(skills ? { skills } : {}),
    ...(typeof body.paused === "boolean" ? { paused: body.paused } : {}),
    ...(typeof body.repeat === "boolean" ? { repeat: body.repeat } : {}),
  };
  return { ok: true, npcId, job };
}

/** R17 update body — `{npcId, updates:{...}}`. Unknown keys are dropped. */
export function parseUpdateBody(
  body: JsonBody,
): { ok: true; npcId: string; update: UpdateCronJobBody } | { ok: false; response: NextResponse } {
  const npcId = requiredString(body.npcId);
  if (!npcId) return { ok: false, response: invalidBody("npcId is required") };
  const raw = body.updates;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, response: invalidBody("updates must be an object") };
  }
  const src = raw as JsonBody;
  const updates: UpdateCronJobBody["updates"] = {};
  if (typeof src.schedule === "string") updates.schedule = src.schedule;
  if (typeof src.prompt === "string") updates.prompt = src.prompt;
  if (typeof src.name === "string") updates.name = src.name;
  if (typeof src.deliver === "string") updates.deliver = src.deliver;
  if ("model" in src && (typeof src.model === "string" || src.model === null)) {
    updates.model = src.model;
  }
  if ("provider" in src && (typeof src.provider === "string" || src.provider === null)) {
    updates.provider = src.provider;
  }
  if (typeof src.enabled === "boolean") updates.enabled = src.enabled;
  return { ok: true, npcId, update: { updates } };
}

/** R21 instantiate body — `{npcId, blueprint, values}`. */
export function parseInstantiateBody(
  body: JsonBody,
):
  | { ok: true; npcId: string; request: InstantiateBlueprintBody }
  | { ok: false; response: NextResponse } {
  const npcId = requiredString(body.npcId);
  if (!npcId) return { ok: false, response: invalidBody("npcId is required") };
  const blueprint = requiredString(body.blueprint);
  if (!blueprint) return { ok: false, response: invalidBody("blueprint is required") };
  const values: Record<string, string> = {};
  if (typeof body.values === "object" && body.values !== null && !Array.isArray(body.values)) {
    for (const [key, value] of Object.entries(body.values as JsonBody)) {
      if (typeof value === "string") values[key] = value;
    }
  }
  return { ok: true, npcId, request: { blueprint, values } };
}

/** `?npcId=` — how a bodyless GET/DELETE specifies the assigned NPC. */
export function readNpcIdParam(req: NextRequest): string | null {
  const value = req.nextUrl.searchParams.get("npcId");
  return value && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Shared flow
// ---------------------------------------------------------------------------

type Resolved = { ctx: CronChannelContext; npc: NpcProfileClient };

/** Login -> member -> gateway -> plugin gate -> NPC. Returns a response if blocked anywhere. */
export async function resolveCronRequest(
  req: NextRequest,
  channelId: string,
  npcId: string | null,
): Promise<{ ok: true; value: Resolved } | { ok: false; response: NextResponse }> {
  const context = await resolveCronChannelContext({ userId: getUserId(req), channelId });
  if (!context.ok) return context;
  if (!npcId) return { ok: false, response: invalidBody("npcId is required") };
  const npc = await resolveNpcProfileClient(context.ctx, npcId);
  if (!npc.ok) return npc;
  return { ok: true, value: { ctx: context.ctx, npc: npc.value } };
}

async function enrichOne({ ctx, npc }: Resolved, job: CronJob): Promise<EnrichedCronJob> {
  const origin = await findCronOrigin({
    gatewayId: ctx.gateway.id,
    profileName: npc.profile.profileName,
    jobId: job.id,
  });
  return enrichJob(job, {
    npcId: npc.npc.id,
    npcName: npc.npcName,
    origin,
    channelId: ctx.channelId,
    currentGatewayId: ctx.gateway.id,
  });
}

/** After create/instantiate — only when the plugin succeeds, record the origin and return 201. */
async function createdJobResponse(resolved: Resolved, res: PluginResponse<{ job: CronJob }>) {
  if (!res.ok) return pluginFailureResponse(res);
  const { ctx, npc } = resolved;
  await recordCronOrigin({
    gatewayId: ctx.gateway.id,
    profileName: npc.profile.profileName,
    jobId: res.data.job.id,
    channelId: ctx.channelId,
    createdByUserId: ctx.userId,
  });
  // R24. Poll immediately right after the mutation — don't wait.
  schedulePollNow(ctx.channelId);
  return NextResponse.json({ job: await enrichOne(resolved, res.data.job) }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Handler bodies
// ---------------------------------------------------------------------------

export async function listCronJobs(req: NextRequest, channelId: string) {
  const context = await resolveCronChannelContext({ userId: getUserId(req), channelId });
  if (!context.ok) return context.response;
  const ctx = context.ctx;

  // E3. Clean up origin rows whose profile has vanished while listing.
  await cleanupOrphanCronOrigins(ctx.gateway.id);

  const npcIdFilter = readNpcIdParam(req);
  let targets: NpcProfileClient[];
  if (npcIdFilter) {
    const one = await resolveNpcProfileClient(ctx, npcIdFilter);
    if (!one.ok) return one.response;
    targets = [one.value];
  } else {
    targets = await listNpcProfileClients(ctx);
  }

  const origins = await loadCronOriginIndex(ctx.gateway.id);
  const jobs: EnrichedCronJob[] = [];
  const errors: Array<{ npcId: string; code: string; message: string }> = [];

  // Call per profile separately — if one is down, the rest of the list must still survive.
  const results = await Promise.all(
    targets.map(async (npc) => ({
      npc,
      res: await npc.client.cron.listJobs({ includeDisabled: true }),
    })),
  );
  for (const { npc, res } of results) {
    if (!res.ok) {
      errors.push({ npcId: npc.npc.id, ...pluginFailureSummary(res) });
      continue;
    }
    for (const job of res.data.jobs) {
      jobs.push(
        enrichJob(job, {
          npcId: npc.npc.id,
          npcName: npc.npcName,
          origin: origins.get(npc.profile.profileName, job.id),
          channelId: ctx.channelId,
          currentGatewayId: ctx.gateway.id,
        }),
      );
    }
  }

  return NextResponse.json({
    jobs,
    timezone: ctx.timezone,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

export async function getCronJob(req: NextRequest, channelId: string, jobId: string) {
  const resolved = await resolveCronRequest(req, channelId, readNpcIdParam(req));
  if (!resolved.ok) return resolved.response;
  const res = await resolved.value.npc.client.cron.getJob(jobId);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({
    job: await enrichOne(resolved.value, res.data.job),
    timezone: resolved.value.ctx.timezone,
  });
}

const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 200;

export async function listCronJobRuns(req: NextRequest, channelId: string, jobId: string) {
  const resolved = await resolveCronRequest(req, channelId, readNpcIdParam(req));
  if (!resolved.ok) return resolved.response;
  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_RUNS_LIMIT)
      : DEFAULT_RUNS_LIMIT;
  const res = await resolved.value.npc.client.cron.listRuns(jobId, { limit });
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ runs: res.data.runs, limit });
}

export async function createCronJob(req: NextRequest, channelId: string) {
  const body = await readJsonObject(req);
  if (!body) return invalidBody("JSON body required");
  const parsed = parseCreateBody(body);
  if (!parsed.ok) return parsed.response;
  const resolved = await resolveCronRequest(req, channelId, parsed.npcId);
  if (!resolved.ok) return resolved.response;
  return createdJobResponse(
    resolved.value,
    await resolved.value.npc.client.cron.createJob(parsed.job),
  );
}

export async function instantiateCronBlueprint(req: NextRequest, channelId: string) {
  const body = await readJsonObject(req);
  if (!body) return invalidBody("JSON body required");
  const parsed = parseInstantiateBody(body);
  if (!parsed.ok) return parsed.response;
  const resolved = await resolveCronRequest(req, channelId, parsed.npcId);
  if (!resolved.ok) return resolved.response;
  return createdJobResponse(
    resolved.value,
    await resolved.value.npc.client.cron.instantiateBlueprint(parsed.request),
  );
}

export async function listCronDeliveryTargets(req: NextRequest, channelId: string) {
  const resolved = await resolveCronRequest(req, channelId, readNpcIdParam(req));
  if (!resolved.ok) return resolved.response;
  const res = await resolved.value.npc.client.cron.listDeliveryTargets();
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ targets: res.data.targets });
}

export async function listCronBlueprints(req: NextRequest, channelId: string) {
  const resolved = await resolveCronRequest(req, channelId, readNpcIdParam(req));
  if (!resolved.ok) return resolved.response;
  const res = await resolved.value.npc.client.cron.listBlueprints();
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ blueprints: res.data.blueprints });
}

// ---------------------------------------------------------------------------
// Mutations — origin channel members only (R16)
// ---------------------------------------------------------------------------

export type CronMutation =
  | { kind: "update"; update: UpdateCronJobBody }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "run" }
  | { kind: "delete" };

/**
 * The shared body for edit, pause, resume, run, and delete. If the origin isn't this
 * channel's (and the current gateway's), it's a 403 `cron_read_only` — this ends
 * **before Hermes is ever called.** If delete succeeds, the origin row is deleted too.
 */
export async function mutateCronJob(
  req: NextRequest,
  channelId: string,
  jobId: string,
  npcId: string | null,
  mutation: CronMutation,
) {
  const resolved = await resolveCronRequest(req, channelId, npcId);
  if (!resolved.ok) return resolved.response;
  const { ctx, npc } = resolved.value;

  const key = { gatewayId: ctx.gateway.id, profileName: npc.profile.profileName, jobId };
  const origin = await findCronOrigin(key);
  if (!computeEditable(origin, ctx.channelId, ctx.gateway.id)) {
    return cronError(
      403,
      "cron_read_only",
      "This cron job can only be changed from the channel it was created in",
    );
  }

  const cron = npc.client.cron;
  switch (mutation.kind) {
    case "update": {
      const res = await cron.updateJob(jobId, mutation.update);
      if (!res.ok) return pluginFailureResponse(res);
      schedulePollNow(ctx.channelId);
      return NextResponse.json({ job: await enrichOne(resolved.value, res.data.job) });
    }
    case "pause":
    case "resume": {
      const res =
        mutation.kind === "pause" ? await cron.pauseJob(jobId) : await cron.resumeJob(jobId);
      if (!res.ok) return pluginFailureResponse(res);
      schedulePollNow(ctx.channelId);
      return NextResponse.json({ job: await enrichOne(resolved.value, res.data.job) });
    }
    case "run": {
      // R19. Just submit the request and return right away — the result is seen via history (runs)/events.
      const res = await cron.runJob(jobId);
      if (!res.ok) return pluginFailureResponse(res);
      schedulePollNow(ctx.channelId);
      return NextResponse.json({ accepted: true }, { status: 202 });
    }
    case "delete": {
      const res = await cron.deleteJob(jobId);
      if (!res.ok) return pluginFailureResponse(res);
      await deleteCronOrigin(key);
      schedulePollNow(ctx.channelId);
      return NextResponse.json({ ok: true });
    }
  }
}

/** A mutation (pause/resume/run) that reads only `npcId` from the body. */
export async function mutateFromBody(
  req: NextRequest,
  channelId: string,
  jobId: string,
  mutation: CronMutation,
) {
  const body = await readJsonObject(req);
  const npcId = body ? requiredString(body.npcId) : null;
  return mutateCronJob(req, channelId, jobId, npcId, mutation);
}
