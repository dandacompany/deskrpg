import { db, projects, projectTilesets, projectStamps, tilesetImages, stamps, jsonForDb, isPostgres } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { parseDbArray, parseDbJson } from "@/lib/db-json";
import { requireOwnedProject } from "@/lib/project-access";

// GET /api/projects/[id] — project detail with linked tilesets + stamps
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await requireOwnedProject(req, id);
    if ("error" in result && !("project" in result)) return result.error;
    const { project } = result as { project: typeof projects.$inferSelect };

  // Load linked tilesets
  const tilesetRows = await db
    .select({
      id: tilesetImages.id,
      name: tilesetImages.name,
      tilewidth: tilesetImages.tilewidth,
      tileheight: tilesetImages.tileheight,
      columns: tilesetImages.columns,
      tilecount: tilesetImages.tilecount,
      image: tilesetImages.image,
      firstgid: projectTilesets.firstgid,
    })
    .from(projectTilesets)
    .innerJoin(tilesetImages, eq(projectTilesets.tilesetId, tilesetImages.id))
    .where(eq(projectTilesets.projectId, id));

  // Load linked stamps
  const stampRows = await db
    .select({
      id: stamps.id,
      name: stamps.name,
      cols: stamps.cols,
      rows: stamps.rows,
      thumbnail: stamps.thumbnail,
      layers: stamps.layers,
    })
    .from(projectStamps)
    .innerJoin(stamps, eq(projectStamps.stampId, stamps.id))
    .where(eq(projectStamps.projectId, id));

  const parsedProject = {
    ...project,
    tiledJson: parseDbJson(project.tiledJson) ?? project.tiledJson,
    settings: parseDbJson(project.settings) ?? project.settings,
  };

  const parsedStamps = stampRows.map((s) => ({
    ...s,
    layers: parseDbJson(s.layers) ?? s.layers,
    layerNames: parseDbArray<{ name: string }>(s.layers).map((l) => l.name) ?? [],
  }));

    return NextResponse.json({ project: parsedProject, tilesets: tilesetRows, stamps: parsedStamps });
  } catch (err) {
    console.error("Failed to fetch project:", err);
    return NextResponse.json({ errorCode: "failed_to_fetch_project", error: "Failed to fetch project" }, { status: 500 });
  }
}

// PUT /api/projects/[id] — save project (owner only)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await requireOwnedProject(req, id);
    if ("error" in result && !("project" in result)) return result.error;

    const body = await req.json();
    const { tiledJson, thumbnail, settings, name } = body;

    const updates: Record<string, unknown> = {
      updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
    };
    if (tiledJson !== undefined) {
      // Restore tileset images from DB if stripped (empty string)
      if (tiledJson.tilesets) {
        for (const ts of tiledJson.tilesets) {
          if (ts.image === '' || !ts.image) {
            try {
              const [dbTs] = await db.select({ image: tilesetImages.image })
                .from(tilesetImages).where(eq(tilesetImages.name, ts.name)).limit(1);
              if (dbTs) ts.image = dbTs.image;
            } catch { /* ignore */ }
          }
        }
      }
      updates.tiledJson = jsonForDb(tiledJson);
    }
    if (thumbnail !== undefined) updates.thumbnail = thumbnail;
    if (settings !== undefined) updates.settings = jsonForDb(settings);
    if (name !== undefined) updates.name = name;

    await db.update(projects).set(updates).where(eq(projects.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save project:", err);
    return NextResponse.json({ errorCode: "failed_to_save_project", error: "Failed to save project" }, { status: 500 });
  }
}

// DELETE /api/projects/[id] — delete project (owner only)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await requireOwnedProject(req, id);
    if ("error" in result && !("project" in result)) return result.error;

    await db.delete(projects).where(eq(projects.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete project:", err);
    return NextResponse.json({ errorCode: "failed_to_delete_project", error: "Failed to delete project" }, { status: 500 });
  }
}
