import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { tmxToJson } from "@/lib/tmx-parser";
import JSZip from "jszip";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  UploadLimitError,
  consumeArchiveEntry,
  throwIfUploadLimitExceeded,
  validateAuxiliaryUploadSize,
  validateMainUploadSize,
} from "@/lib/upload-limits";
import { getDeskRpgTemplateUploadDir } from "@/lib/runtime-paths";

/**
 * Upload map template — supports:
 * 1. Single .tmj/.tmx file
 * 2. ZIP containing a Tiled project (maps + tileset images)
 */
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get("tmjFile") as File | null;
    const name = (formData.get("name") as string) || "Untitled Map";
    const icon = (formData.get("icon") as string) || "🗺️";
    const description = (formData.get("description") as string) || null;
    const tags = (formData.get("tags") as string) || null;

    if (!file) {
      return NextResponse.json({ errorCode: "file_required", error: "File is required" }, { status: 400 });
    }
    throwIfUploadLimitExceeded(validateMainUploadSize(file.size));

    const fileName = file.name.toLowerCase();
    let tiledJson: Record<string, unknown>;
    let imageFiles: Map<string, Buffer> = new Map(); // relative path → buffer

    if (fileName.endsWith(".zip")) {
      // ── ZIP Project Import ──
      const result = await processZip(await file.arrayBuffer());
      tiledJson = result.tiledJson;
      imageFiles = result.imageFiles;
    } else {
      // ── Single File Import ──
      tiledJson = await parseTiledFile(await file.text(), fileName);
    }

    // Extract metadata
    const cols = (tiledJson.width as number) || 15;
    const rows = (tiledJson.height as number) || 11;
    const tilewidth = (tiledJson.tilewidth as number) || 32;

    // Find spawn point
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
              spawnCol = Math.floor((spawnObj.x as number) / tilewidth);
              spawnRow = Math.floor((spawnObj.y as number) / tilewidth);
            }
          }
        }
      }
    }

    // Also collect any separately uploaded tileset files
    for (const [key, value] of formData.entries()) {
      if (key === "tilesetFiles" && value instanceof File) {
        throwIfUploadLimitExceeded(validateAuxiliaryUploadSize(value.size));
        const buf = Buffer.from(await value.arrayBuffer());
        imageFiles.set(value.name, buf);
      }
    }

    // Insert template to get ID
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

    // Save tileset images
    if (imageFiles.size > 0) {
      const uploadDir = getDeskRpgTemplateUploadDir(template.id);

      for (const [relPath, buffer] of imageFiles) {
        // Flatten to just filename (strip directory prefixes)
        const flatName = path.basename(relPath);
        const destDir = path.join(uploadDir);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, flatName), buffer);
      }

      // Rewrite tileset image paths in tiledJson to point to uploads folder
      const tilesets = tiledJson.tilesets as Array<Record<string, unknown>>;
      if (tilesets) {
        let changed = false;
        for (const ts of tilesets) {
          if (ts.image && typeof ts.image === "string") {
            const imgName = path.basename(ts.image as string);
            if (imageFiles.has(imgName) || imageFiles.has(ts.image as string)) {
              ts.image = `/assets/uploads/${template.id}/${imgName}`;
              changed = true;
            }
          }
        }
        if (changed) {
          // Update DB with rewritten paths
          const { eq } = await import("drizzle-orm");
          await db
            .update(mapTemplates)
            .set({ tiledJson: jsonForDb(tiledJson) })
            .where(eq(mapTemplates.id, template.id));
        }
      }
    }

    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadLimitError) {
      return NextResponse.json({ errorCode: err.errorCode, error: err.message }, { status: err.status });
    }
    console.error("Failed to upload map template:", err);
    return NextResponse.json({
      errorCode: "failed_to_upload_template",
      error: `Upload failed: ${err instanceof Error ? err.message : "unknown"}`,
    }, { status: 500 });
  }
}

