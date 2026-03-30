import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

// POST /api/projects/[id]/stamps — link a stamp to a project (idempotent)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { stampId } = await req.json();
  if (!stampId) {
    return NextResponse.json({ error: "stampId required" }, { status: 400 });
  }

  // Check if already linked
  const [existing] = await db.select({ id: projectStamps.id })
    .from(projectStamps)
    .where(and(eq(projectStamps.projectId, projectId), eq(projectStamps.stampId, stampId)));

  if (existing) {
    return NextResponse.json({ id: existing.id, alreadyLinked: true });
  }

  const [created] = await db.insert(projectStamps).values({ projectId, stampId }).returning();
  return NextResponse.json(created, { status: 201 });
}
