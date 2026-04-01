import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireOwnedProject } from "@/lib/project-access";

// POST /api/projects/[id]/tilesets — link a tileset to a project (idempotent)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const access = await requireOwnedProject(req, projectId);
  if ("error" in access && !("project" in access)) return access.error;
  const { tilesetId, firstgid } = await req.json();
  if (!tilesetId || firstgid == null) {
    return NextResponse.json({ errorCode: "missing_required_fields", error: "tilesetId and firstgid required" }, { status: 400 });
  }

  // Check if already linked
  const [existing] = await db.select({ id: projectTilesets.id })
    .from(projectTilesets)
    .where(and(eq(projectTilesets.projectId, projectId), eq(projectTilesets.tilesetId, tilesetId)));

  if (existing) {
    return NextResponse.json({ id: existing.id, alreadyLinked: true });
  }

  const [created] = await db.insert(projectTilesets).values({ projectId, tilesetId, firstgid }).returning();
  return NextResponse.json(created, { status: 201 });
}
