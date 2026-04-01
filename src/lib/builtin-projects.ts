import { count, eq } from "drizzle-orm";

import { db, jsonForDb, projects } from "@/db";
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
  return project ?? null;
}
