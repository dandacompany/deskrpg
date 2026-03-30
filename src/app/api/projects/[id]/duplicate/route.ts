import { db, projects, projectTilesets, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// POST /api/projects/[id]/duplicate — duplicate a project with its asset links
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [original] = await db.select().from(projects).where(eq(projects.id, id));
  if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [copy] = await db.insert(projects).values({
    name: `${original.name} (copy)`,
    thumbnail: original.thumbnail,
    tiledJson: original.tiledJson,
    settings: original.settings,
  }).returning();

  // Copy tileset links
  const tsLinks = await db.select().from(projectTilesets).where(eq(projectTilesets.projectId, id));
  for (const link of tsLinks) {
    await db.insert(projectTilesets).values({ projectId: copy.id, tilesetId: link.tilesetId, firstgid: link.firstgid });
  }

  // Copy stamp links
  const stLinks = await db.select().from(projectStamps).where(eq(projectStamps.projectId, id));
  for (const link of stLinks) {
    await db.insert(projectStamps).values({ projectId: copy.id, stampId: link.stampId });
  }

  return NextResponse.json(copy, { status: 201 });
}
