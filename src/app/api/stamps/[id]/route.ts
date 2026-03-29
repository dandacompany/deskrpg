import { db, jsonForDb } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/stamps/:id — full stamp data (including tilesets)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [stamp] = await db.select().from(stamps).where(eq(stamps.id, id));
  if (!stamp) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(stamp);
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
  const { name, layers, tilesets, thumbnail } = body;

  await db
    .update(stamps)
    .set({
      ...(name !== undefined && { name }),
      ...(layers !== undefined && { layers: jsonForDb(layers) }),
      ...(tilesets !== undefined && { tilesets: jsonForDb(tilesets) }),
      ...(thumbnail !== undefined && { thumbnail }),
    })
    .where(eq(stamps.id, id));

  const [updated] = await db.select().from(stamps).where(eq(stamps.id, id));
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}
