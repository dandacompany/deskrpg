import { db, jsonForDb } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// GET /api/stamps?builtIn=true — list stamps (lightweight: no tilesets), optionally filtered by builtIn
export async function GET(req: NextRequest) {
  const builtInParam = req.nextUrl.searchParams.get("builtIn");
  let query = db
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
    .orderBy(desc(stamps.createdAt))
    .$dynamic();
  if (builtInParam === "true") {
    query = query.where(eq(stamps.builtIn, true));
  } else if (builtInParam === "false") {
    query = query.where(eq(stamps.builtIn, false));
  }
  const rows = await query;

  const result = rows.map((r) => ({
    id: r.id,
    name: r.name,
    cols: r.cols,
    rows: r.rows,
    thumbnail: r.thumbnail,
    layerNames: (() => {
      const parsed = typeof r.layers === 'string' ? JSON.parse(r.layers) : r.layers;
      return Array.isArray(parsed) ? (parsed as Array<{ name: string }>).map((l) => l.name) : [];
    })(),
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
      layers: jsonForDb(layers),
      tilesets: jsonForDb(tilesets),
      thumbnail: thumbnail ?? null,
      createdBy: userId ?? null,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
