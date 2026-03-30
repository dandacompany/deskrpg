import { db, projects, projectTilesets, projectStamps, tilesetImages, stamps, jsonForDb, isPostgres } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/projects/[id] — project detail with linked tilesets + stamps
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    tiledJson: typeof project.tiledJson === "string" ? JSON.parse(project.tiledJson) : project.tiledJson,
    settings: typeof project.settings === "string" ? JSON.parse(project.settings) : project.settings,
  };

  const parsedStamps = stampRows.map((s) => ({
    ...s,
    layers: typeof s.layers === "string" ? JSON.parse(s.layers) : s.layers,
    layerNames: (typeof s.layers === "string" ? JSON.parse(s.layers) : s.layers)?.map((l: { name: string }) => l.name) ?? [],
  }));

  return NextResponse.json({ project: parsedProject, tilesets: tilesetRows, stamps: parsedStamps });
}

// PUT /api/projects/[id] — save project
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { tiledJson, thumbnail, settings, name } = body;

  const updates: Record<string, unknown> = {
    updatedAt: isPostgres ? new Date() : new Date().toISOString(),
  };
  if (tiledJson !== undefined) updates.tiledJson = jsonForDb(tiledJson);
  if (thumbnail !== undefined) updates.thumbnail = thumbnail;
  if (settings !== undefined) updates.settings = jsonForDb(settings);
  if (name !== undefined) updates.name = name;

  await db.update(projects).set(updates).where(eq(projects.id, id));
  return NextResponse.json({ ok: true });
}

// DELETE /api/projects/[id] — delete project
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(projects).where(eq(projects.id, id));
  return NextResponse.json({ ok: true });
}
