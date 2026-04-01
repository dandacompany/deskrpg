import { db, jsonForDb } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { parseDbJson } from "@/lib/db-json";

// GET /api/stamps/:id — full stamp data (including tilesets)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [stamp] = await db.select().from(stamps).where(eq(stamps.id, id));
    if (!stamp) {
      return NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 });
    }
    const result = {
      ...stamp,
      layers: parseDbJson(stamp.layers) ?? stamp.layers,
      tilesets: parseDbJson(stamp.tilesets) ?? stamp.tilesets,
    };
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch stamp:", error);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_stamp", error: "Failed to fetch stamp" },
      { status: 500 },
    );
  }
}

// DELETE /api/stamps/:id
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(stamps).where(eq(stamps.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to delete stamp:", error);
    return NextResponse.json(
      { errorCode: "failed_to_delete_stamp", error: "Failed to delete stamp" },
      { status: 500 },
    );
  }
}

// PUT /api/stamps/:id — update stamp
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, cols, rows, layers, tilesets, thumbnail } = body;

    await db
      .update(stamps)
      .set({
        ...(name !== undefined && { name }),
        ...(cols !== undefined && { cols }),
        ...(rows !== undefined && { rows }),
        ...(layers !== undefined && { layers: jsonForDb(layers) }),
        ...(tilesets !== undefined && { tilesets: jsonForDb(tilesets) }),
        ...(thumbnail !== undefined && { thumbnail }),
      })
      .where(eq(stamps.id, id));

    const [updated] = await db.select().from(stamps).where(eq(stamps.id, id));
    if (!updated) {
      return NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ...updated,
      layers: parseDbJson(updated.layers) ?? updated.layers,
      tilesets: parseDbJson(updated.tilesets) ?? updated.tilesets,
    });
  } catch (error) {
    console.error("Failed to update stamp:", error);
    return NextResponse.json(
      { errorCode: "failed_to_update_stamp", error: "Failed to update stamp" },
      { status: 500 },
    );
  }
}
