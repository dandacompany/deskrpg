import { tiledDirection, tiledVariant } from "../../lib/tiled-geometry";
import {
  OBJECT_TYPES,
  computeOccupiedTiles,
  detectAndConvertMapData,
  type MapObject,
} from "../../lib/object-types";
import { readAmbientZones, type AmbientZone } from "../ambient-zones";
import {
  resolveOfficeEnvironment,
  resolveOfficeEnvironmentVersion,
} from "../three/office-environment-theme";
import { MAP_COLS, MAP_ROWS, TILE_SIZE } from "./constants";

/** The top 3 bits of a Tiled GID are flip flags. Keep only the logical tile number. */
const GID_MASK = 0x1fffffff;

/** The map geometry the simulation reads. No artwork or tileset images — only walkability checks and renderer input. */
export type MapRuntime = {
  cols: number;
  rows: number;
  floor: number[][];
  walls: number[][];
  /** The collision tile layer of a Tiled map (by row). If empty, the legacy wall check is used. */
  collision: number[][];
  objects: MapObject[];
  /** Object-occupied tiles and collision layer (tiles, rectangles) cells. `"col,row"`. */
  collisionCells: Set<string>;
  tiled: boolean;
  environment?: string;
  environmentVersion?: number;
  ambientZones: AmbientZone[];
  /** The spawn object of the Objects layer. The fallback when there is no mapConfig. */
  tiledSpawn: { col: number | null; row: number | null };
};

type TiledLayer = {
  id?: number;
  name?: string;
  type?: string;
  data?: number[];
  width?: number;
  objects?: Array<Record<string, unknown>>;
};

/** Read walking, seat and environment info from Tiled JSON. The same rules the old parser used. */
export function loadTiledRuntime(tiledJson: Record<string, unknown>): MapRuntime {
  const cols = (tiledJson.width as number) || MAP_COLS;
  const rows = (tiledJson.height as number) || MAP_ROWS;
  const layers = (tiledJson.layers as TiledLayer[] | undefined) ?? [];
  const tileLayers = layers.filter((layer) => layer.type === "tilelayer");
  const tileLayerNames = tileLayers.map((layer) => layer.name ?? "");
  // Look up by name first, and if missing pick by order.
  const floorLayerName =
    tileLayerNames.find((name) => name.toLowerCase() === "floor") || tileLayerNames[0];
  const wallsLayerName =
    tileLayerNames.find((name) => name.toLowerCase() === "walls") || tileLayerNames[1];
  const grid = (layer: TiledLayer | undefined) => {
    const width = layer?.width || cols;
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => (layer?.data?.[row * width + col] ?? 0) & GID_MASK),
    );
  };
  const floorLayer = tileLayers.find((layer) => layer.name === floorLayerName);
  const wallsLayer =
    wallsLayerName && wallsLayerName !== floorLayerName
      ? tileLayers.find((layer) => layer.name === wallsLayerName)
      : undefined;

  const collisionTileLayer = tileLayers.find(
    (layer) => (layer.name ?? "").toLowerCase() === "collision",
  );
  const collision: number[][] = [];
  if (collisionTileLayer?.data) {
    const width = collisionTileLayer.width || cols;
    for (let r = 0; r < rows; r++)
      collision.push(collisionTileLayer.data.slice(r * width, (r + 1) * width));
  }

  const objects: MapObject[] = [];
  const collisionCells = new Set<string>();
  const tiledSpawn: MapRuntime["tiledSpawn"] = { col: null, row: null };
  for (const layer of layers) {
    const layerName = (layer.name ?? "").toLowerCase();
    if (layer.type === "objectgroup" && layerName === "collision") {
      for (const obj of layer.objects ?? []) {
        const ox = (obj.x as number) || 0;
        const oy = (obj.y as number) || 0;
        const ow = (obj.width as number) || TILE_SIZE;
        const oh = (obj.height as number) || TILE_SIZE;
        const startCol = Math.floor(ox / TILE_SIZE);
        const startRow = Math.floor(oy / TILE_SIZE);
        const endCol = Math.ceil((ox + ow) / TILE_SIZE);
        const endRow = Math.ceil((oy + oh) / TILE_SIZE);
        for (let r = startRow; r < endRow; r++)
          for (let c = startCol; c < endCol; c++) collisionCells.add(`${c},${r}`);
      }
      continue;
    }
    if (layer.type === "tilelayer" && layerName === "collision") {
      const data = layer.data;
      if (data)
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++)
            if (data[r * cols + c] || 0) collisionCells.add(`${c},${r}`);
      continue;
    }
    if (layer.type !== "objectgroup") continue;
    for (const obj of layer.objects ?? []) {
      if (obj.name === "spawn" || obj.type === "spawn") {
        tiledSpawn.col = Math.floor((obj.x as number) / TILE_SIZE);
        tiledSpawn.row = Math.floor((obj.y as number) / TILE_SIZE);
        continue;
      }
      const objectType = (obj.type as string) || "";
      if (!objectType || !OBJECT_TYPES[objectType]) continue;
      const properties = obj.properties as Array<{ name: string; value: unknown }> | undefined;
      objects.push({
        id: `${layer.id}:${obj.id}`,
        type: objectType,
        col: Math.floor((obj.x as number) / TILE_SIZE),
        row: Math.floor((obj.y as number) / TILE_SIZE),
        ...tiledDirection(properties),
        ...tiledVariant(properties),
      });
    }
  }

  return {
    cols,
    rows,
    floor: grid(floorLayer),
    walls: grid(wallsLayer),
    collision,
    objects,
    collisionCells,
    tiled: true,
    environment: resolveOfficeEnvironment(tiledJson),
    environmentVersion: resolveOfficeEnvironmentVersion(tiledJson),
    ambientZones: readAmbientZones(tiledJson),
    tiledSpawn,
  };
}

/** A legacy `{ layers, objects }` map (or an even older format). Wall tiles of the wall layer are collision. */
export function loadLegacyRuntime(mapData: unknown): MapRuntime {
  const converted = detectAndConvertMapData(mapData, MAP_COLS, MAP_ROWS);
  const floor = converted.layers.floor;
  return {
    cols: floor[0]?.length ?? MAP_COLS,
    rows: floor.length,
    floor,
    walls: converted.layers.walls,
    collision: [],
    objects: converted.objects,
    collisionCells: new Set(),
    tiled: false,
    ambientZones: [],
    tiledSpawn: { col: null, row: null },
  };
}

/** Rebuild the occupied set used for walkability after objects change. Collision layer cells are kept. */
export function occupiedTiles(runtime: Pick<MapRuntime, "objects" | "collisionCells">) {
  const occupied = computeOccupiedTiles(runtime.objects);
  for (const cell of runtime.collisionCells) occupied.add(cell);
  return occupied;
}
