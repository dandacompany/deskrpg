import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";

// POST /api/projects/[id]/tilesets — link a tileset to a project
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { tilesetId, firstgid } = await req.json();
  if (!tilesetId || firstgid == null) {
    return NextResponse.json({ error: "tilesetId and firstgid required" }, { status: 400 });
  }
  const [created] = await db.insert(projectTilesets).values({ projectId, tilesetId, firstgid }).returning();
  return NextResponse.json(created, { status: 201 });
}
