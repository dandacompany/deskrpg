// Resource layer for Hermes profiles: registers profiles, validates them against a
// live gateway, and assembles authenticated HermesClient instances. Sits between the
// DB (hermesProfiles/npcs/gatewayResources) and callers (API routes, socket dispatch).

import { and, eq } from "drizzle-orm";

import { db, hermesProfiles, isPostgres, npcs, gatewayResources } from "@/db";
import { decryptGatewayToken, encryptGatewayToken, getAccessibleGatewayResource } from "@/lib/gateway-resources";
import { HermesClient, HermesError } from "@/lib/hermes/hermes-client";
import type { HermesCapabilities } from "@/lib/hermes/types";

function nowForDb() {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
}

export type ProfileValidationStatus =
  | "valid" | "unauthorized" | "unknown_profile" | "unreachable" | "error";

export function mapValidationError(err: unknown): Exclude<ProfileValidationStatus, "valid"> {
  if (err instanceof HermesError) {
    if (err.code === "unauthorized") return "unauthorized";
    if (err.code === "unknown_profile") return "unknown_profile";
    if (err.code === "unreachable") return "unreachable";
  }
  return "error";
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
}): Promise<{ profile: typeof hermesProfiles.$inferSelect } | { error: "forbidden" | "duplicate" }> {
  const access = await getAccessibleGatewayResource(input.userId, input.gatewayId);
  if (!access) return { error: "forbidden" as const };

  const profileName = input.profileName.trim();
  const existing = await db.select().from(hermesProfiles).where(and(
    eq(hermesProfiles.gatewayId, input.gatewayId),
    eq(hermesProfiles.profileName, profileName),
  )).limit(1);

  if (existing[0]) {
    const [updated] = await db.update(hermesProfiles).set({
      tokenEncrypted: encryptGatewayToken(input.token.trim()),
      displayName: input.displayName?.trim() || existing[0].displayName,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, existing[0].id)).returning();
    return { profile: updated };
  }

  const [created] = await db.insert(hermesProfiles).values({
    gatewayId: input.gatewayId,
    profileName,
    tokenEncrypted: encryptGatewayToken(input.token.trim()),
    displayName: input.displayName?.trim() || profileName,
  }).returning();

  return { profile: created };
}

export async function listHermesProfiles(userId: string, gatewayId: string) {
  const access = await getAccessibleGatewayResource(userId, gatewayId);
  if (!access) return [];

  const rows = await db.select().from(hermesProfiles).where(eq(hermesProfiles.gatewayId, gatewayId));
  return rows.map((row) => ({
    id: row.id,
    profileName: row.profileName,
    displayName: row.displayName,
    lastValidationStatus: row.lastValidationStatus,
  }));
}

export async function validateHermesProfile(userId: string, profileId: string): Promise<{
  status: ProfileValidationStatus;
  error?: string;
  capabilities?: HermesCapabilities;
}> {
  const [row] = await db.select().from(hermesProfiles).where(eq(hermesProfiles.id, profileId)).limit(1);
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
    await db.update(hermesProfiles).set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: "valid",
      lastValidationError: null,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, profileId));
    return { status: "valid", capabilities };
  } catch (err) {
    const status = mapValidationError(err);
    const message = err instanceof Error ? err.message : "unknown";
    await db.update(hermesProfiles).set({
      lastValidatedAt: nowForDb(),
      lastValidationStatus: status,
      lastValidationError: message,
      updatedAt: nowForDb(),
    }).where(eq(hermesProfiles.id, profileId));
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
