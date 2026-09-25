/**
 * Gatekeeper for the artifacts REST API. Order: login → channel member → gateway (409) →
 * plugin gate → `artifacts` capability (428). Unlike kanban, a missing board row does not
 * block here — a channel without kanban can still have chat artifacts.
 * The channel scope is decided by the server: channel NPC profiles (including dormant
 * NPCs, on the current gateway) OR the channel board.
 */
import { and, eq, ne } from "drizzle-orm";
import type { NextResponse } from "next/server";

import { db, hermesProfiles, npcs } from "@/db";

import {
  cronError,
  gateError,
  pluginFailureResponse,
  pluginGateResponse,
  requireChannelMember,
} from "@/lib/cron-access";
import { ARTIFACTS_MIN_VERSION, type ArtifactDetail } from "@/lib/hermes/deskrpg-plugin-types";
import type { OwnerPluginClient } from "@/lib/hermes/plugin-client-types";
import { loadChannelRoster } from "@/lib/kanban-access";
import { resolveChannelBoard } from "@/lib/kanban-boards";

export type ArtifactChannelContext = {
  userId: string;
  channelId: string;
  /** The gateway currently bound to the channel (`gateway_resources.id`). */
  gatewayId: string;
  client: OwnerPluginClient;
  boardSlug: string;
  profiles: string[];
  pluginVersion: string;
};

type Result<T> = ({ ok: true } & T) | { ok: false; response: NextResponse };

export async function resolveArtifactChannelContext(input: {
  userId: string | null;
  channelId: string;
}): Promise<Result<{ ctx: ArtifactChannelContext }>> {
  if (!input.userId) return { ok: false, response: cronError(401, "unauthorized", "unauthorized") };
  const access = await requireChannelMember(input.channelId, input.userId);
  if (!access.ok) return access;
  const resolved = await resolveChannelBoard(input.channelId);
  if (!resolved.ok) {
    return {
      ok: false,
      response: gateError("gateway_not_bound", "Channel has no gateway bound"),
    };
  }
  if (!resolved.pluginGate.ok)
    return { ok: false, response: pluginGateResponse(resolved.pluginGate) };
  const info = resolved.pluginGate.info;
  if (!info.capabilities.includes("artifacts")) {
    return {
      ok: false,
      response: gateError(
        "plugin_upgrade_required",
        `deskrpg-hermes-plugin ${ARTIFACTS_MIN_VERSION}+ required`,
        {
          minVersion: ARTIFACTS_MIN_VERSION,
          missing: ["artifacts"],
        },
      ),
    };
  }
  const roster = await loadChannelRoster({
    channelId: input.channelId,
    gateway: resolved.binding.resource,
  });
  return {
    ok: true,
    ctx: {
      userId: input.userId,
      channelId: input.channelId,
      gatewayId: resolved.binding.resource.id,
      client: resolved.ownerClient,
      boardSlug: resolved.boardSlug,
      profiles: [...new Set(roster.map((r) => r.profileName))],
      pluginVersion: info.version,
    },
  };
}

export function inChannelScope(
  ctx: Pick<ArtifactChannelContext, "profiles" | "boardSlug">,
  a: { profile: string; board?: string | null },
): boolean {
  return ctx.profiles.includes(a.profile) || (!!a.board && a.board === ctx.boardSlug);
}

/** The plugin artifact id shape (`new_artifact_id` is 26 chars of [0-9a-z]). `.`, `..`, `/` become a different path via URL normalization. */
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidArtifactId(id: string): boolean {
  return ARTIFACT_ID_RE.test(id);
}

export function artifactNotFound(): NextResponse {
  return cronError(404, "artifact_not_found", "artifact not found");
}

/** Fetch one + verify scope. Out of scope counts as not found (404) — so guessing an id can't reach another channel. */
export async function loadScopedArtifact(
  ctx: ArtifactChannelContext,
  id: string,
): Promise<Result<{ detail: ArtifactDetail }>> {
  if (!isValidArtifactId(id)) return { ok: false, response: artifactNotFound() };
  const res = await ctx.client.artifacts.get(id);
  if (!res.ok) return { ok: false, response: pluginFailureResponse(res) };
  const artifact = (res.data as Partial<ArtifactDetail> | null)?.artifact;
  if (!artifact || !inChannelScope(ctx, artifact)) {
    return { ok: false, response: artifactNotFound() };
  }
  return { ok: true, detail: res.data };
}

/**
 * Edit/delete permission (user decision 2026-09-18). Reading covers the full channel
 * scope, but modifying is allowed only from the origin channel: a board artifact when it
 * belongs to this channel's board, and a boardless artifact when its profile is employed
 * on this gateway **only by this channel**. If multiple channels employ the same profile,
 * which channel produced a given chat artifact can't be known, so it's read-only in every channel.
 */
export async function canModifyArtifact(
  ctx: Pick<ArtifactChannelContext, "channelId" | "gatewayId" | "boardSlug" | "profiles">,
  artifact: { profile: string; board?: string | null },
): Promise<boolean> {
  if (artifact.board) return artifact.board === ctx.boardSlug;
  if (!ctx.profiles.includes(artifact.profile)) return false;
  const [elsewhere] = await db
    .select({ id: npcs.id })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(
      and(
        eq(hermesProfiles.gatewayId, ctx.gatewayId),
        eq(hermesProfiles.profileName, artifact.profile),
        ne(npcs.channelId, ctx.channelId),
      ),
    )
    .limit(1);
  return !elsewhere;
}

export function artifactReadOnly(): NextResponse {
  return cronError(
    403,
    "artifact_read_only_other_channel",
    "Artifacts from another channel are read-only here",
  );
}
