import crypto from "node:crypto";

import { and, count, eq, inArray } from "drizzle-orm";

import {
  channelGatewayBindings,
  channels,
  db,
  gatewayResources,
  gatewayShares,
  isPostgres,
  jsonForDb,
  npcs,
  meetingMinutes,
  users,
} from "@/db";
import {
  type GatewayRuntimeStatus,
  getCachedGatewayRuntimeState,
  invalidateGatewayRuntimeState,
  setGatewayRuntimeState,
} from "@/lib/gateway-runtime-cache";
import {
  buildGatewayErrorPayload,
  getGatewayErrorStatus,
  testGatewayConnection,
} from "@/lib/openclaw-gateway.js";
import { buildGatewayConfig, getTaskAutomationConfig } from "@/lib/task-reporting";

type GatewayShareRow = typeof gatewayShares.$inferSelect;

type TaskAutomationConfig = ReturnType<typeof getTaskAutomationConfig>;

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

function getGatewayCipherKey() {
  const source = process.env.INTERNAL_RPC_SECRET || process.env.JWT_SECRET;
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

async function findMatchingOwnedGateway(ownerUserId: string, baseUrl: string, token: string) {
  const rows = await db
    .select()
    .from(gatewayResources)
    .where(and(eq(gatewayResources.ownerUserId, ownerUserId), eq(gatewayResources.baseUrl, baseUrl)));

  return rows.find((row) => {
    try {
      return decryptGatewayToken(row.tokenEncrypted) === token;
    } catch {
      return false;
    }
  }) ?? null;
}

export async function upsertOwnedGatewayResource(input: {
  ownerUserId: string;
  baseUrl: string;
  token: string;
  displayName?: string | null;
}) {
  const baseUrl = normalizeGatewayBaseUrl(input.baseUrl);
  const token = input.token.trim();
  const displayName = input.displayName?.trim() || buildDefaultGatewayDisplayName(baseUrl);
  const existing = await findMatchingOwnedGateway(input.ownerUserId, baseUrl, token);

  if (existing) {
    const [updated] = await db
      .update(gatewayResources)
      .set({
        displayName,
        tokenEncrypted: encryptGatewayToken(token),
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

  const shares = await db
    .select()
    .from(gatewayShares)
    .where(eq(gatewayShares.userId, userId));

  const sharedIds = shares.map((share) => share.gatewayId);
  const sharedResources = sharedIds.length > 0
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
    .where(and(eq(gatewayShares.gatewayId, input.gatewayId), eq(gatewayShares.userId, targetUser.id)))
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
    .where(and(eq(gatewayShares.gatewayId, input.gatewayId), eq(gatewayShares.userId, input.targetUserId)));

  return true;
}

export async function countChannelBindingsForGateway(gatewayId: string) {
  const [{ value }] = await db
    .select({ value: count() })
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.gatewayId, gatewayId));

  return value;
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

export async function bindGatewayToChannel(input: {
  channelId: string;
  gatewayId: string;
  boundByUserId: string;
}) {
  const existing = await getChannelGatewayBinding(input.channelId);
  if (existing?.binding.gatewayId === input.gatewayId) {
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

  const next = await getChannelGatewayBinding(input.channelId);
  return next?.binding ?? null;
}

export async function unbindGatewayFromChannel(channelId: string) {
  const existing = await getChannelGatewayBinding(channelId);
  if (!existing) return null;
  await db.delete(channelGatewayBindings).where(eq(channelGatewayBindings.id, existing.binding.id));
  invalidateGatewayRuntimeState(existing.binding.gatewayId);
  return existing.binding;
}

export async function deleteChannelGatewayArtifacts(channelId: string) {
  await db.delete(meetingMinutes).where(eq(meetingMinutes.channelId, channelId));
  await db.delete(npcs).where(eq(npcs.channelId, channelId));
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

  try {
    const token = decryptGatewayToken(binding.resource.tokenEncrypted);
    await testGatewayConnection(binding.resource.baseUrl, token);
    await persistGatewayValidationState(binding.resource.id, { status: "valid" });
    return {
      ...setGatewayRuntimeState(binding.resource.id, { status: "valid" }),
      gateway: binding,
    };
  } catch (error) {
    const payload = buildGatewayErrorPayload(error, {
      fallbackErrorCode: "failed_to_reach_test_endpoint",
      fallbackError: "Unknown error",
    }) as {
      ok: boolean;
      errorCode: string;
      error: string;
      requestId?: string | null;
      details?: unknown;
    };
    const status = mapGatewayErrorStatus(payload.errorCode, getGatewayErrorStatus(error, 502));
    await persistGatewayValidationState(binding.resource.id, {
      status,
      error: payload.error,
    });
    return {
      ...setGatewayRuntimeState(binding.resource.id, {
        status,
        requestId: payload.requestId,
        error: payload.error,
        details: payload.details,
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

export async function getChannelTaskAutomationSettings(channelId: string): Promise<TaskAutomationConfig> {
  const [row] = await db
    .select({ gatewayConfig: channels.gatewayConfig })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  return getTaskAutomationConfig(row?.gatewayConfig ?? null);
}

export async function updateChannelTaskAutomationSettings(
  channelId: string,
  patch: { taskAutomation: TaskAutomationConfig },
) {
  const [row] = await db
    .select({ gatewayConfig: channels.gatewayConfig })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  const existing = buildGatewayConfig(row?.gatewayConfig ?? null);
  const nextConfig = {
    ...existing,
    url: null,
    token: null,
    taskAutomation: patch.taskAutomation,
  };

  await db
    .update(channels)
    .set({
      gatewayConfig: jsonForDb(nextConfig),
      updatedAt: nowForDb(),
    })
    .where(eq(channels.id, channelId));

  return nextConfig;
}