// ── Helper: Parse single TMJ/TMX file ──
async function parseTiledFile(text: string, fileName: string): Promise<Record<string, unknown>> {
  if (fileName.endsWith(".tmx") || fileName.endsWith(".xml") || text.trimStart().startsWith("<?xml") || text.trimStart().startsWith("<map")) {
    return tmxToJson(text);
  }
  return JSON.parse(text);
}

// ── Helper: Process ZIP archive ──
async function processZip(buffer: ArrayBuffer): Promise<{
  tiledJson: Record<string, unknown>;
  imageFiles: Map<string, Buffer>;
}> {
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.entries(zip.files);
  let archiveBudget = { entries: 0, totalBytes: 0 };

  // Find map files (.tmj, .tmx, .json with tiled content)
  let mapFile: { name: string; content: string } | null = null;
  const imageFiles = new Map<string, Buffer>();

  // First pass: categorize files
  for (const [filePath, zipEntry] of files) {
    if (zipEntry.dir) continue;
    const lower = filePath.toLowerCase();
    const baseName = path.basename(lower);

    // Skip OS junk files
    if (baseName.startsWith(".") || lower.includes("__macosx")) continue;

    if (lower.endsWith(".tmj") || lower.endsWith(".tmx")) {
      if (!mapFile) {
        const content = await zipEntry.async("text");
        const budgetResult = consumeArchiveEntry(archiveBudget, Buffer.byteLength(content));
        if (!budgetResult.ok) {
          throwIfUploadLimitExceeded(budgetResult.errorCode);
        } else {
          archiveBudget = budgetResult.budget;
        }
        mapFile = { name: filePath, content };
      }
    } else if (lower.endsWith(".json") && !mapFile) {
      // Could be a Tiled JSON map — check content
      const text = await zipEntry.async("text");
      const budgetResult = consumeArchiveEntry(archiveBudget, Buffer.byteLength(text));
      if (!budgetResult.ok) {
        throwIfUploadLimitExceeded(budgetResult.errorCode);
      } else {
        archiveBudget = budgetResult.budget;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed.tiledversion || parsed.layers) {
          mapFile = { name: filePath, content: text };
        }
      } catch { /* not JSON, skip */ }
    } else if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
      const buf = await zipEntry.async("nodebuffer");
      throwIfUploadLimitExceeded(validateAuxiliaryUploadSize(buf.length));
      const budgetResult = consumeArchiveEntry(archiveBudget, buf.length);
      if (!budgetResult.ok) {
        throwIfUploadLimitExceeded(budgetResult.errorCode);
      } else {
        archiveBudget = budgetResult.budget;
      }
      // Store with both full relative path and basename for matching
      imageFiles.set(filePath, buf);
      imageFiles.set(path.basename(filePath), buf);
    }
  }

  if (!mapFile) {
    throw new Error("No .tmj or .tmx map file found in ZIP");
  }

  // Parse the map file
  const tiledJson = await parseTiledFile(mapFile.content, mapFile.name);

  // Resolve tileset image paths relative to the map file location
  const mapDir = path.dirname(mapFile.name);
  const tilesets = tiledJson.tilesets as Array<Record<string, unknown>>;
  if (tilesets) {
    for (const ts of tilesets) {
      if (ts.image && typeof ts.image === "string") {
        // Try to resolve relative path from map file location
        const resolvedPath = path.join(mapDir, ts.image as string).replace(/\\/g, "/");
        // Normalize (remove leading ./ or ../)
        const normalizedPath = resolvedPath.replace(/^\.\//, "");

        // Check if image exists in zip by resolved path
        if (!imageFiles.has(path.basename(ts.image as string))) {
          // Try with resolved path
          for (const [zipPath, buf] of imageFiles) {
            if (zipPath.endsWith(path.basename(ts.image as string)) || zipPath === normalizedPath) {
              imageFiles.set(path.basename(ts.image as string), buf);
              break;
            }
          }
        }
      }
    }
  }

  return { tiledJson, imageFiles };
}
