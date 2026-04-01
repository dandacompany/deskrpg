import { count } from "drizzle-orm";

import { db, jsonForDb, mapTemplates } from "@/db";
import smallOffice from "@/lib/builtin/small-office-template.json";

export const BUILTIN_TEMPLATE_NAME = "Small Office";

export interface BuiltinTemplateSnapshot {
  name: string;
  icon: string;
  description: string;
  cols: number;
  rows: number;
  spawnCol: number;
  spawnRow: number;
  thumbnail: string | null;
  tiledJson: Record<string, unknown>;
}

export async function seedBuiltinTemplates() {
  const [{ value: existingCount }] = await db
    .select({ value: count() })
    .from(mapTemplates);

  if (Number(existingCount) > 0) return null;

  const snapshot = smallOffice as BuiltinTemplateSnapshot;

  const [template] = await db
    .insert(mapTemplates)
    .values({
      name: snapshot.name,
      icon: snapshot.icon,
      description: snapshot.description,
      cols: snapshot.cols,
      rows: snapshot.rows,
      spawnCol: snapshot.spawnCol,
      spawnRow: snapshot.spawnRow,
      thumbnail: snapshot.thumbnail,
      tiledJson: jsonForDb(snapshot.tiledJson),
    })
    .returning();

  return template ?? null;
}
