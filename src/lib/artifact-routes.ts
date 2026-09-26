/**
 * Artifact REST — list·detail. The gatekeeper is `artifact-access.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  artifactNotFound,
  artifactReadOnly,
  canModifyArtifact,
  isValidArtifactId,
  loadScopedArtifact,
  resolveArtifactChannelContext,
} from "@/lib/artifact-access";
import { cronError, gateError, pluginFailureResponse } from "@/lib/cron-access";
import {
  ARTIFACT_CATEGORIES,
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
  ARTIFACTS_TASK_FILTER_MIN_VERSION,
  type ArtifactCategory,
} from "@/lib/hermes/deskrpg-plugin-types";
import { rawFailureResponse, streamProxyResponse } from "@/lib/hermes/stream-proxy";
import { compareSemver } from "@/lib/hermes/plugin-capability";
import { getUserId } from "@/lib/internal-rpc";
import { taskTimeMs } from "@/lib/plugin-time";
import { readSessionSources } from "@/lib/session-sources";
import { and, eq } from "drizzle-orm";

import { db, hermesProfiles } from "@/db";
import {
  buildArtifactProvenance,
  provenanceProfile,
  PROVENANCE_PARENTS_MAX,
  type ArtifactProvenance,
} from "@/lib/artifact-provenance";
import type { ArtifactChannelContext } from "@/lib/artifact-access";
import type { ArtifactSummary } from "@/lib/hermes/deskrpg-plugin-types";

export type ArtifactParams = { params: Promise<{ id: string; artifactId?: string; v?: string }> };

const LIMIT_MAX = 200;
const MAX_EDIT_CHARS = 5_000_000;

function resolve(req: NextRequest, channelId: string) {
  return resolveArtifactChannelContext({ userId: getUserId(req), channelId });
}

export async function listArtifacts(req: NextRequest, channelId: string): Promise<Response> {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  const { ctx } = resolved;
  const sp = req.nextUrl.searchParams;
  const kindParam = sp.get("kind") || undefined;
  const categoryParam = sp.get("category") || undefined;
  const source = sp.get("source") || undefined;
  const profile = sp.get("profile") || undefined;
  const taskId = sp.get("taskId") || undefined;
  const q = (sp.get("q") || "").slice(0, 200) || undefined;
  const rawLimit = Number(sp.get("limit"));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, LIMIT_MAX) : 50;
  // The screen's tabs (all/media/files/links) arrive as `category`, expanded here into the
  // plugin's comma-separated kind list. `kind` is kept because old single-kind= callers must
  // keep working — giving both is ambiguous, so it's a 400.
  if (kindParam && categoryParam) return cronError(400, "invalid_field", "category");
  if (categoryParam && !(categoryParam in ARTIFACT_CATEGORIES))
    return cronError(400, "invalid_field", "category");
  if (kindParam && !(ARTIFACT_KINDS as readonly string[]).includes(kindParam))
    return cronError(400, "invalid_field", "kind");
  const kind = categoryParam
    ? ARTIFACT_CATEGORIES[categoryParam as ArtifactCategory].join(",")
    : kindParam;
  if (source && !(ARTIFACT_SOURCES as readonly string[]).includes(source)) {
    return cronError(400, "invalid_field", "source");
  }
  if (profile && !ctx.profiles.includes(profile)) return cronError(400, "invalid_field", "profile");
  if (taskId && (compareSemver(ctx.pluginVersion, ARTIFACTS_TASK_FILTER_MIN_VERSION) ?? -1) < 0) {
    return gateError(
      "plugin_upgrade_required",
      `deskrpg-hermes-plugin ${ARTIFACTS_TASK_FILTER_MIN_VERSION}+ required`,
      { minVersion: ARTIFACTS_TASK_FILTER_MIN_VERSION },
    );
  }
  // If an NPC was picked, only that profile (the board OR must be dropped so other NPCs' cards don't mix in). Otherwise, the whole channel scope.
  const res = await ctx.client.artifacts.list({
    profiles: profile ? [profile] : ctx.profiles,
    board: profile ? undefined : ctx.boardSlug,
    kind,
    source,
    q,
    cursor: sp.get("cursor") || undefined,
    limit,
    taskId,
  });
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data);
}

/**
 * The card an artifact came from, its run and its parent cards — only for an artifact of this
 * channel's board. Failing to read the card leaves the provenance out; the detail still opens.
 */
