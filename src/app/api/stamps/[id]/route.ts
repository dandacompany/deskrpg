import { db, jsonForDb } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/stamps/:id — full stamp data (including tilesets)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [stamp] = await db.select().from(stamps).where(eq(stamps.id, id));
  if (!stamp) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // SQLite stores JSON as text — parse if needed
  const result = {
    ...stamp,
    layers: typeof stamp.layers === 'string' ? JSON.parse(stamp.layers) : stamp.layers,
    tilesets: typeof stamp.tilesets === 'string' ? JSON.parse(stamp.tilesets) : stamp.tilesets,
  };
  return NextResponse.json(result);
}

// DELETE /api/stamps/:id
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(stamps).where(eq(stamps.id, id));
  return NextResponse.json({ ok: true });
}

// PUT /api/stamps/:id — update stamp
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}
