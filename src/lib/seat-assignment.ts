import { deriveChannelMotionLayout, CHANNEL_TILE_SIZE } from "./channel-motion-layout";
import { parseDbJson } from "./db-json";
import { effectiveMapSpawn } from "./effective-map-spawn";

/**
 * **Pure logic** for staff seat assignment. Neither the DB nor `fetch` enters here.
 *
 * Seat numbers are never stored — they're recomputed every time by scanning the channel
 * map's desk chairs in row→col order. Which chairs count as desk seats is decided by
 * `deskSeats` in `seating.ts`; this only takes that result
 * (`ChannelMotionLayout.deskSeatTiles`) and produces numbers, standing tiles, and an
 * assignment plan.
 */
export type Tile = { col: number; row: number };
export type DeskSeat = Tile & { number: number };
/** `reserved` is the executive seat — no number, not a standing tile. An already-seated NPC there is moved during migration. */
export type SeatingMap = { seats: DeskSeat[]; standing: Tile[]; reserved: Tile[] };
export type Placement = { npcId: string; col: number; row: number; seated: boolean };

const key = (tile: Tile) => `${tile.col},${tile.row}`;

export function seatingMapFor(channel: {
  mapData: unknown;
  mapConfig?: unknown;
}): SeatingMap | null {
  const data = parseDbJson(channel.mapData);
  if (!data || typeof data !== "object") return null;
  // Doesn't care whether it's Tiled — `projectMeetingMap` also projects old-format maps,
  // so if a layout comes out, staff on an old custom map get placed too. A map that
  // can't be projected simply gets a null layout.
  const layout = deriveChannelMotionLayout(channel, []);
  if (!layout) return null;

  const seats = layout.deskSeatTiles.map((tile, index) => ({ ...tile, number: index + 1 }));

  // Standing tiles: avoid seats (both desk and shared) and the entrance.
  const blockedTiles = new Set(
    layout.seats.map((seat) =>
      key({
        col: Math.floor(seat.x / CHANNEL_TILE_SIZE),
        row: Math.floor(seat.y / CHANNEL_TILE_SIZE),
      }),
    ),
  );
  const spawn = effectiveMapSpawn(data, channel.mapConfig);
  if (spawn) blockedTiles.add(key({ col: spawn.col, row: spawn.row }));

  const cols = layout.bounds.width / CHANNEL_TILE_SIZE;
  const rows = layout.bounds.height / CHANNEL_TILE_SIZE;
  const standable = (col: number, row: number) =>
    layout.isWalkable(col, row) &&
    !blockedTiles.has(key({ col, row })) &&
    layout.canStandAt({ x: (col + 0.5) * CHANNEL_TILE_SIZE, y: (row + 0.5) * CHANNEL_TILE_SIZE });
  // Only tiles whose all 8 neighbors are open floor — never stand and block a one-tile-wide passage.
  const open = (col: number, row: number) => {
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) if (!layout.isWalkable(col + dx, row + dy)) return false;
    return true;
  };

  const strict: Tile[] = [];
  const relaxed: Tile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!standable(col, row)) continue;
      relaxed.push({ col, row });
      if (open(col, row)) strict.push({ col, row });
    }
  }
  return {
    seats,
    standing: strict.length > 0 ? strict : relaxed,
    reserved: layout.executiveSeatTiles.map((tile) => ({ ...tile })),
  };
}

export function seatNumberAt(
  seats: readonly DeskSeat[],
  col: number | null,
  row: number | null,
): number | null {
  if (col === null || row === null) return null;
  return seats.find((seat) => seat.col === col && seat.row === row)?.number ?? null;
}

/** FNV-1a — the same NPC always starts the search from the same tile. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fills unseated NPCs in id order, starting from the lowest-numbered empty desk seat.
 * Once seats run out, they're placed on standing tiles. `occupied` is **every** NPC
 * position in the channel — even a sleeping NPC's seat is remembered.
 */
export function planPlacements(
  unplaced: readonly { id: string }[],
  map: SeatingMap,
  occupied: readonly { positionX: number | null; positionY: number | null }[],
): Placement[] {
  const taken = new Set(
    occupied
      .filter((n) => Number.isInteger(n.positionX) && Number.isInteger(n.positionY))
      .map((n) => `${n.positionX},${n.positionY}`),
  );
  const plan: Placement[] = [];
  for (const npc of [...unplaced].sort((a, b) => a.id.localeCompare(b.id))) {
    const seat = map.seats.find((candidate) => !taken.has(key(candidate)));
    if (seat) {
      taken.add(key(seat));
      plan.push({ npcId: npc.id, col: seat.col, row: seat.row, seated: true });
      continue;
    }
    const count = map.standing.length;
    const start = count > 0 ? hash(npc.id) % count : 0;
    for (let i = 0; i < count; i += 1) {
      const tile = map.standing[(start + i) % count];
      if (taken.has(key(tile))) continue;
      taken.add(key(tile));
      plan.push({ npcId: npc.id, col: tile.col, row: tile.row, seated: false });
      break;
    }
  }
  return plan;
}
