// src/lib/map-editor-utils.ts — Map editor helper functions
import type { MapData, MapObject } from "./object-types";

/** Tile constants matching GameScene T and BootScene tileset */
export const TILES = {
  EMPTY: 0,
  FLOOR: 1,
  WALL: 2,
  DOOR: 7,
  CARPET: 12,
} as const;

/** Floor tile palette items */
export const FLOOR_PALETTE = [
  { id: TILES.EMPTY, name: "Empty", color: "#1a1a2e" },
  { id: TILES.FLOOR, name: "Floor", color: "#8b8378" },
  { id: TILES.CARPET, name: "Carpet", color: "#6b6560" },
] as const;

/** Wall tile palette items */
export const WALL_PALETTE = [
  { id: TILES.EMPTY, name: "Empty", color: "#1a1a2e" },
  { id: TILES.WALL, name: "Wall", color: "#4a4a5e" },
  { id: TILES.DOOR, name: "Door", color: "#8b7a5a" },
] as const;

/** Validation constraints */
export const MAP_SIZE_MIN_COLS = 10;
export const MAP_SIZE_MAX_COLS = 40;
export const MAP_SIZE_MIN_ROWS = 8;
export const MAP_SIZE_MAX_ROWS = 30;

/**
 * Generate a blank map with outer walls, floor, and doors at bottom center.
 */
export function generateBlankMap(cols: number, rows: number): {
  mapData: MapData;
  spawnCol: number;
  spawnRow: number;
} {
  const floor: number[][] = [];
  const walls: number[][] = [];

  for (let r = 0; r < rows; r++) {
    const floorRow = new Array(cols).fill(TILES.EMPTY);
    const wallsRow = new Array(cols).fill(TILES.EMPTY);

    for (let c = 0; c < cols; c++) {
      const isTop = r === 0;
      const isBottom = r === rows - 1;
      const isLeft = c === 0;
      const isRight = c === cols - 1;
      const isEdge = isTop || isBottom || isLeft || isRight;

      // Bottom center: 3 doors
      const doorStart = Math.floor(cols / 2) - 1;
      const isDoor = isBottom && c >= doorStart && c < doorStart + 3;

      if (isDoor) {
        wallsRow[c] = TILES.DOOR;
        floorRow[c] = TILES.FLOOR;
      } else if (isEdge) {
        wallsRow[c] = TILES.WALL;
      } else {
        floorRow[c] = TILES.FLOOR;
      }
    }

    floor.push(floorRow);
    walls.push(wallsRow);
  }

  const spawnCol = Math.floor(cols / 2);
  const spawnRow = rows - 2;

  return {
    mapData: { layers: { floor, walls }, objects: [] },
    spawnCol,
    spawnRow,
  };
}

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
  if (!data.layers?.floor || !data.layers?.walls) {
    return "layers.floor and layers.walls are required";
  }
  if (data.layers.floor.length !== data.rows || data.layers.walls.length !== data.rows) {
    return "layer row count must match rows";
  }
  for (let r = 0; r < data.rows; r++) {
    if (data.layers.floor[r]?.length !== data.cols || data.layers.walls[r]?.length !== data.cols) {
      return `layer column count at row ${r} must match cols`;
    }
  }
  if (typeof data.spawnCol !== "number" || data.spawnCol < 0 || data.spawnCol >= data.cols) {
    return "spawnCol out of range";
  }
  if (typeof data.spawnRow !== "number" || data.spawnRow < 0 || data.spawnRow >= data.rows) {
    return "spawnRow out of range";
  }
  if (data.layers.walls[data.spawnRow]?.[data.spawnCol] === TILES.WALL) {
    return "spawn position cannot be on a wall";
  }
  return null;
}

/** Undo/Redo history for tile edits */
export type EditorAction =
  | { type: "tile"; layer: "floor" | "walls"; col: number; row: number; prev: number; next: number }
  | { type: "objects"; prev: MapObject[]; next: MapObject[] }
  | { type: "spawn"; prev: { col: number; row: number }; next: { col: number; row: number } };

export class EditorHistory {
  private undoStack: EditorAction[] = [];
  private redoStack: EditorAction[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  push(action: EditorAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(): EditorAction | null {
    const action = this.undoStack.pop();
    if (action) this.redoStack.push(action);
    return action ?? null;
  }

  redo(): EditorAction | null {
    const action = this.redoStack.pop();
    if (action) this.undoStack.push(action);
    return action ?? null;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
