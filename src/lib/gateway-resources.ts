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
import { buildGatewayConfig, getTaskAutomationConfig } from "@/lib/task-reporting";

type GatewayShareRow = typeof gatewayShares.$inferSelect;

type TaskAutomationConfig = ReturnType<typeof getTaskAutomationConfig>;

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

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

/** 게이트웨이를 삭제하려는 사용자에게 "무엇이 막고 있고, 풀면 무엇이 사라지는가"를 보여준다. */
export type GatewayChannelBinding = {
  channelId: string;
  channelName: string;
  /** 요청자가 이 채널의 소유자인가. 연결 해제는 채널 소유자만 할 수 있다. */
  canUnbind: boolean;
  /** 연결을 해제하면 함께 삭제되는 것들 — deleteChannelGatewayArtifacts() 가 지우는 범위다. */
  npcCount: number;
  meetingMinutesCount: number;
};

/**
 * 이 게이트웨이에 묶인 채널들. 삭제가 409 로 거절될 때 "어느 채널이 막고 있는가"를
 * 이름으로 답하기 위한 것 — 개수만 알려주면 사용자가 채널을 찾아 헤매야 한다.
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
      const [{ value: npcCount }] = await db
        .select({ value: count() })
        .from(npcs)
        .where(eq(npcs.channelId, row.channelId));
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

  // Hermes 게이트웨이는 HTTP+SSE라 OpenClaw 의 WS 핸드셰이크에 403을 돌려주고, 그
  // 클라이언트는 재시도하며 20초 넘게 매달린다. 이 함수는 NPC 목록 조회 경로에도
  // 있어서(GET /api/npcs → 실측 25초), 그 사이 화면은 "NPC 0명"으로 그려진다.
  // /api/gateways/[id]/test 에 넣은 것과 같은 프로브를 여기에도 둔다.
  const probe = await probeHermesGateway(binding.resource.baseUrl);
  if (probe.kind === "hermes") {
    await persistGatewayValidationState(binding.resource.id, { status: "valid" });
    return {
      ...setGatewayRuntimeState(binding.resource.id, { status: "valid" }),
      gateway: binding,
    };
  }

  // 프로브가 hermes 로 판정하지 못했다. 예전에는 여기서 OpenClaw 의 WS 핸드셰이크를
  // 한 번 더 시도했지만, 그 백엔드는 사라졌다 — 프로브 결과를 그대로 실패로 보고한다.
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

export async function getChannelTaskAutomationSettings(
  channelId: string,
): Promise<TaskAutomationConfig> {
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
