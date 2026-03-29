// scripts/seed-map-templates.ts — Seed built-in map templates into DB
import * as fs from "node:fs";
import * as path from "node:path";
import { getDb, mapTemplates, jsonForDb } from "../src/db";
import { MAP_TEMPLATES } from "./map-template-data";
import { eq } from "drizzle-orm";

async function seed() {
  const db = getDb();

  for (const template of Object.values(MAP_TEMPLATES)) {
    // Check if already seeded (by name match)
    const existing = await db
      .select({ id: mapTemplates.id })
      .from(mapTemplates)
      .where(eq(mapTemplates.name, template.name))
      .limit(1);

    if (existing.length > 0) {
      console.log(`[seed] Skipping "${template.name}" — already exists`);
      continue;
    }

    // Try to load corresponding .tmj file
    const tmjPath = path.join(__dirname, "..", "public", "assets", "tiled-kit", `sample-${template.id}.tmj`);
    let tiledJson = null;
    if (fs.existsSync(tmjPath)) {
      tiledJson = JSON.parse(fs.readFileSync(tmjPath, "utf-8"));
      console.log(`[seed] Loaded Tiled JSON from ${path.basename(tmjPath)}`);
    }

    await db.insert(mapTemplates).values({
      name: template.name,
      icon: template.icon,
      description: template.description,
      cols: template.cols,
      rows: template.rows,
      layers: jsonForDb({ floor: template.layers.floor, walls: template.layers.walls }),
      objects: jsonForDb(template.objects),
      tiledJson: jsonForDb(tiledJson),
      spawnCol: template.spawnCol,
      spawnRow: template.spawnRow,
      createdBy: null,
    });

    console.log(`[seed] Inserted template: "${template.name}"`);
  }

  console.log("[seed] Map templates seeded successfully");
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
