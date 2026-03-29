// src/lib/map-editor-utils.ts — Map editor helper functions

/** Tile constants matching GameScene T and BootScene tileset */
export const TILES = {
  EMPTY: 0,
  FLOOR: 1,
  WALL: 2,
  DOOR: 7,
  CARPET: 12,
} as const;

/** Validation constraints */
export const MAP_SIZE_MIN_COLS = 10;
export const MAP_SIZE_MAX_COLS = 40;
export const MAP_SIZE_MIN_ROWS = 8;
export const MAP_SIZE_MAX_ROWS = 30;

/**
 * Validate map template data for API create/update.
 * Returns null if valid, error message string if invalid.
 */
export function validateMapTemplate(data: {
  name?: string;
  cols?: number;
  rows?: number;
  layers?: { floor?: number[][]; walls?: number[][] };
  spawnCol?: number;
  spawnRow?: number;
  tiledJson?: unknown;
}): string | null {
  if (!data.name || data.name.length < 1 || data.name.length > 200) {
    return "name is required (1-200 chars)";
  }
  if (typeof data.cols !== "number" || data.cols < MAP_SIZE_MIN_COLS || data.cols > MAP_SIZE_MAX_COLS) {
    return `cols must be ${MAP_SIZE_MIN_COLS}-${MAP_SIZE_MAX_COLS}`;
  }
  if (typeof data.rows !== "number" || data.rows < MAP_SIZE_MIN_ROWS || data.rows > MAP_SIZE_MAX_ROWS) {
    return `rows must be ${MAP_SIZE_MIN_ROWS}-${MAP_SIZE_MAX_ROWS}`;
  }
  if (typeof data.spawnCol !== "number" || data.spawnCol < 0 || data.spawnCol >= data.cols) {
    return "spawnCol out of range";
  }
  if (typeof data.spawnRow !== "number" || data.spawnRow < 0 || data.spawnRow >= data.rows) {
    return "spawnRow out of range";
  }

  // If tiledJson is provided, skip legacy layers validation
  if (data.tiledJson) {
    return null;
  }

  // Legacy layers validation (required when tiledJson is not provided)
  if (!data.layers?.floor || !data.layers?.walls) {
    return "layers.floor and layers.walls are required (or provide tiledJson)";
  }
  if (data.layers.floor.length !== data.rows || data.layers.walls.length !== data.rows) {
    return "layer row count must match rows";
  }
  for (let r = 0; r < data.rows; r++) {
    if (data.layers.floor[r]?.length !== data.cols || data.layers.walls[r]?.length !== data.cols) {
      return `layer column count at row ${r} must match cols`;
    }
  }
  if (data.layers.walls[data.spawnRow]?.[data.spawnCol] === TILES.WALL) {
    return "spawn position cannot be on a wall";
  }
  return null;
}
