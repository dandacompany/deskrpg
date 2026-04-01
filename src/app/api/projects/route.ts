import { db, projects, tilesetImages, projectTilesets, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { parseDbJson } from "@/lib/db-json";

// GET /api/projects — list projects owned by current user
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });
  try {
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
      settings: parseDbJson(r.settings) ?? r.settings,
    }));

    return NextResponse.json(parsed);
  } catch (err) {
    console.error("Failed to fetch projects:", err);
    return NextResponse.json({ errorCode: "failed_to_fetch_projects", error: "Failed to fetch projects" }, { status: 500 });
  }
}

// POST /api/projects — create a new project
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const { name, tiledJson, settings, thumbnail } = body;
    if (!name) return NextResponse.json({ errorCode: "project_name_required", error: "name is required" }, { status: 400 });

    const [created] = await db.insert(projects).values({
      name,
      tiledJson: jsonForDb(tiledJson),
      thumbnail: thumbnail || null,
      settings: jsonForDb(settings ?? {}),
      createdBy: userId,
    }).returning();

    // Link tileset images to project (from embedded base64 or existing DB records)
    if (tiledJson?.tilesets) {
      for (const ts of tiledJson.tilesets) {
        try {
          // Check if tileset image already exists by name
          const existing = await db.select({ id: tilesetImages.id })
            .from(tilesetImages).where(eq(tilesetImages.name, ts.name)).limit(1);

          let tilesetId: string | null = null;
          if (existing.length > 0) {
            tilesetId = existing[0].id;
          } else if (ts.image?.startsWith('data:')) {
            // Save embedded base64 image to DB
            const [inserted] = await db.insert(tilesetImages).values({
              name: ts.name,
              tilewidth: ts.tilewidth,
              tileheight: ts.tileheight,
              columns: ts.columns,
              tilecount: ts.tilecount,
              image: ts.image,
            }).returning();
            tilesetId = inserted.id;
          }

          if (tilesetId) {
            // Link tileset to project
            await db.insert(projectTilesets).values({
              projectId: created.id,
              tilesetId,
              firstgid: ts.firstgid,
            }).onConflictDoNothing();
          }
        } catch (e) {
          console.warn(`Failed to link tileset ${ts.name}:`, e);
        }
      }
    }

    return NextResponse.json({
      ...created,
      tiledJson: parseDbJson(created.tiledJson) ?? created.tiledJson,
      settings: parseDbJson(created.settings) ?? created.settings,
    }, { status: 201 });
  } catch (err) {
    console.error("Failed to create project:", err);
    return NextResponse.json({ errorCode: "failed_to_create_project", error: "Failed to create project" }, { status: 500 });
  }
}
