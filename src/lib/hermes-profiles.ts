// Resource layer for Hermes profiles: registers profiles, validates them against a
// live gateway, and assembles authenticated HermesClient instances. Sits between the
// DB (hermesProfiles/npcs/gatewayResources) and callers (API routes, socket dispatch).

import { and, eq } from "drizzle-orm";

import { db, hermesProfiles, nowForDb, npcs, gatewayResources } from "@/db";
import {
  decryptGatewayToken,
  encryptGatewayToken,
  getAccessibleGatewayResource,
} from "@/lib/gateway-resources";
import { HermesClient, HermesError } from "@/lib/hermes/hermes-client";
import type { HermesCapabilities } from "@/lib/hermes/types";

export type ProfileValidationStatus =
  "valid" | "unauthorized" | "unknown_profile" | "unreachable" | "error";

export function mapValidationError(err: unknown): Exclude<ProfileValidationStatus, "valid"> {
  if (err instanceof HermesError) {
    if (err.code === "unauthorized") return "unauthorized";
    if (err.code === "unknown_profile") return "unknown_profile";
    if (err.code === "unreachable") return "unreachable";
  }
  return "error";
}

// PostgreSQL raises SQLSTATE 23505 (unique_violation); better-sqlite3 raises a
// SqliteError with code SQLITE_CONSTRAINT_UNIQUE (or _PRIMARYKEY). Detect both so a
// lost registration race converges to an update instead of throwing.
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "23505" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

async function updateHermesProfileToken(
  profileId: string,
  input: { token: string; displayName?: string },
  fallbackDisplayName: string | null,
) {
  const [updated] = await db
    .update(hermesProfiles)
    .set({
      tokenEncrypted: encryptGatewayToken(input.token.trim()),
      displayName: input.displayName?.trim() || fallbackDisplayName,
      updatedAt: nowForDb(),
    })
    .where(eq(hermesProfiles.id, profileId))
    .returning();
  return updated;
}

export function buildProfileClient(input: {
  baseUrl: string;
  profileName: string;
  tokenEncrypted: string;
  fetchImpl?: typeof fetch;
}): HermesClient {
  return new HermesClient({
    baseUrl: input.baseUrl,
    profileName: input.profileName === "default" ? null : input.profileName,
    token: decryptGatewayToken(input.tokenEncrypted),
    fetchImpl: input.fetchImpl,
  });
}

export async function registerHermesProfile(input: {
  userId: string;
  gatewayId: string;
  profileName: string;
  token: string;
  displayName?: string;
}): Promise<{ profile: typeof hermesProfiles.$inferSelect } | { error: "forbidden" }> {
  // Registering writes a credential onto the gateway, so this requires ownership —
  // a shared "use" role is enough to read/validate profiles but not to write one.
  const access = await getAccessibleGatewayResource(input.userId, input.gatewayId);
  if (!access || !access.isOwner) return { error: "forbidden" as const };

  const profileName = input.profileName.trim();
  const existing = await db
    .select()
    .from(hermesProfiles)
    .where(
      and(
        eq(hermesProfiles.gatewayId, input.gatewayId),
        eq(hermesProfiles.profileName, profileName),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const updated = await updateHermesProfileToken(existing[0].id, input, existing[0].displayName);
    return { profile: updated };
  }

  try {
    const [created] = await db
      .insert(hermesProfiles)
      .values({
        gatewayId: input.gatewayId,
        profileName,
        tokenEncrypted: encryptGatewayToken(input.token.trim()),
        displayName: input.displayName?.trim() || profileName,
      })
      .returning();
    return { profile: created };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Lost the race: another registration for this (gatewayId, profileName) landed
    // between our existence check and our insert. Converge to an update rather than
    // surfacing a raw constraint violation.
    const [raced] = await db
      .select()
      .from(hermesProfiles)
      .where(
        and(
          eq(hermesProfiles.gatewayId, input.gatewayId),
          eq(hermesProfiles.profileName, profileName),
        ),
      )
      .limit(1);
    if (!raced) throw err;

    const updated = await updateHermesProfileToken(raced.id, input, raced.displayName);
    return { profile: updated };
  }
}

export async function listHermesProfiles(userId: string, gatewayId: string) {
  const access = await getAccessibleGatewayResource(userId, gatewayId);
  if (!access) return [];

  const rows = await db
    .select()
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, gatewayId));

  // 한 프로필은 NPC 하나에만 붙인다 — 둘이 같은 프로필을 쓰면 같은 Hermes 세션과
  // 기억을 공유해 서로의 대화가 섞인다. 어느 프로필이 이미 묶였는지는 서버만 알 수
  // 있으므로 여기서 알려준다(화면이 NPC 목록을 따로 들고 다니지 않아도 되게).
  const boundRows = await db.select({ profileId: npcs.hermesProfileId }).from(npcs);
  const bound = new Set(boundRows.map((r) => r.profileId).filter(Boolean));

  return rows.map((row) => ({
    id: row.id,
    profileName: row.profileName,
    displayName: row.displayName,
    lastValidationStatus: row.lastValidationStatus,
    inUse: bound.has(row.id),
  }));
}

