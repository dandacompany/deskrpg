import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { validateMapTemplate } from "@/lib/map-editor-utils";
import { parseDbArray, parseDbJson } from "@/lib/db-json";

type Params = { params: Promise<{ id: string }> };

// GET /api/map-templates/:id — full template with layers and objects
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const [template] = await db
      .select()
      .from(mapTemplates)
      .where(eq(mapTemplates.id, id))
      .limit(1);

    if (!template) {
      return NextResponse.json({ errorCode: "template_not_found", error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({
      template: {
        ...template,
        layers: parseDbJson(template.layers) ?? template.layers,
        objects: parseDbArray(template.objects),
        tiledJson: parseDbJson(template.tiledJson) ?? template.tiledJson,
      },
    });
  } catch (err) {
    console.error("Failed to get map template:", err);
    return NextResponse.json({ errorCode: "failed_to_get_template", error: "Failed to get template" }, { status: 500 });
  }
}

// PUT /api/map-templates/:id — update template
export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { name, icon, description, cols, rows, layers, objects, spawnCol, spawnRow, tags, tiledJson } = body;

    const validationError = validateMapTemplate({ name, cols, rows, layers, spawnCol, spawnRow, tiledJson });
    if (validationError) {
      return NextResponse.json(
        { errorCode: "map_template_invalid", error: validationError },
        { status: 400 },
      );
    }

    const [updated] = await db
      .update(mapTemplates)
      .set({
        name: name.trim(),
        icon: icon || "🗺️",
        description: description?.trim() || null,
        cols,
        rows,
        layers: layers ? jsonForDb(layers) : undefined,
        objects: objects ? jsonForDb(objects) : undefined,
        tiledJson: tiledJson ? jsonForDb(tiledJson) : undefined,
        spawnCol,
        spawnRow,
        tags: tags?.trim() || null,
        updatedAt: new Date().toISOString() as unknown as Date,
      })
      .where(eq(mapTemplates.id, id))
      .returning();

    if (!updated) {
      return NextResponse.json({ errorCode: "template_not_found", error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({
      template: {
        ...updated,
        layers: parseDbJson(updated.layers) ?? updated.layers,
        objects: parseDbArray(updated.objects),
        tiledJson: parseDbJson(updated.tiledJson) ?? updated.tiledJson,
      },
    });
  } catch (err) {
    console.error("Failed to update map template:", err);
    return NextResponse.json({ errorCode: "failed_to_update_template", error: "Failed to update template" }, { status: 500 });
  }
}

// DELETE /api/map-templates/:id — delete template
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  try {
    const deleted = await db
      .delete(mapTemplates)
      .where(eq(mapTemplates.id, id))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ errorCode: "template_not_found", error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete map template:", err);
    return NextResponse.json({ errorCode: "failed_to_delete_template", error: "Failed to delete template" }, { status: 500 });
  }
}
