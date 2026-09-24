// Resource layer for Hermes profiles: registers profiles, validates them against a
// live gateway, and assembles authenticated HermesClient instances. Sits between the
// DB (hermesProfiles/npcs/gatewayResources) and callers (API routes, socket dispatch).

import { and, eq, inArray } from "drizzle-orm";

import {
  db,
  hermesProfiles,
  jsonForDb,
  nowForDb,
  npcs,
  gatewayResources,
  chatRoomMembers,
} from "@/db";
import {
  decryptGatewayToken,
  encryptGatewayToken,
  getAccessibleGatewayResource,
} from "@/lib/gateway-resources";
import { parseDbJson } from "@/lib/db-json";
import { HermesClient, HermesError } from "@/lib/hermes/hermes-client";
import type { HermesCapabilities } from "@/lib/hermes/types";
import { isUniqueViolation } from "./db-unique-violation";
import { pickOfficeLookForNewProfile } from "./profile-look-assignment";

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

async function updateHermesProfileToken(
  profileId: string,
  input: { token: string; displayName?: string; provisionedByDeskrpg?: boolean },
  fallbackDisplayName: string | null,
) {
  const [updated] = await db
    .update(hermesProfiles)
    .set({
      tokenEncrypted: encryptGatewayToken(input.token.trim()),
      displayName: input.displayName?.trim() || fallbackDisplayName,
      updatedAt: nowForDb(),
      // Final review I-2: if this argument is missing or false, leave the existing value
      // alone — a manual re-registration path (e.g. swapping a token) must not silently
      // revert an already-set provisionedByDeskrpg back to false. Only the wizard explicitly
      // passes true.
      ...(input.provisionedByDeskrpg ? { provisionedByDeskrpg: true } : {}),
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
  /**
   * Final review I-2: spec §3① — "the wizard sets this value." Only the wizard (the plugin
   * profile-creation route) passes `true`. The manual registration screen
   * (`/api/gateways/[id]/profiles`) never passes this argument at all, so the default (false)
   * is kept — it's the only signal that distinguishes a profile DeskRPG created from one a
   * user registered by hand, so setting it wrong here has no way back.
   */
  provisionedByDeskrpg?: boolean;
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

  // A new employee is born with an appearance — if it's left empty, everyone looks the same
  // default look. An existing row's appearance (the update path above) may have been chosen
  // by a person, so it's left untouched.
  const siblings = await db
    .select({ appearance: hermesProfiles.appearance })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, input.gatewayId));
  const appearance = pickOfficeLookForNewProfile(
    siblings.map((row) => parseDbJson<unknown>(row.appearance) ?? row.appearance),
  );

  try {
    const [created] = await db
      .insert(hermesProfiles)
      .values({
        gatewayId: input.gatewayId,
        profileName,
        tokenEncrypted: encryptGatewayToken(input.token.trim()),
        displayName: input.displayName?.trim() || profileName,
        provisionedByDeskrpg: input.provisionedByDeskrpg ?? false,
        appearance: jsonForDb(appearance),
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

  // A profile attaches to only one NPC — if two shared the same profile, they'd share the
  // same Hermes session and memory, mixing their conversations together. Only the server
  // knows which profiles are already bound, so it reports that here (so the screen doesn't
  // need to carry the NPC list around separately).
  const boundRows = await db.select({ profileId: npcs.hermesProfileId }).from(npcs);
  const bound = new Set(boundRows.map((r) => r.profileId).filter(Boolean));

  return rows.map((row) => ({
    id: row.id,
    profileName: row.profileName,
    displayName: row.displayName,
    lastValidationStatus: row.lastValidationStatus,
    // The profile is the source of truth for appearance. If it's not included in the list,
    // the gateway screen's appearance editor starts from the default, and one save quietly
    // overwrites that persona's look.
    appearance: parseDbJson<unknown>(row.appearance) ?? null,
    inUse: bound.has(row.id),
  }));
}

/**
 * Modifies a profile. The token only changes **when it's actually sent** — the same
 * convention as the gateway PATCH (the screen never sends an empty field at all). This
 * prevents accidentally wiping a credential with an empty string.
 *
 * `profileName` is never changed. It's the Hermes-side identity, and since `/p/<name>/`
 * routing and the session key are pinned to that name, changing it is effectively a
 * different profile — a new one must be created instead.
 */
export async function updateHermesProfile(
  userId: string,
  profileId: string,
  input: { token?: string; displayName?: string; appearance?: unknown },
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
  // The profile is the source of truth for appearance, and changes it for the NPC in **every**
  // channel that profile appears in, all at once. A user with shared access can't overwrite
  // the face of someone else's gateway persona — only the owner can write it.
  if (input.appearance !== undefined) {
    if (!access.isOwner) return { ok: false, errorCode: "forbidden" };
    patch.appearance = jsonForDb(input.appearance);
  }
  if (typeof input.token === "string" && input.token.trim()) {
    patch.tokenEncrypted = encryptGatewayToken(input.token.trim());
    // The credential changed, so the old validation result no longer applies to this token.
    // Leaving it would keep an "authentication failed" badge attached even to the new token,
    // misleading the user.
    patch.lastValidationStatus = null;
    patch.lastValidationError = null;
    patch.lastValidatedAt = null;
  }

  await db.update(hermesProfiles).set(patch).where(eq(hermesProfiles.id, profileId));
  return { ok: true };
}

/** How many NPCs and channels this profile appears in — used by the delete-confirmation copy. */
export async function profileUsage(profileId: string): Promise<{
  npcs: number;
  channels: number;
}> {
  const rows = await db
    .select({ channelId: npcs.channelId })
    .from(npcs)
    .where(eq(npcs.hermesProfileId, profileId));
  return { npcs: rows.length, channels: new Set(rows.map((r) => r.channelId)).size };
}

/**
 * Deletes a profile. Since the profile became the source of truth for NPCs, this is
 * effectively a **termination** — the CASCADE on `npcs.hermes_profile_id` also deletes that
 * profile's NPC rows. How many NPCs disappear from how many channels is counted and returned
 * before the delete (it can't be counted afterward).
 */
export async function deleteHermesProfile(
  userId: string,
  profileId: string,
): Promise<
  | { ok: true; deletedNpcs: number; channels: number }
  | { ok: false; errorCode: "profile_not_found" | "forbidden" }
> {
  const [row] = await db
    .select()
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!row) return { ok: false, errorCode: "profile_not_found" };

  const access = await getAccessibleGatewayResource(userId, row.gatewayId);
  if (!access) return { ok: false, errorCode: "forbidden" };

  const usage = await profileUsage(profileId);

  // Deleting a profile cascades to delete npcs — but the chat_room_members rows left over
  // from that NPC being a chat room member are not part of that cascade (the members table
  // doesn't hold an FK to npcs), so we collect the NPC ids and clean them up directly before
  // deleting.
  // This store has no shared transaction helper — better-sqlite3's drizzle transactions are
  // synchronous while PG's are async, so the two drivers can't be wrapped by the same helper
  // (other resource modules skip transactions for the same reason). So the two deletes run in
  // sequence, without a transaction. Order is the only safeguard: clean up members → cascade
  // profile/NPC. With this order, even a mid-failure worst case leaves only "members cleaned
  // up but the NPC remains," never "a room still pointing at a deleted NPC as a member." The
  // former is just a harmless normal state on the next query (no ghost member), unlike the
  // latter (what cleaning up members second would have produced), which would create a broken
  // member row referencing an NPC that no longer exists.
  const affectedNpcs = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(eq(npcs.hermesProfileId, profileId));
  const npcIds = affectedNpcs.map((n) => n.id);
  if (npcIds.length > 0) {
    await db
      .delete(chatRoomMembers)
      .where(and(eq(chatRoomMembers.memberKind, "npc"), inArray(chatRoomMembers.memberId, npcIds)));
  }

  await db.delete(hermesProfiles).where(eq(hermesProfiles.id, profileId));
  return { ok: true, deletedNpcs: usage.npcs, channels: usage.channels };
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
