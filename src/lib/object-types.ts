// ---------------------------------------------------------------------------
// Object Type System — interfaces, registry, and legacy conversion
// ---------------------------------------------------------------------------

export interface MapObject {
  id: string;
  type: string;
  col: number;
  row: number;
  variant?: string;
  destinationTags?: readonly string[];
  direction?: "down" | "left" | "right" | "up";
}

export interface MapData {
  layers: {
    floor: number[][];
    walls: number[][];
  };
  objects: MapObject[];
}

export interface ObjectTypeDef {
  id: string;
  name: string;
  width: number;
  height: number;
  collision: boolean;
  renderType: "graphic" | "png";
  depthMode: "y-sort" | "fixed";
  fixedDepth?: number;
  directional: boolean;
}

// V1 object type registry
export const OBJECT_TYPES: Record<string, ObjectTypeDef> = {
  studio_worktable: {
    id: "studio_worktable",
    name: "Studio Worktable",
    width: 6,
    height: 3,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  studio_round_table: {
    id: "studio_round_table",
    name: "Studio Round Table",
    width: 3,
    height: 3,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  studio_sofa: {
    id: "studio_sofa",
    name: "Studio Sofa",
    width: 3,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  studio_stool: {
    id: "studio_stool",
    name: "Studio Stool",
    width: 1,
    height: 1,
    collision: false,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  studio_shelf: {
    id: "studio_shelf",
    name: "Studio Shelf",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  studio_counter: {
    id: "studio_counter",
    name: "Studio Counter",
    width: 4,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  photo_cyclorama: {
    id: "photo_cyclorama",
    name: "Photo Cyclorama",
    width: 7,
    height: 3,
    collision: true,
    renderType: "graphic",
    depthMode: "fixed",
    fixedDepth: 5,
    directional: false,
  },
  photo_camera: {
    id: "photo_camera",
    name: "Photo Camera",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  photo_light: {
    id: "photo_light",
    name: "Photo Light",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  mobile_board: {
    id: "mobile_board",
    name: "Mobile Board",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  glass_partition: {
    id: "glass_partition",
    name: "Glass Partition",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "fixed",
    fixedDepth: 5,
    directional: true,
  },
  conference_table: {
    id: "conference_table",
    name: "Conference Table",
    width: 4,
    height: 2,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  office_armchair: {
    id: "office_armchair",
    name: "Office Armchair",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  office_sofa: {
    id: "office_sofa",
    name: "Office Sofa",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  low_cabinet: {
    id: "low_cabinet",
    name: "Low Cabinet",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  kitchen_counter: {
    id: "kitchen_counter",
    name: "Kitchen Counter",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  refrigerator: {
    id: "refrigerator",
    name: "Refrigerator",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  microwave_cabinet: {
    id: "microwave_cabinet",
    name: "Microwave Cabinet",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  cup_shelf: {
    id: "cup_shelf",
    name: "Cup Shelf",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  recycling_bins: {
    id: "recycling_bins",
    name: "Recycling Bins",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  office_printer: {
    id: "office_printer",
    name: "Office Printer",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  coat_rack: {
    id: "coat_rack",
    name: "Coat Rack",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  meeting_display: {
    id: "meeting_display",
    name: "Meeting Display",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  floor_lamp: {
    id: "floor_lamp",
    name: "Floor Lamp",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  office_locker: {
    id: "office_locker",
    name: "Office Locker",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  room_wall_h: {
    id: "room_wall_h",
    name: "Room Wall Horizontal",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  room_wall_v: {
    id: "room_wall_v",
    name: "Room Wall Vertical",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: false,
  },
  desk: {
    id: "desk",
    name: "Desk",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  chair: {
    id: "chair",
    name: "Chair",
    width: 1,
    height: 1,
    collision: false,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  computer: {
    id: "computer",
    name: "Computer",
    width: 1,
    height: 1,
    collision: false,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  plant: {
    id: "plant",
    name: "Plant",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  bookshelf: {
    id: "bookshelf",
    name: "Bookshelf",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "fixed",
    fixedDepth: 5,
    directional: true,
  },
  meeting_table: {
    id: "meeting_table",
    name: "Meeting Table",
    width: 2,
    height: 2,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  coffee: {
    id: "coffee",
    name: "Coffee Machine",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  water_cooler: {
    id: "water_cooler",
    name: "Water Cooler",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  whiteboard: {
    id: "whiteboard",
    name: "Whiteboard",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "fixed",
    fixedDepth: 5,
    directional: true,
  },
  executive_desk: {
    id: "executive_desk",
    name: "Executive Desk",
    width: 4,
    height: 2,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  reception_desk: {
    id: "reception_desk",
    name: "Reception Desk",
    width: 2,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
  cubicle_wall: {
    id: "cubicle_wall",
    name: "Cubicle Wall",
    width: 1,
    height: 1,
    collision: true,
    renderType: "graphic",
    depthMode: "y-sort",
    directional: true,
  },
};

// List for editor toolbar ordering
export const OBJECT_TYPE_LIST: ObjectTypeDef[] = Object.values(OBJECT_TYPES);

// Get effective width/height considering direction (left/right swap w and h for non-square objects)
export function getObjectDimensions(
  type: string,
  direction?: string,
): { width: number; height: number } {
  const def = OBJECT_TYPES[type];
  if (!def) return { width: 1, height: 1 };
  const w = def.width || 1;
  const h = def.height || 1;
  if ((direction === "left" || direction === "right") && w !== h) {
    return { width: h, height: w };
  }
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// Tile ID → Object Type mapping (compatible with the old tile constant T)
// ---------------------------------------------------------------------------
// Old tile constant T: 3=DESK, 4=CHAIR, 5=COMPUTER, 6=PLANT, 8=MEETING_TABLE,
// 9=COFFEE, 10=WATER_COOLER, 11=BOOKSHELF, 13=WHITEBOARD, 14=RECEPTION_DESK, 15=CUBICLE_WALL
export const TILE_ID_TO_OBJECT: Record<number, string> = {
  3: "desk",
  4: "chair",
  5: "computer",
  6: "plant",
  8: "meeting_table",
  9: "coffee",
  10: "water_cooler",
  11: "bookshelf",
  13: "whiteboard",
  14: "reception_desk",
  15: "cubicle_wall",
};

// Floor tile IDs: 0=EMPTY, 1=FLOOR, 12=CARPET
const FLOOR_TILE_IDS = new Set([0, 1, 12]);
// Wall tile IDs: 2=WALL, 7=DOOR
const WALL_TILE_IDS = new Set([2, 7]);

let objectIdCounter = 0;
export function generateObjectId(): string {
  return `obj-${Date.now().toString(36)}-${(objectIdCounter++).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Occupied tiles computation
// ---------------------------------------------------------------------------
export function computeOccupiedTiles(objects: MapObject[]): Set<string> {
  const occupied = new Set<string>();
  for (const obj of objects) {
    const def = OBJECT_TYPES[obj.type];
    if (!def || !def.collision) continue;
    const { width: w, height: h } = getObjectDimensions(obj.type, obj.direction);
    for (let c = obj.col; c < obj.col + w; c++) {
      for (let r = obj.row; r < obj.row + h; r++) {
        occupied.add(`${c},${r}`);
      }
    }
  }
  return occupied;
}

// ---------------------------------------------------------------------------
// Stacking validation
// ---------------------------------------------------------------------------
export function canPlaceObject(
  type: string,
  col: number,
  row: number,
  existingObjects: MapObject[],
  wallsData: number[][],
  direction?: "down" | "left" | "right" | "up",
): boolean {
  const def = OBJECT_TYPES[type];
  if (!def) return false;
  const { width: w, height: h } = getObjectDimensions(type, direction);

  for (let c = col; c < col + w; c++) {
    for (let r = row; r < row + h; r++) {
      // Check walls
      if (wallsData[r]?.[c] === 2) return false; // T.WALL
      // Check collision stacking rule
      if (def.collision) {
        // Cannot place collision object on cell with existing collision object
        for (const obj of existingObjects) {
          const oDef = OBJECT_TYPES[obj.type];
          if (!oDef || !oDef.collision) continue;
          const { width: ow, height: oh } = getObjectDimensions(obj.type, obj.direction);
          if (c >= obj.col && c < obj.col + ow && r >= obj.row && r < obj.row + oh) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Legacy format detection and conversion
// ---------------------------------------------------------------------------
function convertFurnitureLayer(furniture: number[][]): MapObject[] {
  const objects: MapObject[] = [];
  for (let r = 0; r < furniture.length; r++) {
    for (let c = 0; c < (furniture[r]?.length || 0); c++) {
      const tileId = furniture[r][c];
      const objectType = TILE_ID_TO_OBJECT[tileId];
      if (objectType) {
        objects.push({ id: generateObjectId(), type: objectType, col: c, row: r });
      }
    }
  }
  return objects;
}

export function detectAndConvertMapData(
  mapData: unknown,
  fallbackCols: number,
  fallbackRows: number,
): MapData {
  // Null/undefined → empty map
  if (!mapData) {
    const floor = Array.from({ length: fallbackRows }, () => new Array(fallbackCols).fill(1));
    const walls = Array.from({ length: fallbackRows }, () => new Array(fallbackCols).fill(0));
    return { layers: { floor, walls }, objects: [] };
  }

  const data = mapData as Record<string, unknown>;

  // New format: { layers, objects }
  if (data.layers && data.objects) {
    return data as unknown as MapData;
  }

  // 3-layer legacy: { floor, walls, furniture }
  if (data.floor && data.walls && data.furniture) {
    return {
      layers: {
        floor: data.floor as number[][],
        walls: data.walls as number[][],
      },
      objects: convertFurnitureLayer(data.furniture as number[][]),
    };
  }

  // Single array legacy: number[][] (from map-templates.ts old format)
  if (Array.isArray(mapData) && Array.isArray((mapData as unknown[])[0])) {
    const tiles = mapData as number[][];
    const rows = tiles.length;
    const cols = tiles[0]?.length || 0;
    const floor: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
    const walls: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
    const objects: MapObject[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = tiles[r][c];
        if (FLOOR_TILE_IDS.has(id)) {
          floor[r][c] = id;
        } else if (WALL_TILE_IDS.has(id)) {
          walls[r][c] = id;
        } else if (TILE_ID_TO_OBJECT[id]) {
          floor[r][c] = 1; // Put floor under furniture
          objects.push({ id: generateObjectId(), type: TILE_ID_TO_OBJECT[id], col: c, row: r });
        }
      }
    }

    return { layers: { floor, walls }, objects };
  }

  // Unknown format — return empty
  const floor = Array.from({ length: fallbackRows }, () => new Array(fallbackCols).fill(1));
  const walls = Array.from({ length: fallbackRows }, () => new Array(fallbackCols).fill(0));
  return { layers: { floor, walls }, objects: [] };
}
