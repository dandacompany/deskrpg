import { normalizeMeetingMap, projectMeetingMap } from "../game/meeting-map-normalization";
import type { MeetingSpace } from "../game/meeting-space";
import { parseDbJson } from "./db-json";
import {
  ACTOR_RADIUS,
  clearSegment,
  type NavigationPoint,
  type Walkable,
} from "../game/navigation";
import { isCreativeStudioMap, effectiveMapSpawn } from "./effective-map-spawn";
import { deskSeats, executiveSeats, furnitureSeats } from "../game/three/seating";

export const CHANNEL_TILE_SIZE = 32;
export type ChannelMotionLayout = {
  meetingSpace?: MeetingSpace;
  /** v3 homes are runtime allocations; roster changes may require relocation. */
  sanitizedHomes?: boolean;
  npcs: Array<NavigationPoint & { id: string }>;
  seats: Array<NavigationPoint & { id: string }>;
  /** Candidate assigned seats for employees — standable desk chair tiles, sorted row→col. */
  deskSeatTiles: Array<{ col: number; row: number }>;
  /** Executive seat tiles — seats that are never assigned to an employee. An empty array for a map that has none. */
  executiveSeatTiles: Array<{ col: number; row: number }>;
  bounds: { width: number; height: number };
  /** Logical tile indices, matching the client simulation's navigation. */
  isWalkable: Walkable;
  /** Pixel coordinates, including actor body clearance at wall corners. */
  canStandAt: (point: NavigationPoint) => boolean;
};
const finitePoint = (point: NavigationPoint) =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

