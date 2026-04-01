import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireOwnedProject } from "@/lib/project-access";

// DELETE /api/projects/[id]/tilesets/[tilesetId] — unlink a tileset from a project
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; tilesetId: string }> }) {
  const { id: projectId, tilesetId } = await params;
  const access = await requireOwnedProject(req, projectId);
  if ("error" in access && !("project" in access)) return access.error;
  await db.delete(projectTilesets).where(
    and(eq(projectTilesets.projectId, projectId), eq(projectTilesets.tilesetId, tilesetId))
  );
  return NextResponse.json({ ok: true });
}
