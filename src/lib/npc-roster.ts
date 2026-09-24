import { and, eq, inArray } from "drizzle-orm";
import { db, npcs, hermesProfiles, channelGatewayBindings, nowForDb } from "@/db";
import { placeUnplacedNpcs } from "./npc-seating";

/**
 * "Clocks in" every profile of the channel's bound gateway — relying on the
 * `(channel_id, hermes_profile_id)` unique constraint, creates the row if it's missing and
 * revives it with `active=true` if it exists. `placeUnplacedNpcs` immediately seats a newly
 * created NPC at an empty desk (a standing tile if full), and a revived NPC gets back the
 * exact seat it had before going dormant.
 */
export async function hireGatewayProfilesIntoChannel(
  channelId: string,
  gatewayId: string,
): Promise<{ created: number; reactivated: number }> {
  const profiles = await db
    .select({ id: hermesProfiles.id })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, gatewayId));

  let created = 0;
  let reactivated = 0;
  for (const profile of profiles) {
    const [existing] = await db
      .select({ id: npcs.id, active: npcs.active })
      .from(npcs)
      .where(and(eq(npcs.channelId, channelId), eq(npcs.hermesProfileId, profile.id)))
      .limit(1);

    if (!existing) {
      await db
        .insert(npcs)
        .values({ channelId, hermesProfileId: profile.id, active: true, updatedAt: nowForDb() });
      created += 1;
    } else if (!existing.active) {
      await db
        .update(npcs)
        .set({ active: true, updatedAt: nowForDb() })
        .where(eq(npcs.id, existing.id));
      reactivated += 1;
    }
  }
  if (created > 0 || reactivated > 0) await placeUnplacedNpcs(channelId);
  return { created, reactivated };
}

/**
 * Clocks in one newly registered profile across every channel already bound to that gateway.
 */
export async function hireProfileIntoBoundChannels(
  profileId: string,
): Promise<{ created: number }> {
  const [profile] = await db
    .select({ gatewayId: hermesProfiles.gatewayId })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.id, profileId))
    .limit(1);
  if (!profile) return { created: 0 };

  const bindings = await db
    .select({ channelId: channelGatewayBindings.channelId })
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.gatewayId, profile.gatewayId));

  let created = 0;
  for (const binding of bindings) {
    const [existing] = await db
      .select({ id: npcs.id })
      .from(npcs)
      .where(and(eq(npcs.channelId, binding.channelId), eq(npcs.hermesProfileId, profileId)))
      .limit(1);
    if (!existing) {
      await db.insert(npcs).values({
        channelId: binding.channelId,
        hermesProfileId: profileId,
        active: true,
        updatedAt: nowForDb(),
      });
      created += 1;
      await placeUnplacedNpcs(binding.channelId);
    }
  }
  return { created };
}

/** Puts that gateway's NPCs to sleep in this channel — removed from the map only, the seat is remembered. */
export async function sleepChannelNpcs(
  channelId: string,
  gatewayId: string,
): Promise<{ slept: number }> {
  const profiles = await db
    .select({ id: hermesProfiles.id })
    .from(hermesProfiles)
    .where(eq(hermesProfiles.gatewayId, gatewayId));
  if (profiles.length === 0) return { slept: 0 };

  const profileIds = profiles.map((p) => p.id);
  const targets = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(and(eq(npcs.channelId, channelId), inArray(npcs.hermesProfileId, profileIds)));
  if (targets.length === 0) return { slept: 0 };

  const ids = targets.map((t) => t.id);
  await db.update(npcs).set({ active: false, updatedAt: nowForDb() }).where(inArray(npcs.id, ids));
  return { slept: ids.length };
}

/** Directly toggles one NPC's clock-in state. */
export async function setNpcActive(npcId: string, active: boolean): Promise<void> {
  // `updated_at` is the criterion the migration uses to pick "the most recent one" — every
  // path that changes state must update it together, or that judgment ends up made on a stale value.
  await db.update(npcs).set({ active, updatedAt: nowForDb() }).where(eq(npcs.id, npcId));
  if (!active) return;
  // An employee that went dormant with no seat (data from before this feature existed) gets a seat as it revives.
  const [row] = await db
    .select({ channelId: npcs.channelId })
    .from(npcs)
    .where(eq(npcs.id, npcId))
    .limit(1);
  if (row) await placeUnplacedNpcs(row.channelId);
}
