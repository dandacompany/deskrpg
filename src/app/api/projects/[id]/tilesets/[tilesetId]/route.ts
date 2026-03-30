import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

// DELETE /api/projects/[id]/tilesets/[tilesetId] — unlink a tileset from a project
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; tilesetId: string }> }) {
  const { id: projectId, tilesetId } = await params;
  await db.delete(projectTilesets).where(
    and(eq(projectTilesets.projectId, projectId), eq(projectTilesets.tilesetId, tilesetId))
  );
  return NextResponse.json({ ok: true });
}
