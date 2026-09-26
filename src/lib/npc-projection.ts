import { count, eq, inArray } from "drizzle-orm";
import { db, npcs, hermesProfiles, gatewayResources } from "@/db";
import { parseDbJson } from "./db-json";

type NpcRow = typeof npcs.$inferSelect;
type ProfileRow = Pick<
  typeof hermesProfiles.$inferSelect,
  "id" | "gatewayId" | "profileName" | "displayName" | "appearance"
>;

export type ProjectedNpc = {
  id: string;
  channelId: string;
  name: string;
  appearance: unknown;
  positionX: number | null;
  positionY: number | null;
  direction: string | null;
  adapterType: string;
  adapterConfig: unknown;
  agentConfig: unknown;
  hermesProfileId: string;
  active: boolean;
  profile: {
    gatewayId: string;
    profileName: string;
    displayName: string | null;
    ownerUserId: string;
  };
};

/**
 * `npcs` row + profile → an NPC in the same shape as before.
 *
 * The profile is **the source of truth** for name·appearance. `npcs.name`/`appearance` still
 * exist as columns this release (for rollback safety) but aren't read here. 16 consumer files
 * use this shape as-is, so the field names aren't changed.
 */
export function projectNpcRow(npc: NpcRow, profile: ProfileRow, ownerUserId: string): ProjectedNpc {
  return {
    id: npc.id,
    channelId: npc.channelId,
    name: profile.displayName?.trim() || profile.profileName,
    appearance: parseDbJson<unknown>(profile.appearance) ?? profile.appearance ?? null,
    positionX: npc.positionX ?? null,
    positionY: npc.positionY ?? null,
    direction: npc.direction ?? null,
    adapterType: npc.adapterType,
    adapterConfig: parseDbJson<unknown>(npc.adapterConfig) ?? npc.adapterConfig ?? null,
    agentConfig: parseDbJson<unknown>(npc.agentConfig) ?? npc.agentConfig ?? null,
    hermesProfileId: npc.hermesProfileId,
    active: Boolean(npc.active),
    profile: {
      gatewayId: profile.gatewayId,
      profileName: profile.profileName,
      displayName: profile.displayName ?? null,
      ownerUserId,
    },
  };
}

/** Only what can be drawn on the map — has a position and is clocked in. This is the existing `/api/npcs` contract. */
export function filterForMap(list: ProjectedNpc[]): ProjectedNpc[] {
  return list.filter((n) => n.active && n.positionX !== null && n.positionY !== null);
}

async function joined(where: ReturnType<typeof eq>) {
  const rows = await db
    .select({ npc: npcs, profile: hermesProfiles, ownerUserId: gatewayResources.ownerUserId })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .innerJoin(gatewayResources, eq(gatewayResources.id, hermesProfiles.gatewayId))
    .where(where);
  return rows.map((r) => projectNpcRow(r.npc, r.profile, r.ownerUserId));
}

/**
 * `roster` is "the attendance list" — returns everything, including unplaced and dormant NPCs
 * (for the management screen).
 * `includeDormant: false` excludes only the dormant ones — this is the conversation participant list.
 * Unplaced NPCs stay: they're just off the map while still clocked in, and per spec only dormant
 * NPCs leave the conversation.
 */
export async function selectChannelNpcs(
  channelId: string,
  opts: { roster?: boolean; includeDormant?: boolean } = {},
) {
  const all = await joined(eq(npcs.channelId, channelId));
  if (!opts.roster) return filterForMap(all);
  return opts.includeDormant === false ? all.filter((n) => n.active) : all;
}

/**
 * Roster size per channel in one query — the same rows `selectChannelNpcs(id, { roster: true })`
 * returns (same joins, dormant and unplaced included), so a count shown next to a channel matches
 * its roster. Channels with no NPCs are absent from the map.
 */
export async function countRosterNpcsByChannel(
  channelIds: readonly string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({ channelId: npcs.channelId, value: count() })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .innerJoin(gatewayResources, eq(gatewayResources.id, hermesProfiles.gatewayId))
    .where(inArray(npcs.channelId, [...channelIds]))
    .groupBy(npcs.channelId);
  return new Map(rows.map((r) => [r.channelId, Number(r.value)]));
}

export async function selectNpcById(npcId: string): Promise<ProjectedNpc | null> {
  const [one] = await joined(eq(npcs.id, npcId));
  return one ?? null;
}
