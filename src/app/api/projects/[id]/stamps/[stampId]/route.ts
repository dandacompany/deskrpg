import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireOwnedProject } from "@/lib/project-access";

// DELETE /api/projects/[id]/stamps/[stampId] — unlink a stamp from a project
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; stampId: string }> }) {
  const { id: projectId, stampId } = await params;
  const access = await requireOwnedProject(req, projectId);
  if ("error" in access && !("project" in access)) return access.error;
  await db.delete(projectStamps).where(
    and(eq(projectStamps.projectId, projectId), eq(projectStamps.stampId, stampId))
  );
  return NextResponse.json({ ok: true });
}
