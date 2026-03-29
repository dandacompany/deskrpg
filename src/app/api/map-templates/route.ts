import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { validateMapTemplate } from "@/lib/map-editor-utils";
import { desc } from "drizzle-orm";

// GET /api/map-templates — list all templates (lightweight, no layers/objects)
export async function GET() {
  try {
    const rows = await db
      .select({
        id: mapTemplates.id,
        name: mapTemplates.name,
        icon: mapTemplates.icon,
        description: mapTemplates.description,
        cols: mapTemplates.cols,
        rows: mapTemplates.rows,
        tags: mapTemplates.tags,
        createdAt: mapTemplates.createdAt,
      })
      .from(mapTemplates)
      .orderBy(desc(mapTemplates.createdAt));

    return NextResponse.json({ templates: rows });
  } catch (err) {
    console.error("Failed to list map templates:", err);
    return NextResponse.json({ error: "Failed to list templates" }, { status: 500 });
  }
}

// POST /api/map-templates — create new template
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { name, icon, description, cols, rows, layers, objects, spawnCol, spawnRow, tags, tiledJson } = body;

    const validationError = validateMapTemplate({ name, cols, rows, layers, spawnCol, spawnRow, tiledJson });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const [template] = await db
      .insert(mapTemplates)
      .values({
        name: name.trim(),
        icon: icon || "🗺️",
        description: description?.trim() || null,
        cols,
        rows,
        layers: layers ? jsonForDb(layers) : null,
        objects: objects ? jsonForDb(objects) : null,
        tiledJson: tiledJson ? jsonForDb(tiledJson) : null,
        spawnCol,
        spawnRow,
        tags: tags?.trim() || null,
        createdBy: userId,
      })
      .returning();

    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    console.error("Failed to create map template:", err);
    return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
  }
}
