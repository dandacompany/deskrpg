import { db, projects, projectTilesets, projectStamps, tilesetImages, stamps, jsonForDb, isPostgres } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

async function getOwnedProject(req: NextRequest, id: string) {
  const userId = getUserId(req);
  if (!userId) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const [project] = await db.select().from(projects).where(
    and(eq(projects.id, id), eq(projects.createdBy, userId))
  );
  if (!project) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };

  return { project, userId };
}

// GET /api/projects/[id] — project detail with linked tilesets + stamps
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOwnedProject(req, id);
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

// PUT /api/projects/[id] — save project (owner only)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOwnedProject(req, id);
  if ("error" in result && !("project" in result)) return result.error;

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

// DELETE /api/projects/[id] — delete project (owner only)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOwnedProject(req, id);
  if ("error" in result && !("project" in result)) return result.error;

  await db.delete(projects).where(eq(projects.id, id));
  return NextResponse.json({ ok: true });
}
