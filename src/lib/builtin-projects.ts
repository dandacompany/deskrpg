import { count, eq } from "drizzle-orm";

import { db, jsonForDb, projects, tilesetImages, projectTilesets } from "@/db";
import sampleProject from "@/lib/builtin/sample-project.json";

export const SAMPLE_PROJECT_NAME = "Dante Labs PJT";

export interface BuiltinProjectSnapshot {
  thumbnail: string | null;
  settings: Record<string, unknown>;
  tiledJson: Record<string, unknown>;
}

export function shouldCreateStarterProject(existingProjectCount: number): boolean {
  return existingProjectCount === 0;
}

export function buildStarterProjectValues({
  userId,
  snapshot = sampleProject as BuiltinProjectSnapshot,
}: {
  userId: string;
  snapshot?: BuiltinProjectSnapshot;
}) {
  return {
    name: SAMPLE_PROJECT_NAME,
    thumbnail: snapshot.thumbnail,
    tiledJson: snapshot.tiledJson,
    settings: snapshot.settings,
    createdBy: userId,
  };
}

interface TiledTileset {
  firstgid: number;
  name: string;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  image: string;
}

async function ensureBuiltinTilesets(
  projectId: string,
  tilesets: TiledTileset[],
) {
  for (const ts of tilesets) {
    // Upsert tileset image by name
    const [existing] = await db
      .select({ id: tilesetImages.id })
      .from(tilesetImages)
      .where(eq(tilesetImages.name, ts.name))
      .limit(1);

    let tilesetId: string;
    if (existing) {
      tilesetId = existing.id;
    } else {
      const [inserted] = await db.insert(tilesetImages).values({
        name: ts.name,
        tilewidth: ts.tilewidth,
        tileheight: ts.tileheight,
        columns: ts.columns,
        tilecount: ts.tilecount,
        image: ts.image,
        builtIn: true,
      }).returning();
      tilesetId = inserted.id;
    }

    // Link to project
    await db.insert(projectTilesets).values({
      projectId,
      tilesetId,
      firstgid: ts.firstgid,
    }).onConflictDoNothing();
  }
}

export async function createStarterProjectForUser(userId: string) {
  const [{ value: existingProjectCount }] = await db
    .select({ value: count() })
    .from(projects)
    .where(eq(projects.createdBy, userId));

  if (!shouldCreateStarterProject(Number(existingProjectCount))) return null;

  const starterProject = buildStarterProjectValues({ userId });
  const [project] = await db.insert(projects).values({
    ...starterProject,
    tiledJson: jsonForDb(starterProject.tiledJson),
    settings: jsonForDb(starterProject.settings),
  }).returning();

  if (project) {
    const snapshot = sampleProject as BuiltinProjectSnapshot;
    const tilesets = (snapshot.tiledJson as { tilesets?: TiledTileset[] }).tilesets ?? [];
    await ensureBuiltinTilesets(project.id, tilesets);
  }

  return project ?? null;
}