/** Read the persisted snapshot, never regenerate a themed map over user edits. */
export function deriveChannelMotionLayout(
  channel: { mapData: unknown; mapConfig?: unknown },
  npcRows: ReadonlyArray<{ id: string; positionX: number; positionY: number }>,
): ChannelMotionLayout | null {
  const data = parseDbJson(channel.mapData);
  if (!data) return null;
  try {
    const spawn = effectiveMapSpawn(data, channel.mapConfig);
    const normalized = normalizeMeetingMap(
      data,
      spawn ? { spawnCol: spawn.col, spawnRow: spawn.row } : parseDbJson(channel.mapConfig),
    );
    const { cols, rows, objects, blocked: blockedKeys } = projectMeetingMap(normalized.mapData);
    const blocked = new Set(blockedKeys);
    const isWalkable: Walkable = (x, y) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < cols &&
      y < rows &&
      !blocked.has(`${x},${y}`);
    const canStandAt = (point: NavigationPoint) => {
      if (!finitePoint(point)) return false;
      const tile = { x: point.x / CHANNEL_TILE_SIZE - 0.5, y: point.y / CHANNEL_TILE_SIZE - 0.5 };
      return clearSegment(tile, tile, isWalkable);
    };
    const studio = isCreativeStudioMap(data);
    const npcs = npcRows
      .filter(
        (npc) => studio || (Number.isInteger(npc.positionX) && Number.isInteger(npc.positionY)),
      )
      .map((npc) => ({
        id: npc.id,
        x: Number.isInteger(npc.positionX) ? (npc.positionX + 0.5) * 32 : NaN,
        y: Number.isInteger(npc.positionY) ? (npc.positionY + 0.5) * 32 : NaN,
      }));
    const seats = new Map<string, NavigationPoint & { id: string }>();
    for (const seat of furnitureSeats(objects)) {
      const x = (seat.anchorX ?? seat.x) * 32,
        y = (seat.anchorZ ?? seat.z) * 32;
      if (canStandAt({ x, y })) seats.set(`${x}:${y}`, { id: `${x}:${y}`, x, y });
    }
    const deskTiles = new Map<string, { col: number; row: number }>();
    for (const seat of deskSeats(objects)) {
      const ax = seat.anchorX ?? seat.x,
        az = seat.anchorZ ?? seat.z;
      if (!canStandAt({ x: ax * 32, y: az * 32 })) continue;
      const col = Math.floor(ax),
        row = Math.floor(az);
      deskTiles.set(`${col},${row}`, { col, row });
    }
    const deskSeatTiles = [...deskTiles.values()].sort((a, b) => a.row - b.row || a.col - b.col);
    const executiveSeatTiles = executiveSeats(objects)
      .map((seat) => ({
        col: Math.floor(seat.anchorX ?? seat.x),
        row: Math.floor(seat.anchorZ ?? seat.z),
      }))
      .sort((a, b) => a.row - b.row || a.col - b.col);
    // Historical profile assignments stay in the DB. Only v3 runtime homes are repaired.
    if (studio) {
      const occupied: NavigationPoint[] = [];
      // Reserve valid homes first, before assigning invalid actors to nearby seats.
      const ordered = [...npcs].sort(
        (a, b) => Number(canStandAt(b)) - Number(canStandAt(a)) || a.id.localeCompare(b.id),
      );
      for (const npc of ordered) {
        const malformed = !finitePoint(npc);
        if (malformed) {
          npc.x = ((spawn?.col ?? 1) + 0.5) * 32;
          npc.y = ((spawn?.row ?? 1) + 0.5) * 32;
        }
        const available = (point: NavigationPoint) =>
          canStandAt(point) &&
          occupied.every(
            (other) => Math.hypot(point.x - other.x, point.y - other.y) >= ACTOR_RADIUS * 2 * 32,
          );
        if (malformed || !available(npc)) {
          const candidates = [...seats.values()]
            .filter(available)
            .sort(
              (a, b) =>
                Math.hypot(a.x - npc.x, a.y - npc.y) - Math.hypot(b.x - npc.x, b.y - npc.y) ||
                a.y - b.y ||
                a.x - b.x,
            );
          const replacement =
            candidates[0] ??
            closestValidUnoccupiedSpawn(
              {
                npcs: [],
                seats: [],
                deskSeatTiles: [],
                executiveSeatTiles: [],
                bounds: { width: cols * 32, height: rows * 32 },
                isWalkable,
                canStandAt,
              },
              npc,
              occupied,
            );
          if (!replacement) return null;
          npc.x = replacement.x;
          npc.y = replacement.y;
        }
        occupied.push(npc);
      }
    }
    return {
      meetingSpace: normalized.meetingSpace,
      ...(studio ? { sanitizedHomes: true } : {}),
      npcs,
      seats: [...seats.values()],
      deskSeatTiles,
      executiveSeatTiles,
      bounds: { width: cols * 32, height: rows * 32 },
      isWalkable,
      canStandAt,
    };
  } catch {
    return null;
  }
}

/** Preserve a valid saved position, otherwise choose the closest free tile center.
 * Equal distances use row then column ordering. Returns null when the map is full.
 */
export function closestValidUnoccupiedSpawn(
  layout: ChannelMotionLayout,
  preferred: NavigationPoint,
  occupied: ReadonlyArray<NavigationPoint> = [],
): NavigationPoint | null {
  if (!finitePoint(preferred)) return null;
  const actors = [...layout.npcs, ...occupied].filter(finitePoint);
  const available = (point: NavigationPoint) =>
    layout.canStandAt(point) &&
    actors.every(
      (actor) =>
        Math.hypot(actor.x - point.x, actor.y - point.y) >= ACTOR_RADIUS * 2 * CHANNEL_TILE_SIZE,
    );
  if (available(preferred)) return { ...preferred };
  let best: NavigationPoint | null = null,
    distance = Infinity;
  for (let y = 16; y < layout.bounds.height; y += 32) {
    for (let x = 16; x < layout.bounds.width; x += 32) {
      const nextDistance = Math.hypot(x - preferred.x, y - preferred.y);
      if (nextDistance < distance && available({ x, y })) {
        best = { x, y };
        distance = nextDistance;
      }
    }
  }
  return best;
}
