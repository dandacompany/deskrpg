/** Used by a save that leaves the key as-is — finds my gateway by address alone. */

import { withChannelAutomationLock } from "./channel-automation-lock";
import { recoverEventCarrierHandoff } from "./event-carrier-handoff";
import crypto from "node:crypto";

import { and, count, eq, inArray } from "drizzle-orm";

import {
  channelGatewayBindings,
  channels,
  db,
  gatewayResources,
  gatewayShares,
  isPostgres,
  meetingMinutes,
  users,
} from "@/db";
import {
  type GatewayRuntimeStatus,
  getCachedGatewayRuntimeState,
  invalidateGatewayRuntimeState,
  setGatewayRuntimeState,
} from "@/lib/gateway-runtime-cache";
import { restorePluginInfo } from "@/lib/hermes/plugin-cache-update";
import { supportsProfileClone } from "@/lib/hermes/plugin-capability";
import { workerPluginWarning, type WorkerPluginWarning } from "@/lib/hermes/worker-plugin";
import type { WorkerPropagation } from "@/lib/hermes/deskrpg-plugin-types";

type GatewayShareRow = typeof gatewayShares.$inferSelect;

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

import { selectChannelNpcs } from "./npc-projection";
// This is a circular import (kanban-boards → this file's getChannelGatewayBinding/decryptGatewayToken).
// Safe because it's only called inside a function, never used at module evaluation time.
import { ensureChannelBoard } from "./kanban-boards";
import { probeHermesGateway } from "@/lib/hermes/gateway-probe";
import { DEV_JWT_SECRET } from "./dev-constants";

function getGatewayCipherKey() {
  // Priority: INTERNAL_RPC_SECRET > JWT_SECRET > dev fallback
  // In production, gateway cipher and JWT auth may use different secrets (separate concerns).
  const source =
    process.env.INTERNAL_RPC_SECRET ||
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV !== "production" ? DEV_JWT_SECRET : "");
  if (!source) {
    throw new Error("Missing JWT_SECRET or INTERNAL_RPC_SECRET for gateway token encryption");
  }
  return crypto.createHash("sha256").update(source).digest();
}

