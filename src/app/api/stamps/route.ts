import { db, jsonForDb } from "@/db";
import { stamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { parseDbArray, parseDbJson } from "@/lib/db-json";

// GET /api/stamps?builtIn=true — list stamps (lightweight: no tilesets), optionally filtered by builtIn
export async function GET(req: NextRequest) {
  try {
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
      layerNames: parseDbArray<{ name: string }>(r.layers).map((l) => l.name),
      createdAt: r.createdAt,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to fetch stamps:", error);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_stamps", error: "Failed to fetch stamps" },
      { status: 500 },
    );
  }
}

// POST /api/stamps — create new stamp
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, cols, rows: stampRows, tileWidth, tileHeight, layers, tilesets, thumbnail } = body;

    if (!name || !cols || !stampRows || !layers || !tilesets) {
      return NextResponse.json(
        { errorCode: "missing_required_fields", error: "Missing required fields" },
        { status: 400 },
      );
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

    return NextResponse.json({
      ...created,
      layers: parseDbJson(created.layers) ?? created.layers,
      tilesets: parseDbJson(created.tilesets) ?? created.tilesets,
    }, { status: 201 });
  } catch (error) {
    console.error("Failed to create stamp:", error);
    return NextResponse.json(
      { errorCode: "failed_to_create_stamp", error: "Failed to create stamp" },
      { status: 500 },
    );
  }
}