/**
 * 프로필 수정. 토큰은 **보낼 때만** 바뀐다 — 게이트웨이 PATCH 와 같은 규약이다
 * (화면이 빈 칸을 아예 보내지 않는다). 빈 문자열로 자격증명을 지우는 사고를 막는다.
 *
 * `profileName` 은 바꾸지 않는다. 그것은 Hermes 쪽 정체성이고 `/p/<name>/` 라우팅과
 * 세션 키가 그 이름에 걸려 있어, 바꾸는 것은 사실상 다른 프로필이다 — 새로 만들어야 한다.
 */
export async function updateHermesProfile(
  userId: string,
  profileId: string,
  input: { token?: string; displayName?: string },
): Promise<{ ok: true } | { ok: false; errorCode: "profile_not_found" | "forbidden" }> {
  const [row] = await db
    .select()
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!row) return { ok: false, errorCode: "profile_not_found" };

  const access = await getAccessibleGatewayResource(userId, row.gatewayId);
  if (!access) return { ok: false, errorCode: "forbidden" };

  const patch: Record<string, unknown> = { updatedAt: nowForDb() };
  if (typeof input.displayName === "string") patch.displayName = input.displayName;
  if (typeof input.token === "string" && input.token.trim()) {
    patch.tokenEncrypted = encryptGatewayToken(input.token.trim());
    // 자격증명이 바뀌었으므로 예전 검증 결과는 더 이상 이 토큰에 대한 것이 아니다.
    // 남겨 두면 "인증 실패" 배지가 새 토큰에 대해서도 계속 붙어 사용자를 오도한다.
    patch.lastValidationStatus = null;
    patch.lastValidationError = null;
    patch.lastValidatedAt = null;
  }

  await db.update(hermesProfiles).set(patch).where(eq(hermesProfiles.id, profileId));
  return { ok: true };
}

/**
 * 프로필 삭제. 이 프로필을 쓰던 NPC 는 지워지지 않고 연결만 풀린다
 * (`npcs.hermes_profile_id` 가 `set null`). 다만 그 NPC 들은 다시 묶기 전까지
 * 대화할 수 없으므로, 호출부가 사용자에게 그 수를 먼저 보여줘야 한다.
 */
export async function deleteHermesProfile(
  userId: string,
  profileId: string,
): Promise<
  { ok: true; unboundNpcs: number } | { ok: false; errorCode: "profile_not_found" | "forbidden" }
> {
  const [row] = await db
    .select()
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!row) return { ok: false, errorCode: "profile_not_found" };

  const access = await getAccessibleGatewayResource(userId, row.gatewayId);
  if (!access) return { ok: false, errorCode: "forbidden" };

  const bound = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(eq(npcs.hermesProfileId, profileId));

  await db.delete(hermesProfiles).where(eq(hermesProfiles.id, profileId));
  return { ok: true, unboundNpcs: bound.length };
}

export async function validateHermesProfile(
  userId: string,
  profileId: string,
): Promise<{
  status: ProfileValidationStatus;
  error?: string;
  capabilities?: HermesCapabilities;
}> {
  const [row] = await db
    .select()
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!row) return { status: "error", error: "profile_not_found" };

  const access = await getAccessibleGatewayResource(userId, row.gatewayId);
  if (!access) return { status: "error", error: "forbidden" };

  try {
    const client = buildProfileClient({
      baseUrl: access.resource.baseUrl,
      profileName: row.profileName,
      tokenEncrypted: row.tokenEncrypted,
    });
    const capabilities = await client.getCapabilities();
    await db
      .update(hermesProfiles)
      .set({
        lastValidatedAt: nowForDb(),
        lastValidationStatus: "valid",
        lastValidationError: null,
        updatedAt: nowForDb(),
      })
      .where(eq(hermesProfiles.id, profileId));
    return { status: "valid", capabilities };
  } catch (err) {
    const status = mapValidationError(err);
    const message = err instanceof Error ? err.message : "unknown";
    await db
      .update(hermesProfiles)
      .set({
        lastValidatedAt: nowForDb(),
        lastValidationStatus: status,
        lastValidationError: message,
        updatedAt: nowForDb(),
      })
      .where(eq(hermesProfiles.id, profileId));
    return { status, error: message };
  }
}

export async function getProfileClientForNpc(npcId: string): Promise<HermesClient | null> {
  const rows = await db
    .select({
      profileName: hermesProfiles.profileName,
      tokenEncrypted: hermesProfiles.tokenEncrypted,
      baseUrl: gatewayResources.baseUrl,
    })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(npcs.hermesProfileId, hermesProfiles.id))
    .innerJoin(gatewayResources, eq(hermesProfiles.gatewayId, gatewayResources.id))
    .where(eq(npcs.id, npcId))
    .limit(1);

  if (!rows[0]) return null;
  return buildProfileClient(rows[0]);
}