async function loadProvenance(
  ctx: ArtifactChannelContext,
  artifact: ArtifactSummary,
): Promise<ArtifactProvenance | null> {
  if (artifact.source_kind !== "kanban" || !artifact.task_id || artifact.board !== ctx.boardSlug) {
    return null;
  }
  const board = ctx.boardSlug;
  const res = await ctx.client.kanban.getTask(board, artifact.task_id);
  if (!res.ok || !res.data?.task) return null;
  const parentIds = (res.data.links?.parents ?? []).slice(0, PROVENANCE_PARENTS_MAX);
  const parents = await Promise.all(
    parentIds.map(async (id) => {
      const parent = await ctx.client.kanban.getTask(board, id);
      if (!parent.ok || !parent.data?.task) return null;
      const { title, status } = parent.data.task;
      return { id, title, status };
    }),
  );
  const createdAt = taskTimeMs(artifact.created_at);
  const profile = provenanceProfile(res.data, createdAt);
  const [named] = profile
    ? await db
        .select({ displayName: hermesProfiles.displayName })
        .from(hermesProfiles)
        .where(
          and(eq(hermesProfiles.gatewayId, ctx.gatewayId), eq(hermesProfiles.profileName, profile)),
        )
        .limit(1)
    : [];
  const displayName = named?.displayName?.trim() || null;
  return buildArtifactProvenance(res.data, createdAt, parents, () => displayName);
}

export async function getArtifact(
  req: NextRequest,
  channelId: string,
  artifactId: string,
): Promise<Response> {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!isValidArtifactId(artifactId)) return artifactNotFound();
  const loaded = await loadScopedArtifact(resolved.ctx, artifactId);
  if (!loaded.ok) return loaded.response;
  const { artifact } = loaded.detail;
  const [modifiable, provenance] = await Promise.all([
    canModifyArtifact(resolved.ctx, artifact),
    loadProvenance(resolved.ctx, artifact),
  ]);
  // A signal the screen uses to decide whether to hide edit·delete·move-source. Permission itself is re-checked by the mutation route.
  return NextResponse.json({
    ...loaded.detail,
    modifiable,
    sourceInChannel: artifact.source_kind !== "kanban" || artifact.board === resolved.ctx.boardSlug,
    ...(provenance ? { provenance } : {}),
  });
}

/** What the session that made the artifact read. Expected states (expired, unavailable) are 200 values. */
export async function getArtifactSources(
  req: NextRequest,
  channelId: string,
  artifactId: string,
): Promise<Response> {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!isValidArtifactId(artifactId)) return artifactNotFound();
  const loaded = await loadScopedArtifact(resolved.ctx, artifactId);
  if (!loaded.ok) return loaded.response;
  const { ctx } = resolved;
  const { artifact } = loaded.detail;
  const read = await readSessionSources({
    gateway: { id: ctx.gatewayId, baseUrl: ctx.gatewayBaseUrl },
    capabilities: ctx.capabilities,
    profileName: artifact.profile,
    sessionId: artifact.session_id,
  });
  return read.ok ? NextResponse.json(read.view) : read.response;
}

export async function getArtifactContent(
  req: NextRequest,
  channelId: string,
  artifactId: string,
  v: string,
): Promise<Response> {
  if (!/^\d{1,9}$/.test(v)) return cronError(400, "invalid_field", "v");
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!isValidArtifactId(artifactId)) return artifactNotFound();
  const loaded = await loadScopedArtifact(resolved.ctx, artifactId);
  if (!loaded.ok) return loaded.response;
  const res = await resolved.ctx.client.artifacts.content(artifactId, Number(v), {
    download: req.nextUrl.searchParams.get("download") === "1",
    range: req.headers.get("range"),
  });
  if (!res.ok) return rawFailureResponse(res);
  return streamProxyResponse(res.response);
}

export async function addArtifactVersion(
  req: NextRequest,
  channelId: string,
  artifactId: string,
): Promise<Response> {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!isValidArtifactId(artifactId)) return artifactNotFound();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return cronError(400, "invalid_json", "body must be JSON");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.content !== "string" || typeof b.filename !== "string" || !b.filename.trim()) {
    return cronError(400, "missing_field", "content, filename");
  }
  if (b.content.length > MAX_EDIT_CHARS)
    return cronError(413, "artifact_too_large", "content too large");
  const note = typeof b.note === "string" ? b.note.slice(0, 400) : undefined;
  const loaded = await loadScopedArtifact(resolved.ctx, artifactId);
  if (!loaded.ok) return loaded.response;
  if (!(await canModifyArtifact(resolved.ctx, loaded.detail.artifact))) return artifactReadOnly();
  const res = await resolved.ctx.client.artifacts.addVersion(
    artifactId,
    { content: b.content, filename: b.filename.trim().slice(0, 200), ...(note ? { note } : {}) },
    resolved.ctx.userId,
  );
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json(res.data, { status: 201 });
}

export async function deleteArtifact(
  req: NextRequest,
  channelId: string,
  artifactId: string,
): Promise<Response> {
  const resolved = await resolve(req, channelId);
  if (!resolved.ok) return resolved.response;
  if (!isValidArtifactId(artifactId)) return artifactNotFound();
  const loaded = await loadScopedArtifact(resolved.ctx, artifactId);
  if (!loaded.ok) return loaded.response;
  if (!(await canModifyArtifact(resolved.ctx, loaded.detail.artifact))) return artifactReadOnly();
  const res = await resolved.ctx.client.artifacts.remove(artifactId, resolved.ctx.userId);
  if (!res.ok) return pluginFailureResponse(res);
  return NextResponse.json({ ok: true });
}
