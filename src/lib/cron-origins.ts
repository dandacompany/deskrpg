/**
 * `cron_job_origins` — the origin ledger for Hermes cron jobs that DeskRPG created.
 *
 * Hermes is the source of truth. Not a single character of the job content is copied
 * here — only "which channel, and who, created (gateway, profile, job id)" is kept
 * (R16). This ledger is the basis for the permission table: edit/pause/run/delete are
 * **origin channel members only**; jobs created by other channels or outside DeskRPG
 * (no origin) are read-only.
 *
 * The ledger is keyed by gateway id. If a channel switches to a different gateway, rows
 * from the old gateway are **ignored** for that channel (R4) — not deleted. They need to
 * be valid again if the channel switches back.
 */

import { and, eq, inArray } from "drizzle-orm";

import { cronJobOrigins, db, hermesProfiles } from "@/db";
import type { CronJob } from "@/lib/hermes/deskrpg-plugin-types";

export type CronOriginRow = typeof cronJobOrigins.$inferSelect;

/** The origin summary carried in the response. The client doesn't need the row id or gateway id. */
export type CronOrigin = { channelId: string; createdByUserId: string | null };

export type CronOriginKey = { gatewayId: string; profileName: string; jobId: string };

/** One response item — Hermes's job with the assigned NPC, origin, and editability layered on. */
export type EnrichedCronJob = CronJob & {
  npcId: string;
  npcName: string;
  origin: CronOrigin | null;
  editable: boolean;
};

function originMapKey(profileName: string, jobId: string): string {
  return `${profileName}\u0000${jobId}`;
}

/**
 * Records an origin. Overwrites if the same (gateway, profile, job id) already exists —
 * since Hermes job ids are unique, the only way the same key comes in again is reuse
 * ("deleted, then recreated with the same id"), and in that case the new origin is correct.
 *
 * **Only call this after the plugin call succeeds.** Recording it first and then failing
 * would leave behind the origin of a job that doesn't exist in Hermes, showing up as an
 * orphan on every list query.
 */
export async function recordCronOrigin(
  input: CronOriginKey & { channelId: string; createdByUserId: string | null },
): Promise<CronOriginRow> {
  await deleteCronOrigin(input);
  const [row] = await db
    .insert(cronJobOrigins)
    .values({
      gatewayId: input.gatewayId,
      profileName: input.profileName,
      jobId: input.jobId,
      channelId: input.channelId,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return row;
}

export async function findCronOrigin(key: CronOriginKey): Promise<CronOriginRow | null> {
  const [row] = await db
    .select()
    .from(cronJobOrigins)
    .where(
      and(
        eq(cronJobOrigins.gatewayId, key.gatewayId),
        eq(cronJobOrigins.profileName, key.profileName),
        eq(cronJobOrigins.jobId, key.jobId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Bundles all of one gateway's origin rows so they can be looked up by `(profile, job id)`. For listing. */
export async function loadCronOriginIndex(gatewayId: string): Promise<CronOriginIndex> {
  const rows = await db
    .select()
    .from(cronJobOrigins)
    .where(eq(cronJobOrigins.gatewayId, gatewayId));
  const map = new Map<string, CronOriginRow>();
  for (const row of rows) map.set(originMapKey(row.profileName, row.jobId), row);
  return {
    get: (profileName, jobId) => map.get(originMapKey(profileName, jobId)) ?? null,
  };
}

export type CronOriginIndex = {
  get(profileName: string, jobId: string): CronOriginRow | null;
};

export async function deleteCronOrigin(key: CronOriginKey): Promise<void> {
  await db
    .delete(cronJobOrigins)
    .where(
      and(
        eq(cronJobOrigins.gatewayId, key.gatewayId),
        eq(cronJobOrigins.profileName, key.profileName),
        eq(cronJobOrigins.jobId, key.jobId),
      ),
    );
}

/**
 * E3. Cleans up origin rows whose profile has vanished — deletes rows whose profile
 * name isn't in this gateway's `hermes_profiles`. Called on list queries. Returns the
 * number of rows deleted.
 *
 * Doesn't touch rows for a different gateway (R4 — that row is needed if the channel switches back to that gateway).
 */
export async function cleanupOrphanCronOrigins(gatewayId: string): Promise<number> {
  const [rows, profiles] = await Promise.all([
    db
      .select({ id: cronJobOrigins.id, profileName: cronJobOrigins.profileName })
      .from(cronJobOrigins)
      .where(eq(cronJobOrigins.gatewayId, gatewayId)),
    db
      .select({ profileName: hermesProfiles.profileName })
      .from(hermesProfiles)
      .where(eq(hermesProfiles.gatewayId, gatewayId)),
  ]);
  const live = new Set(profiles.map((p) => p.profileName));
  const orphanIds = rows.filter((r) => !live.has(r.profileName)).map((r) => r.id);
  if (orphanIds.length === 0) return 0;
  await db.delete(cronJobOrigins).where(inArray(cronJobOrigins.id, orphanIds));
  return orphanIds.length;
}

/**
 * R4. Treats the origin row as absent if it isn't for the channel's **current** gateway.
 * Listing, detail, and editable calculations must all go through this function, or an
 * old gateway's row could attach to a new gateway's same job id.
 */
export function resolveOriginForGateway(
  origin: CronOriginRow | null,
  currentGatewayId: string,
): CronOriginRow | null {
  if (!origin) return null;
  return origin.gatewayId === currentGatewayId ? origin : null;
}

/**
 * Permission table (R16): editable = an origin exists, it belongs to the current
 * gateway, and the origin channel matches the requesting channel. Membership is already
 * checked by the route, so only the channel is checked here.
 */
export function computeEditable(
  origin: CronOriginRow | null,
  channelId: string,
  currentGatewayId: string,
): boolean {
  const effective = resolveOriginForGateway(origin, currentGatewayId);
  return effective !== null && effective.channelId === channelId;
}

export function toCronOrigin(origin: CronOriginRow | null): CronOrigin | null {
  return origin ? { channelId: origin.channelId, createdByUserId: origin.createdByUserId } : null;
}

/** Layers the assigned NPC, origin, and editable onto Hermes's job. `origin` is the raw row (before the gateway filter). */
export function enrichJob(
  job: CronJob,
  ctx: {
    npcId: string;
    npcName: string;
    origin: CronOriginRow | null;
    channelId: string;
    currentGatewayId: string;
  },
): EnrichedCronJob {
  const effective = resolveOriginForGateway(ctx.origin, ctx.currentGatewayId);
  return {
    ...job,
    npcId: ctx.npcId,
    npcName: ctx.npcName,
    origin: toCronOrigin(effective),
    editable: computeEditable(effective, ctx.channelId, ctx.currentGatewayId),
  };
}
