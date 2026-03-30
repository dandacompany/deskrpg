import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";

// POST /api/projects/[id]/stamps — link a stamp to a project
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { stampId } = await req.json();
  if (!stampId) {
    return NextResponse.json({ error: "stampId required" }, { status: 400 });
  }
  const [created] = await db.insert(projectStamps).values({ projectId, stampId }).returning();
  return NextResponse.json(created, { status: 201 });
}
