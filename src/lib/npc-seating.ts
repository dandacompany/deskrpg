import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db, channels, npcs, nowForDb } from "@/db";
import { isUniqueViolation } from "./db-unique-violation";
import { planPlacements, seatingMapFor, type DeskSeat, type SeatingMap } from "./seat-assignment";

export type PlacementResult = { seated: number; standing: number; failed: number };

const MAX_REPLANS = 3;

async function loadSeatingMap(channelId: string): Promise<SeatingMap | null> {
  const [channel] = await db
    .select({ mapData: channels.mapData, mapConfig: channels.mapConfig })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return channel ? seatingMapFor(channel) : null;
}

/** Used by the roster to attach seat numbers. Null if the map can't be read. */
export async function channelSeats(channelId: string): Promise<DeskSeat[] | null> {
  return (await loadSeatingMap(channelId))?.seats ?? null;
}

/**
 * Places every employee who's clocked in but has no seat — empty desk seats first, standing
 * spots once those are full.
 *
 * This is the system-assignment path. The user's only way to change seats is
 * `PATCH /api/npcs/[id]`, but hiring can also happen with no request from the channel owner
 * (adding a profile to a shared gateway), so this writes directly. No failure here ever
 * breaks the hiring itself — it's just counted as `failed` and left at that.
 */
export async function placeUnplacedNpcs(channelId: string): Promise<PlacementResult> {
  let result: PlacementResult;
  try {
    result = await placeUnplacedNpcsInternal(channelId);
  } catch (err) {
    console.error("[seating] placement failed", { channelId, err });
    const failed = await countActiveUnplaced(channelId).catch(() => 0);
    result = { seated: 0, standing: 0, failed };
  }
  if (result.failed > 0) {
    console.warn("[seating] active NPCs left without a spot", { channelId, failed: result.failed });
  }
  return result;
}

async function countActiveUnplaced(channelId: string): Promise<number> {
  const left = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(
      and(
        eq(npcs.channelId, channelId),
        eq(npcs.active, true),
        or(isNull(npcs.positionX), isNull(npcs.positionY)),
      ),
    );
  return left.length;
}

/**
 * Reverts an employee sitting in the CEO seat back to unplaced — the placement step right
 * below then seats them in an empty seat.
 *
 * An employee placed back when the CEO seat was seat #1 (before 2026.920.7) is still sitting
 * in the CEO chair. The CEO seat is no longer in the seat list, so the user can't move them
 * out of it via "change seat" either, so the system moves them instead.
 */
async function vacateReservedSeats(channelId: string, map: SeatingMap): Promise<void> {
  for (const tile of map.reserved) {
    await db
      .update(npcs)
      .set({ positionX: null, positionY: null, updatedAt: nowForDb() })
      .where(
        and(
          eq(npcs.channelId, channelId),
          eq(npcs.positionX, tile.col),
          eq(npcs.positionY, tile.row),
        ),
      );
  }
}

async function placeUnplacedNpcsInternal(channelId: string): Promise<PlacementResult> {
  const result: PlacementResult = { seated: 0, standing: 0, failed: 0 };
  const map = await loadSeatingMap(channelId);
  if (map) await vacateReservedSeats(channelId, map);

  for (let attempt = 0; attempt < MAX_REPLANS; attempt += 1) {
    const roster = await db
      .select({
        id: npcs.id,
        active: npcs.active,
        positionX: npcs.positionX,
        positionY: npcs.positionY,
      })
      .from(npcs)
      .where(eq(npcs.channelId, channelId))
      .orderBy(asc(npcs.id));
    const unplaced = roster.filter(
      (npc) => npc.active && !(Number.isInteger(npc.positionX) && Number.isInteger(npc.positionY)),
    );
    if (unplaced.length === 0) return result;
    if (!map) return { ...result, failed: unplaced.length };

    const plan = planPlacements(unplaced, map, roster);
    let conflict = false;
    for (const step of plan) {
      try {
        const updated = await db
          .update(npcs)
          .set({ positionX: step.col, positionY: step.row, updatedAt: nowForDb() })
          .where(and(eq(npcs.id, step.npcId), or(isNull(npcs.positionX), isNull(npcs.positionY))))
          .returning({ id: npcs.id });
        if (updated.length === 0) continue;
        if (step.seated) result.seated += 1;
        else result.standing += 1;
      } catch (err) {
        // Another request claimed the same slot first (npcs_channel_position_unique) — re-read
        // and replan.
        if (!isUniqueViolation(err)) throw err;
        conflict = true;
        break;
      }
    }
    if (!conflict) return { ...result, failed: unplaced.length - plan.length };
  }

  const left = await countActiveUnplaced(channelId);
  return { ...result, failed: left };
}

/**
 * Runs once at server boot — moves employees created with no seat and employees sitting in
 * the CEO seat. Idempotent.
 *
 * Iterates every channel with a clocked-in employee. An employee in the CEO seat has
 * coordinates, so they're not filtered out as "unplaced", and knowing which tile is the CEO
 * seat requires reading the channel map.
 */
export async function placeAllUnplacedNpcs(): Promise<PlacementResult & { channels: number }> {
  const rows = await db
    .selectDistinct({ channelId: npcs.channelId })
    .from(npcs)
    .where(eq(npcs.active, true));
  const total = { seated: 0, standing: 0, failed: 0, channels: rows.length };
  for (const { channelId } of rows) {
    const one = await placeUnplacedNpcs(channelId);
    total.seated += one.seated;
    total.standing += one.standing;
    total.failed += one.failed;
  }
  return total;
}
