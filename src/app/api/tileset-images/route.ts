import { db, tilesetImages } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// POST /api/tileset-images — upsert a tileset image by name
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, image, tilewidth, tileheight, columns, tilecount } = body;
  if (!name || !image) return NextResponse.json({ errorCode: "missing_required_fields", error: "name and image required" }, { status: 400 });

  // Check if already exists
  const existing = await db.select({ id: tilesetImages.id })
    .from(tilesetImages).where(eq(tilesetImages.name, name)).limit(1);

  if (existing.length > 0) {
    return NextResponse.json({ id: existing[0].id, existed: true });
  }

  const [inserted] = await db.insert(tilesetImages).values({
    name,
    image,
    tilewidth: tilewidth ?? 32,
    tileheight: tileheight ?? 32,
    columns: columns ?? 1,
    tilecount: tilecount ?? 1,
  }).returning();

  return NextResponse.json({ id: inserted.id, existed: false }, { status: 201 });
}
