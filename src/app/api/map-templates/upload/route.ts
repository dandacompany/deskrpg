import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { tmxToJson } from "@/lib/tmx-parser";
import * as fs from "node:fs";
import * as path from "node:path";

export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const formData = await req.formData();
    const tmjFile = formData.get("tmjFile") as File | null;
    const name = (formData.get("name") as string) || "Untitled Map";
    const icon = (formData.get("icon") as string) || "🗺️";
    const description = (formData.get("description") as string) || null;
    const tags = (formData.get("tags") as string) || null;

    if (!tmjFile) {
      return NextResponse.json({ error: "tmjFile is required" }, { status: 400 });
    }

    // Parse file — support both TMJ (JSON) and TMX (XML)
    const fileText = await tmjFile.text();
    const fileName = tmjFile.name.toLowerCase();
    let tiledJson: Record<string, unknown>;

    if (fileName.endsWith(".tmx") || fileName.endsWith(".xml") || fileText.trimStart().startsWith("<?xml") || fileText.trimStart().startsWith("<map")) {
      // TMX (XML) → convert to JSON
      try {
        tiledJson = tmxToJson(fileText);
      } catch (e) {
        return NextResponse.json({ error: `TMX parse error: ${e instanceof Error ? e.message : "unknown"}` }, { status: 400 });
      }
    } else {
      // TMJ (JSON)
      try {
        tiledJson = JSON.parse(fileText);
      } catch {
        return NextResponse.json({ error: "Invalid JSON in .tmj file" }, { status: 400 });
      }
    }

    // Extract metadata from Tiled JSON
    const cols = (tiledJson.width as number) || 15;
    const rows = (tiledJson.height as number) || 11;

    // Find spawn point in objects layer
    let spawnCol = Math.floor(cols / 2);
    let spawnRow = rows - 2;
    const layers = tiledJson.layers as Array<Record<string, unknown>>;
    if (layers) {
      for (const layer of layers) {
        if (layer.type === "objectgroup") {
          const objects = layer.objects as Array<Record<string, unknown>>;
          if (objects) {
            const spawnObj = objects.find((o) => o.name === "spawn" || o.type === "spawn");
            if (spawnObj) {
              spawnCol = Math.floor((spawnObj.x as number) / 32);
              spawnRow = Math.floor((spawnObj.y as number) / 32);
            }
          }
        }
      }
    }

    // Handle custom tileset file uploads
    const tilesetFiles: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key === "tilesetFiles" && value instanceof File) {
        tilesetFiles.push(value);
      }
    }

    // Insert template first to get ID
    const [template] = await db
      .insert(mapTemplates)
      .values({
        name: name.trim(),
        icon,
        description: description?.trim() || null,
        cols,
        rows,
        spawnCol,
        spawnRow,
        tiledJson: jsonForDb(tiledJson),
        tags: tags?.trim() || null,
        createdBy: userId,
      })
      .returning();

    // Save custom tileset files if any
    if (tilesetFiles.length > 0) {
      const uploadDir = path.join(process.cwd(), "public", "assets", "uploads", template.id);
      fs.mkdirSync(uploadDir, { recursive: true });

      for (const file of tilesetFiles) {
        const buffer = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(path.join(uploadDir, file.name), buffer);
      }
    }

    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    console.error("Failed to upload map template:", err);
    return NextResponse.json({ error: "Failed to upload template" }, { status: 500 });
  }
}