export function normalizeGatewayBaseUrl(url: string) {
  const parsed = new URL(url);
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function encryptGatewayToken(token: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getGatewayCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptGatewayToken(payload: string) {
  const [version, ivB64, tagB64, encryptedB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Invalid gateway token payload");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getGatewayCipherKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function buildDefaultGatewayDisplayName(baseUrl: string) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

async function findOwnedGatewayByBaseUrl(ownerUserId: string, baseUrl: string) {
  const [row] = await db
    .select()
    .from(gatewayResources)
    .where(
      and(eq(gatewayResources.ownerUserId, ownerUserId), eq(gatewayResources.baseUrl, baseUrl)),
    )
    .limit(1);
  return row ?? null;
}

async function findMatchingOwnedGateway(ownerUserId: string, baseUrl: string, token: string) {
  const rows = await db
    .select()
    .from(gatewayResources)
    .where(
      and(eq(gatewayResources.ownerUserId, ownerUserId), eq(gatewayResources.baseUrl, baseUrl)),
    );

  return (
    rows.find((row) => {
      try {
        return decryptGatewayToken(row.tokenEncrypted) === token;
      } catch {
        return false;
      }
    }) ?? null
  );
}

/**
 * If `token` is omitted (=undefined), the already-stored key is left as-is. Since the
 * screen no longer gets the existing key back, a save that only edits the URL must never
 * overwrite the key with an empty value.
 */
export async function upsertOwnedGatewayResource(input: {
  ownerUserId: string;
  baseUrl: string;
  token?: string;
  displayName?: string | null;
}) {
  const baseUrl = normalizeGatewayBaseUrl(input.baseUrl);
  const keepExistingToken = input.token === undefined;
  const token = (input.token ?? "").trim();
  const displayName = input.displayName?.trim() || buildDefaultGatewayDisplayName(baseUrl);
  const existing = keepExistingToken
    ? await findOwnedGatewayByBaseUrl(input.ownerUserId, baseUrl)
    : await findMatchingOwnedGateway(input.ownerUserId, baseUrl, token);

  if (existing) {
    const [updated] = await db
      .update(gatewayResources)
      .set({
        displayName,
        ...(keepExistingToken ? {} : { tokenEncrypted: encryptGatewayToken(token) }),
        updatedAt: nowForDb(),
      })
      .where(eq(gatewayResources.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: input.ownerUserId,
      displayName,
      baseUrl,
      tokenEncrypted: encryptGatewayToken(token),
    })
    .returning();

  return created;
}

export async function getAccessibleGatewayResource(userId: string, gatewayId: string) {
  const [resource] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, gatewayId))
    .limit(1);

  if (!resource) return null;
  if (resource.ownerUserId === userId) {
    return { resource, share: null as GatewayShareRow | null, isOwner: true };
  }

  const [share] = await db
    .select()
    .from(gatewayShares)
    .where(and(eq(gatewayShares.gatewayId, gatewayId), eq(gatewayShares.userId, userId)))
    .limit(1);

  if (!share) return null;
  return { resource, share, isOwner: false };
}

export async function getOwnedGatewayResource(ownerUserId: string, gatewayId: string) {
  const [resource] = await db
    .select()
    .from(gatewayResources)
    .where(and(eq(gatewayResources.id, gatewayId), eq(gatewayResources.ownerUserId, ownerUserId)))
    .limit(1);
  return resource ?? null;
}

export async function listAccessibleGatewayResources(userId: string) {
  const owned = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.ownerUserId, userId));

  const shares = await db.select().from(gatewayShares).where(eq(gatewayShares.userId, userId));

  const sharedIds = shares.map((share) => share.gatewayId);
  const sharedResources =
    sharedIds.length > 0
      ? await db.select().from(gatewayResources).where(inArray(gatewayResources.id, sharedIds))
      : [];

  return [
    ...owned.map((resource) => ({
      id: resource.id,
      displayName: resource.displayName,
      baseUrl: resource.baseUrl,
      ownerUserId: resource.ownerUserId,
      lastValidatedAt: resource.lastValidatedAt,
      lastValidationStatus: resource.lastValidationStatus,
      lastValidationError: resource.lastValidationError,
      // Final review I-1: no consumer read this cache (a Task 4/9 output), so
      // HermesProfileList unconditionally re-hit /test on every screen entry (2 remote
      // round trips + a DB UPDATE, up to 10s). It must be returned here so
      // `shouldReprobePlugin` can judge whether the cache is fresh.
      pluginStatus: resource.pluginStatus,
      pluginVersion: resource.pluginVersion,
      pluginCheckedAt: resource.pluginCheckedAt,
      // The Hermes dashboard is a management screen covering the whole gateway, so only the owner is told about it.
      dashboardUrl: restorePluginInfo(resource.pluginInfoJson)?.dashboard_url ?? null,
      // Only the owner creates employees. The hiring wizard sends `cloneFrom: "default"`
      // only when the plugin supports default-profile cloning — an unknown field is never sent to an older version.
      supportsProfileClone: supportsProfileClone(restorePluginInfo(resource.pluginInfoJson)),
      // An employee whose kanban/cron artifacts aren't accumulating. Fixing it is also owner-only, so only the owner is told.
      workerPluginWarning: workerPluginWarning(restorePluginInfo(resource.pluginInfoJson)),
      // The 0.16.0 worker-propagation opt-in state. Carried separately so "it's off" is surfaced even with no missing employees (null on an older plugin).
      workerPropagation: (restorePluginInfo(resource.pluginInfoJson)?.worker_plugin?.propagation ??
        null) as WorkerPropagation | null,
      canEditCredentials: true,
      shareRole: null as string | null,
      isOwner: true,
    })),
    ...sharedResources.map((resource) => {
      const share = shares.find((entry) => entry.gatewayId === resource.id) ?? null;
      return {
        id: resource.id,
        displayName: resource.displayName,
        baseUrl: resource.baseUrl,
        ownerUserId: resource.ownerUserId,
        lastValidatedAt: resource.lastValidatedAt,
        lastValidationStatus: resource.lastValidationStatus,
        lastValidationError: resource.lastValidationError,
        pluginStatus: resource.pluginStatus,
        pluginVersion: resource.pluginVersion,
        pluginCheckedAt: resource.pluginCheckedAt,
        dashboardUrl: null as string | null,
        workerPluginWarning: null as WorkerPluginWarning | null,
        workerPropagation: null as WorkerPropagation | null,
        canEditCredentials: false,
        shareRole: share?.role ?? null,
        isOwner: false,
      };
    }),
  ];
}

export async function listGatewaySharesForOwner(ownerUserId: string, gatewayId: string) {
  const resource = await getOwnedGatewayResource(ownerUserId, gatewayId);
  if (!resource) return null;

  const shares = await db
    .select({
      id: gatewayShares.id,
      userId: gatewayShares.userId,
      role: gatewayShares.role,
      createdAt: gatewayShares.createdAt,
      loginId: users.loginId,
      nickname: users.nickname,
    })
    .from(gatewayShares)
    .innerJoin(users, eq(gatewayShares.userId, users.id))
    .where(eq(gatewayShares.gatewayId, gatewayId));

  return { resource, shares };
}

export async function createGatewayShare(input: {
  ownerUserId: string;
  gatewayId: string;
  targetLoginId: string;
  role?: string;
}) {
  const resource = await getOwnedGatewayResource(input.ownerUserId, input.gatewayId);
  if (!resource) return { resource: null, targetUser: null, share: null };

  const [targetUser] = await db
    .select({ id: users.id, loginId: users.loginId, nickname: users.nickname })
    .from(users)
    .where(eq(users.loginId, input.targetLoginId))
    .limit(1);

  if (!targetUser || targetUser.id === input.ownerUserId) {
    return { resource, targetUser: targetUser ?? null, share: null };
  }

  const existing = await db
    .select()
    .from(gatewayShares)
    .where(
      and(eq(gatewayShares.gatewayId, input.gatewayId), eq(gatewayShares.userId, targetUser.id)),
    )
    .limit(1);

  const role = input.role?.trim() || "use";
  if (existing[0]) {
    const [updated] = await db
      .update(gatewayShares)
      .set({ role })
      .where(eq(gatewayShares.id, existing[0].id))
      .returning();
    return { resource, targetUser, share: updated };
  }

  const [created] = await db
    .insert(gatewayShares)
    .values({
      gatewayId: input.gatewayId,
      userId: targetUser.id,
      role,
    })
    .returning();

  return { resource, targetUser, share: created };
}

export async function removeGatewayShare(input: {
  ownerUserId: string;
  gatewayId: string;
  targetUserId: string;
}) {
  const resource = await getOwnedGatewayResource(input.ownerUserId, input.gatewayId);
  if (!resource) return false;

  await db
    .delete(gatewayShares)
    .where(
      and(
        eq(gatewayShares.gatewayId, input.gatewayId),
        eq(gatewayShares.userId, input.targetUserId),
      ),
    );

  return true;
}

export async function countChannelBindingsForGateway(gatewayId: string) {
  const [{ value }] = await db
    .select({ value: count() })
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.gatewayId, gatewayId));

  return value;
}

