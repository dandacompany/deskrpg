import { db, projects, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// GET /api/projects — list projects owned by current user
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      thumbnail: projects.thumbnail,
      settings: projects.settings,
      createdBy: projects.createdBy,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.createdBy, userId))
    .orderBy(desc(projects.updatedAt));

  const parsed = rows.map((r) => ({
    ...r,
    settings: typeof r.settings === "string" ? JSON.parse(r.settings) : r.settings,
  }));

  return NextResponse.json(parsed);
}

// POST /api/projects — create a new project
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, tiledJson, settings } = body;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const [created] = await db.insert(projects).values({
    name,
    tiledJson: jsonForDb(tiledJson),
    settings: jsonForDb(settings ?? {}),
    createdBy: userId,
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
