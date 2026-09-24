import { NextRequest, NextResponse } from "next/server";
import { db, isPostgres } from "@/db";
import { npcs, channels } from "@/db";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { selectNpcById } from "@/lib/npc-projection";
import { isUniqueViolation } from "@/lib/db-unique-violation";
import { seatingMapFor, seatNumberAt } from "@/lib/seat-assignment";

async function verifyNpcOwnership(req: NextRequest, npcId: string) {
  const userId = getUserId(req);
  if (!userId) return { errorCode: "unauthorized", error: "Unauthorized", status: 401 };

  const [npc] = await db.select().from(npcs).where(eq(npcs.id, npcId));
  if (!npc) return { errorCode: "npc_not_found", error: "NPC not found", status: 404 };

  const [channel] = await db.select().from(channels).where(eq(channels.id, npc.channelId));
  if (!channel || channel.ownerId !== userId) {
    return {
      errorCode: "only_channel_owner_can_modify_npcs",
      error: "Only channel owner can modify NPCs",
      status: 403,
    };
  }

  return { npc, channel, userId };
}

/**
 * An NPC is now "a profile's seat per channel". The seat is also the only thing this route can change —
 * name, appearance and persona have the Hermes profile as source of truth and change only through the profile API.
 *
 * Old fields are rejected with 400 rather than silently ignored: the old PATCH wrote `body.name` to
 * `npcs.name` while putting the projected (profile's) name in the response, so a screen saying the name changed and
 * a DB where nothing changed disagreed while looking like success.
 */
const PLACEMENT_FIELDS = new Set(["positionX", "positionY", "direction"]);
const DIRECTIONS = ["up", "down", "left", "right"];

async function updatePlacement(req: NextRequest, id: string) {
  const result = await verifyNpcOwnership(req, id);
  if ("error" in result) {
    return NextResponse.json(
      { errorCode: result.errorCode, error: result.error },
      { status: result.status },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rejected = Object.keys(body).filter((k) => !PLACEMENT_FIELDS.has(k));
  if (rejected.length > 0) {
    return NextResponse.json(
      {
        errorCode: "unsupported_npc_field",
        error: `Unsupported NPC field(s): ${rejected.join(", ")}`,
        fields: rejected,
      },
      { status: 400 },
    );
  }

  if (typeof body.positionX === "number" || typeof body.positionY === "number") {
    // Seat changes only to desk seats. Standing cells use system assignment only.
    // Maps where seats cannot be computed (old custom maps, no map) pass as before.
    const seating = seatingMapFor(result.channel);
    const col = typeof body.positionX === "number" ? body.positionX : result.npc.positionX;
    const row = typeof body.positionY === "number" ? body.positionY : result.npc.positionY;
    if (seating && seating.seats.length > 0 && seatNumberAt(seating.seats, col, row) === null) {
      return NextResponse.json(
        { errorCode: "not_a_desk_seat", error: "NPC seats must be desk chairs" },
        { status: 400 },
      );
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
  };
  if (typeof body.positionX === "number") updates.positionX = body.positionX;
  if (typeof body.positionY === "number") updates.positionY = body.positionY;
  if (typeof body.direction === "string") {
    updates.direction = DIRECTIONS.includes(body.direction) ? body.direction : "down";
  }

  await db.update(npcs).set(updates).where(eq(npcs.id, id));
  return NextResponse.json({ npc: await selectNpcById(id) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await updatePlacement(req, id);
  } catch (err) {
    // Two NPCs cannot stand on one tile — `npcs_channel_position_unique` blocks it.
    // The client sees this 409, keeps placement mode and quietly waits for another cell.
    // Without this mapping the same situation goes out as 500 and only a "배치 실패" toast appears.
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { errorCode: "tile_already_occupied", error: "This tile is already occupied" },
        { status: 409 },
      );
    }
    console.error("Failed to update NPC:", err);
    return NextResponse.json(
      { errorCode: "failed_to_update_npc", error: "Failed to update NPC" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return PATCH(req, { params });
}
