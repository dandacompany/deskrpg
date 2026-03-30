import { db, projects, projectTilesets, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// POST /api/projects/[id]/duplicate — duplicate a project (owner only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const [original] = await db.select().from(projects).where(
    and(eq(projects.id, id), eq(projects.createdBy, userId))
  );
  if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [copy] = await db.insert(projects).values({
    name: `${original.name} (copy)`,
    thumbnail: original.thumbnail,
    tiledJson: original.tiledJson,
    settings: original.settings,
    createdBy: userId,
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
