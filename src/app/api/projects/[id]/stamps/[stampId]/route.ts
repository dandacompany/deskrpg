import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

// DELETE /api/projects/[id]/stamps/[stampId] — unlink a stamp from a project
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; stampId: string }> }) {
  const { id: projectId, stampId } = await params;
  await db.delete(projectStamps).where(
    and(eq(projectStamps.projectId, projectId), eq(projectStamps.stampId, stampId))
  );
  return NextResponse.json({ ok: true });
}
