// src/lib/map-thumbnail.ts — Generate a small canvas thumbnail from map data

/** Tile colors for DeskRPG default tileset (index-based) */
const TILE_COLORS: Record<number, string> = {
  0: "#1a1a2e", // empty
  1: "#8b8378", // floor
  2: "#4a4a5e", // wall
  7: "#8b7a5a", // door
  12: "#6b6560", // carpet
};

/** Object colors for thumbnail */
const OBJECT_COLORS: Record<string, string> = {
  desk: "#6b4226",
  chair: "#4060b0",
  computer: "#222233",
  plant: "#2d8b2d",
  meeting_table: "#4a3020",
  coffee: "#5a4a3a",
  water_cooler: "#88bbff",
  bookshelf: "#5a3a1a",
  whiteboard: "#f0f0f0",
  reception_desk: "#8b6b3a",
  cubicle_wall: "#888899",
};

/**
 * Generate a thumbnail data URL from legacy map layers and objects.
 */
export function generateMapThumbnail(
  layers: { floor: number[][]; walls: number[][] },
  objects: { type: string; col: number; row: number }[],
  cols: number,
  rows: number,
  scale = 4,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = cols * scale;
  canvas.height = rows * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Draw floor
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileId = layers.floor[r]?.[c] ?? 0;
      ctx.fillStyle = TILE_COLORS[tileId] || TILE_COLORS[0];
      ctx.fillRect(c * scale, r * scale, scale, scale);
    }
  }

  // Draw walls on top
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tileId = layers.walls[r]?.[c] ?? 0;
      if (tileId === 0) continue;
      ctx.fillStyle = TILE_COLORS[tileId] || "#4a4a5e";
      ctx.fillRect(c * scale, r * scale, scale, scale);
    }
  }

  // Draw objects
  for (const obj of objects || []) {
    const color = OBJECT_COLORS[obj.type];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(obj.col * scale + 1, obj.row * scale + 1, scale - 2, scale - 2);
  }

  return canvas.toDataURL("image/png");
}

/**
 * Generate a thumbnail from Tiled JSON data.
 * Handles any tileset (not just DeskRPG default) by using generic colors.
 */
export function generateTiledThumbnail(
  tiledJson: Record<string, unknown>,
  scale = 4,
): string {
  const width = (tiledJson.width as number) || 15;
  const height = (tiledJson.height as number) || 11;
  const layers = (tiledJson.layers as Array<Record<string, unknown>>) || [];

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Determine firstgid from tilesets
  const tilesets = (tiledJson.tilesets as Array<Record<string, unknown>>) || [];
  const firstgid = (tilesets[0]?.firstgid as number) || 1;

  // Color palette for generic tilesets (by relative tile index ranges)
  const getGenericColor = (gid: number): string | null => {
    if (gid === 0) return null; // empty
    const idx = gid - firstgid;

    // Try DeskRPG colors first
    if (TILE_COLORS[idx]) return TILE_COLORS[idx];

    // Generic: any non-zero tile gets a color based on index
    // Light for "ground" tiles (low indices), dark for "wall" tiles
    if (idx < 0) return null;
    // Heuristic: use a muted palette
    const hue = (idx * 37) % 360;
    return `hsl(${hue}, 20%, ${40 + (idx % 3) * 10}%)`;
  };

  // Draw tile layers (in order — first layer = bottom)
  let layerIndex = 0;
  for (const layer of layers) {
    if (layer.type !== "tilelayer" || !layer.data) continue;
    const data = layer.data as number[];

    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const gid = data[r * width + c] || 0;
        if (gid === 0) continue;

        const color = getGenericColor(gid);
        if (!color) continue;

        // Second+ layers drawn slightly darker for visual distinction
        if (layerIndex > 0) {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.9;
        } else {
          ctx.fillStyle = color;
          ctx.globalAlpha = 1;
        }
        ctx.fillRect(c * scale, r * scale, scale, scale);
      }
    }
    ctx.globalAlpha = 1;
    layerIndex++;
  }

  // Draw objects from object layers
  for (const layer of layers) {
    if (layer.type !== "objectgroup") continue;
    const objects = (layer.objects as Array<Record<string, unknown>>) || [];
    for (const obj of objects) {
      if ((obj.name as string) === "spawn" || (obj.type as string) === "spawn") continue;
      const col = Math.floor((obj.x as number) / 32);
      const row = Math.floor((obj.y as number) / 32);
      const objType = (obj.type as string) || "";
      ctx.fillStyle = OBJECT_COLORS[objType] || "#887766";
      ctx.fillRect(col * scale + 1, row * scale + 1, scale - 2, scale - 2);
    }
  }

  return canvas.toDataURL("image/png");
}