/** Shows a user trying to delete a gateway "what's blocking it, and what disappears if unblocked". */
export type GatewayChannelBinding = {
  channelId: string;
  channelName: string;
  /** Is the requester the owner of this channel? Only the channel owner can unbind. */
  canUnbind: boolean;
  /** Count of NPCs that go dormant (`active=false`) if the binding is removed. They are not deleted. */
  npcCount: number;
  meetingMinutesCount: number;
};

/**
 * The channels bound to this gateway. Exists so that when a delete is rejected with 409,
 * "which channel is blocking it" can be answered by name — reporting only a count would
 * make the user hunt for the channel.
 */
export async function listChannelBindingsForGateway(
  gatewayId: string,
  requesterUserId: string,
): Promise<GatewayChannelBinding[]> {
  const rows = await db
    .select({ channelId: channels.id, channelName: channels.name, ownerId: channels.ownerId })
    .from(channelGatewayBindings)
    .innerJoin(channels, eq(channels.id, channelGatewayBindings.channelId))
    .where(eq(channelGatewayBindings.gatewayId, gatewayId));

  return Promise.all(
    rows.map(async (row) => {
      // The count also goes through the projection — so the screen's "N employees" and the
      // roster (`/api/npcs?roster=1`) count the same set.
      const npcCount = (await selectChannelNpcs(row.channelId, { roster: true })).length;
      const [{ value: meetingMinutesCount }] = await db
        .select({ value: count() })
        .from(meetingMinutes)
        .where(eq(meetingMinutes.channelId, row.channelId));
      return {
        channelId: row.channelId,
        channelName: row.channelName,
        canUnbind: row.ownerId === requesterUserId,
        npcCount,
        meetingMinutesCount,
      };
    }),
  );
}

