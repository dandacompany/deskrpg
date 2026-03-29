import { db } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// GET /api/stamps — list all stamps (lightweight: no tilesets)
export async function GET() {
  const rows = await db
    .select({
      id: stamps.id,
      name: stamps.name,
      cols: stamps.cols,
      rows: stamps.rows,
      thumbnail: stamps.thumbnail,
      layers: stamps.layers,
      createdAt: stamps.createdAt,
    })
    .from(stamps)
    .orderBy(desc(stamps.createdAt));

  const result = rows.map((r) => ({
    id: r.id,
    name: r.name,
    cols: r.cols,
    rows: r.rows,
    thumbnail: r.thumbnail,
    layerNames: Array.isArray(r.layers)
      ? (r.layers as Array<{ name: string }>).map((l) => l.name)
      : [],
    createdAt: r.createdAt,
  }));

  return NextResponse.json(result);
}

// POST /api/stamps — create new stamp
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, cols, rows: stampRows, tileWidth, tileHeight, layers, tilesets, thumbnail } = body;

  if (!name || !cols || !stampRows || !layers || !tilesets) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const userId = getUserId(req);

  const [created] = await db
    .insert(stamps)
    .values({
      name,
      cols,
      rows: stampRows,
      tileWidth: tileWidth ?? 32,
      tileHeight: tileHeight ?? 32,
      layers,
      tilesets,
      thumbnail: thumbnail ?? null,
      createdBy: userId ?? null,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
