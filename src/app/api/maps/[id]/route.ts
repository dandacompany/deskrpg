import { NextRequest, NextResponse } from "next/server";
import { db, isPostgres } from "@/db";
import { maps } from "@/db";
import { eq } from "drizzle-orm";

// GET /api/maps/:id — load map data
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rows = await db.select().from(maps).where(eq(maps.id, id));

    if (rows.length === 0) {
      return NextResponse.json({ errorCode: "map_not_found", error: "Map not found" }, { status: 404 });
    }

    const map = rows[0];
    return NextResponse.json({
      id: map.id,
      name: map.name,
      config: map.config,
    });
  } catch (err) {
    console.error("Failed to fetch map:", err);
    return NextResponse.json({ errorCode: "failed_to_fetch_map", error: "Failed to fetch map" }, { status: 500 });
  }
}

// POST /api/maps/:id — save map data
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { layers } = body;

    if (!layers || !layers.floor || !layers.walls || !layers.furniture) {
      return NextResponse.json({ errorCode: "invalid_map_data", error: "Invalid map data" }, { status: 400 });
    }

    // Upsert: update if exists, insert if not
    const existing = await db.select().from(maps).where(eq(maps.id, id));

    if (existing.length > 0) {
      await db
        .update(maps)
        .set({
          config: layers,
          updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
        })
        .where(eq(maps.id, id));
    } else {
      await db.insert(maps).values({
        id,
        name: `Map: ${id}`,
        tilemapPath: `generated/${id}`,
        config: layers,
      });
    }

    return NextResponse.json({ success: true, id });
  } catch (err) {
    console.error("Failed to save map:", err);
    return NextResponse.json({ errorCode: "failed_to_save_map", error: "Failed to save map" }, { status: 500 });
  }
}