export async function getChannelGatewayBinding(channelId: string) {
  const [binding] = await db
    .select()
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.channelId, channelId))
    .limit(1);

  if (!binding) return null;

  const [resource] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, binding.gatewayId))
    .limit(1);

  if (!resource) return null;

  return {
    binding,
    resource,
  };
}

export async function bindGatewayToChannel(
  ...args: Parameters<typeof bindGatewayToChannelUnlocked>
) {
  return withChannelAutomationLock(args[0].channelId, async () => {
    await recoverEventCarrierHandoff(args[0].channelId);
    return bindGatewayToChannelUnlocked(...args);
  });
}

async function bindGatewayToChannelUnlocked(input: {
  channelId: string;
  gatewayId: string;
  boundByUserId: string;
}) {
  const existing = await getChannelGatewayBinding(input.channelId);
  if (existing?.binding.gatewayId === input.gatewayId) {
    // Even re-saving the same gateway is a retry opportunity for ensuring the board (R5 — idempotent).
    await ensureChannelBoardAfterBind(input.channelId);
    return existing.binding;
  }

  if (existing) {
    await db
      .update(channelGatewayBindings)
      .set({
        gatewayId: input.gatewayId,
        boundByUserId: input.boundByUserId,
        boundAt: nowForDb(),
      })
      .where(eq(channelGatewayBindings.id, existing.binding.id));
  } else {
    await db.insert(channelGatewayBindings).values({
      channelId: input.channelId,
      gatewayId: input.gatewayId,
      boundByUserId: input.boundByUserId,
    });
  }

  invalidateGatewayRuntimeState(input.gatewayId);
  if (existing?.binding.gatewayId && existing.binding.gatewayId !== input.gatewayId) {
    invalidateGatewayRuntimeState(existing.binding.gatewayId);
  }

  // The board is ensured after the binding is committed (R1). A failure here does not fail the binding (R5).
  await ensureChannelBoardAfterBind(input.channelId);

  const next = await getChannelGatewayBinding(input.channelId);
  return next?.binding ?? null;
}

/** `ensureChannelBoard` never throws, but the binding path wraps it once more anyway. */
async function ensureChannelBoardAfterBind(channelId: string) {
  try {
    const result = await ensureChannelBoard(channelId);
    if (!result.ok) {
      console.warn(
        `[gateway-resources] board not ensured for channel ${channelId}: ${result.code} (${result.reason})`,
      );
    }
  } catch (err) {
    console.warn(`[gateway-resources] ensureChannelBoard threw for channel ${channelId}:`, err);
  }
}

