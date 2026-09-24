/**
 * The summary carried on the channel-selection card — map environment (for the thumbnail)
 * and participants.
 *
 * A channel doesn't separately store an environment ID. At creation, it just puts a copy
 * of `buildOfficeEnvironment(id)` into `map_data` (`POST /api/channels`). So the stored map
 * is compared against the current map of each of the five official environments. Objects
 * can differ due to seat placement etc., so only the **size and floor layer** are checked —
 * the floor shape differs per environment. A pre-upgrade old official map first goes
 * through the existing judgment (`upgradeOfficialEnvironmentMap`).
 */
import {
  buildOfficeEnvironment,
  OFFICE_ENVIRONMENTS,
  type OfficeEnvironmentId,
} from "../game/three/office-environments";
import { parseDbJson } from "./db-json";
import { upgradeOfficialEnvironmentMap } from "./official-environment-upgrade";
import { sameJsonSnapshot } from "./same-json-snapshot";

type MapShape = { width?: unknown; height?: unknown; layers?: unknown };

function floorLayer(map: MapShape): unknown {
  if (!Array.isArray(map.layers)) return undefined;
  const floor = map.layers.find(
    (layer) =>
      !!layer && typeof layer === "object" && (layer as { name?: unknown }).name === "Floor",
  ) as { data?: unknown } | undefined;
  return floor?.data;
}

let signatures: Array<{ id: OfficeEnvironmentId; map: MapShape; floor: unknown }> | null = null;

function environmentSignatures() {
  signatures ??= OFFICE_ENVIRONMENTS.map((environment) => {
    const map = buildOfficeEnvironment(environment.id) as unknown as MapShape;
    return { id: environment.id, map, floor: floorLayer(map) };
  });
  return signatures;
}

export function detectOfficeEnvironmentId(mapData: unknown): OfficeEnvironmentId | null {
  const parsed = parseDbJson<MapShape>(mapData);
  if (!parsed || typeof parsed !== "object") return null;
  const map = upgradeOfficialEnvironmentMap(parsed).map as MapShape;
  const floor = floorLayer(map);
  if (floor === undefined) return null;
  for (const signature of environmentSignatures()) {
    if (
      map.width === signature.map.width &&
      map.height === signature.map.height &&
      sameJsonSnapshot(floor, signature.floor)
    ) {
      return signature.id;
    }
  }
  return null;
}

export type ParticipantRow = {
  userId: string;
  nickname: string | null;
  appearance: unknown;
  joinedAt: Date | string | null;
};

export type ParticipantPreview = { nickname: string | null; appearance: unknown };

export const PARTICIPANT_PREVIEW_LIMIT = 5;

/** Owner first, the rest in arrival order. One entry per user. */
export function summarizeParticipants(
  rows: ParticipantRow[],
  ownerId: string,
  limit = PARTICIPANT_PREVIEW_LIMIT,
): { count: number; preview: ParticipantPreview[] } {
  const byUser = new Map<string, ParticipantRow>();
  for (const row of rows) if (!byUser.has(row.userId)) byUser.set(row.userId, row);
  const time = (row: ParticipantRow) =>
    row.joinedAt ? new Date(row.joinedAt).getTime() : Infinity;
  const ordered = [...byUser.values()].sort((a, b) => {
    if (a.userId === ownerId) return -1;
    if (b.userId === ownerId) return 1;
    return time(a) - time(b);
  });
  return {
    count: ordered.length,
    preview: ordered
      .slice(0, limit)
      .map((row) => ({ nickname: row.nickname, appearance: row.appearance })),
  };
}
