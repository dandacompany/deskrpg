import { db, projects, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";

// GET /api/projects — list all projects
export async function GET() {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      thumbnail: projects.thumbnail,
      settings: projects.settings,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt));

  const parsed = rows.map((r) => ({
    ...r,
    settings: typeof r.settings === "string" ? JSON.parse(r.settings) : r.settings,
  }));

  return NextResponse.json(parsed);
}

// POST /api/projects — create a new project
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, tiledJson, settings } = body;
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const [created] = await db.insert(projects).values({
    name,
    tiledJson: jsonForDb(tiledJson),
    settings: jsonForDb(settings ?? {}),
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