export async function unbindGatewayFromChannel(
  ...args: Parameters<typeof unbindGatewayFromChannelUnlocked>
) {
  return withChannelAutomationLock(args[0], async () => {
    await recoverEventCarrierHandoff(args[0]);
    return unbindGatewayFromChannelUnlocked(...args);
  });
}

async function unbindGatewayFromChannelUnlocked(channelId: string) {
  const existing = await getChannelGatewayBinding(channelId);
  if (!existing) return null;
  await db.delete(channelGatewayBindings).where(eq(channelGatewayBindings.id, existing.binding.id));
  invalidateGatewayRuntimeState(existing.binding.gatewayId);
  return existing.binding;
}

function mapGatewayErrorStatus(errorCode: string | undefined, status: number) {
  if (errorCode === "gateway_pairing_required" || errorCode === "PAIRING_REQUIRED") {
    return "pairing_required" as const;
  }
  if (status === 403) return "forbidden" as const;
  if (status === 502 || status === 503 || status === 504) return "unreachable" as const;
  return "error" as const;
}

export async function persistGatewayValidationState(
  gatewayId: string,
  input: {
    status: GatewayRuntimeStatus;
    error?: string | null;
    pairedDeviceId?: string | null;
  },
) {
  await db
    .update(gatewayResources)
    .set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: input.status,
      lastValidationError: input.error ?? null,
      pairedDeviceId: input.pairedDeviceId ?? undefined,
      updatedAt: nowForDb(),
    })
    .where(eq(gatewayResources.id, gatewayId));
}

export async function getGatewayRuntimeStateForChannel(
  channelId: string,
  options?: { forceRefresh?: boolean },
) {
  const binding = await getChannelGatewayBinding(channelId);
  if (!binding) {
    return { status: "unbound" as const, gateway: null };
  }

  const cached = options?.forceRefresh ? null : getCachedGatewayRuntimeState(binding.resource.id);
  if (cached) {
    return { ...cached, gateway: binding };
  }

  // A Hermes gateway is HTTP+SSE, so it returns 403 to OpenClaw's WS handshake, and that
  // client retries and hangs for over 20 seconds. This function also sits on the NPC list
  // path (GET /api/npcs → measured 25s), so meanwhile the screen renders "0 employees".
  // The same probe used in /api/gateways/[id]/test is placed here too.
  const probe = await probeHermesGateway(binding.resource.baseUrl);
  if (probe.kind === "hermes") {
    await persistGatewayValidationState(binding.resource.id, { status: "valid" });
    return {
      ...setGatewayRuntimeState(binding.resource.id, { status: "valid" }),
      gateway: binding,
    };
  }

  // The probe couldn't judge it as hermes. This used to retry OpenClaw's WS handshake
  // once more here, but that backend is gone — the probe result is reported as a failure as-is.
  {
    const errorCode =
      probe.kind === "unreachable"
        ? "failed_to_reach_test_endpoint"
        : probe.kind === "dashboard"
          ? "gateway_is_not_api_server"
          : "not_a_hermes_gateway";
    const error =
      probe.kind === "unreachable" ? probe.error : `Not a Hermes API Server (HTTP ${probe.status})`;
    const status = mapGatewayErrorStatus(errorCode, 502);
    await persistGatewayValidationState(binding.resource.id, { status, error });
    return {
      ...setGatewayRuntimeState(binding.resource.id, {
        status,
        requestId: null,
        error,
        details: null,
      }),
      gateway: binding,
    };
  }
}

export async function getGatewayRuntimeConfigForChannel(channelId: string) {
  const binding = await getChannelGatewayBinding(channelId);
  if (!binding) return null;
  return {
    gatewayId: binding.resource.id,
    baseUrl: binding.resource.baseUrl,
    token: decryptGatewayToken(binding.resource.tokenEncrypted),
    displayName: binding.resource.displayName,
    binding: binding.binding,
    resource: binding.resource,
  };
}
