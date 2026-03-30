import { db, tilesetImages } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/tilesets?name=xxx&builtIn=true — get tileset image by name or list all
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const builtInParam = req.nextUrl.searchParams.get("builtIn");
  if (!name) {
    // List tileset names (without image data), optionally filtered by builtIn
    let query = db
      .select({ id: tilesetImages.id, name: tilesetImages.name, tilewidth: tilesetImages.tilewidth, tileheight: tilesetImages.tileheight, columns: tilesetImages.columns, tilecount: tilesetImages.tilecount })
      .from(tilesetImages)
      .$dynamic();
    if (builtInParam === "true") {
      query = query.where(eq(tilesetImages.builtIn, true));
    } else if (builtInParam === "false") {
      query = query.where(eq(tilesetImages.builtIn, false));
    }
    const rows = await query;
    return NextResponse.json(rows);
  }

  const [row] = await db.select().from(tilesetImages).where(eq(tilesetImages.name, name));
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}

// POST /api/tilesets — save or update tileset image
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, tilewidth, tileheight, columns, tilecount, image } = body;

  if (!name || !image || !columns || !tilecount) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Upsert: if name exists, update; otherwise insert
  const [existing] = await db.select({ id: tilesetImages.id }).from(tilesetImages).where(eq(tilesetImages.name, name));

  if (existing) {
    await db.update(tilesetImages).set({ image, tilewidth: tilewidth ?? 32, tileheight: tileheight ?? 32, columns, tilecount }).where(eq(tilesetImages.id, existing.id));
    return NextResponse.json({ id: existing.id, updated: true });
  }

  const [created] = await db.insert(tilesetImages).values({
    name,
    tilewidth: tilewidth ?? 32,
    tileheight: tileheight ?? 32,
    columns,
    tilecount,
    image,
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
