import type { MapObject } from "../src/lib/object-types";
import { generateObjectId } from "../src/lib/object-types";

export type MapTemplateId = "office" | "cafe" | "classroom";

export interface MapTemplate {
  id: MapTemplateId;
  name: string;
  icon: string;
  description: string;
  cols: number;
  rows: number;
  layers: {
    floor: number[][];
    walls: number[][];
  };
  objects: MapObject[];
  spawnCol: number;
  spawnRow: number;
}

// Tile constants (GameScene T):
// 0=EMPTY, 1=FLOOR, 2=WALL, 7=DOOR, 12=CARPET

// Old tile index reference (from BootScene):
// 0=floor, 1=wall-top, 2=wall-side, 3=corner-TL, 4=corner-TR,
// 5=desk-top, 6=desk-bottom, 7=chair, 8=plant, 9=bookshelf,
// 10=rug, 11=corner-BL, 12=corner-BR, 13=door, 14=whiteboard, 15=table

// Mapping used for conversion:
// 0(floor)→floor=1, 1/2/3/4/11/12(walls)→walls=2, 13(door)→walls=7+floor=1,
// 10(rug)→floor=12, 5(desk-top)→floor=1+obj:desk, 6(desk-bottom)→floor=1(discard),
// 7(chair)→floor=1+obj:chair, 8(plant)→floor=1+obj:plant, 9(bookshelf)→floor=1+obj:bookshelf,
// 14(whiteboard)→walls=2+obj:whiteboard, 15(table)→floor=1+obj:meeting_table

// ---------------------------------------------------------------------------
// OFFICE (15×11)
// Original tiles:
//  [3,1,1,1,1,1,1,1,1,1,1,1,1,1,4],
//  [2,0,0,0,0,0,14,0,0,0,0,0,0,0,2],
//  [2,0,5,6,0,0,0,0,0,5,6,0,0,0,2],
//  [2,0,7,0,0,0,0,0,0,7,0,0,8,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [2,0,0,0,0,15,15,15,0,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [2,0,5,6,0,0,0,0,0,5,6,0,0,0,2],
//  [2,0,7,0,0,0,0,0,0,7,0,0,8,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [11,1,1,1,1,1,13,13,13,1,1,1,1,1,12],
// ---------------------------------------------------------------------------
const OFFICE: MapTemplate = {
  id: "office", name: "Office", icon: "🏢",
  description: "Desks, meeting area, lobby",
  cols: 15, rows: 11,
  spawnCol: 7, spawnRow: 9,
  layers: {
    floor: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // row 0 (wall row — no floor)
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 1
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 2
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 3
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 4
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 5
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 6
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 7
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 8
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 9
      [    0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // row 10 (bottom wall; doors at 6,7,8 → floor=1)
    ],
    walls: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],  // row 0: corners+top walls
      [    2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2],  // row 1: sides + whiteboard at col6 is wall=2
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 2
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 3
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 4
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 5
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 6
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 7
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 8
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 9
      [    2, 2, 2, 2, 2, 2, 7, 7, 7, 2, 2, 2, 2, 2, 2],  // row 10: bottom wall + doors (7=DOOR)
    ],
  },
  objects: [
    // row 1: whiteboard at col 6 (was tile 14 → walls=2+obj:whiteboard)
    { id: generateObjectId(), type: "whiteboard", col: 6, row: 1 },
    // row 2: desk-top at col 2, desk-top at col 9 (tile 5); desk-bottom (tile 6) discarded
    { id: generateObjectId(), type: "desk", col: 2, row: 2 },
    { id: generateObjectId(), type: "desk", col: 9, row: 2 },
    // row 3: chair at col 2, chair at col 9 (tile 7); plant at col 12 (tile 8)
    { id: generateObjectId(), type: "chair", col: 2, row: 3 },
    { id: generateObjectId(), type: "chair", col: 9, row: 3 },
    { id: generateObjectId(), type: "plant", col: 12, row: 3 },
    // row 5: meeting_table at col 5, 6, 7 (tile 15 — v1 single-cell)
    { id: generateObjectId(), type: "meeting_table", col: 5, row: 5 },
    { id: generateObjectId(), type: "meeting_table", col: 6, row: 5 },
    { id: generateObjectId(), type: "meeting_table", col: 7, row: 5 },
    // row 7: desk at col 2, desk at col 9
    { id: generateObjectId(), type: "desk", col: 2, row: 7 },
    { id: generateObjectId(), type: "desk", col: 9, row: 7 },
    // row 8: chair at col 2, chair at col 9; plant at col 12
    { id: generateObjectId(), type: "chair", col: 2, row: 8 },
    { id: generateObjectId(), type: "chair", col: 9, row: 8 },
    { id: generateObjectId(), type: "plant", col: 12, row: 8 },
  ],
};

// ---------------------------------------------------------------------------
// CAFE (15×11)
// Original tiles:
//  [3,1,1,1,1,1,1,1,1,1,1,1,1,1,4],
//  [2,0,0,0,0,0,0,0,0,9,9,9,9,0,2],
//  [2,0,15,0,0,0,15,0,0,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,8,0,2],
//  [2,0,0,0,0,0,0,0,0,15,0,0,0,0,2],
//  [2,0,15,0,0,8,0,0,0,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,15,0,0,8,0,2],
//  [2,0,10,10,0,0,15,0,0,0,0,0,0,0,2],
//  [2,0,10,10,0,0,0,0,0,0,0,0,0,0,2],
//  [11,1,1,1,1,1,13,13,13,1,1,1,1,1,12],
// ---------------------------------------------------------------------------
const CAFE: MapTemplate = {
  id: "cafe", name: "Cafe", icon: "☕",
  description: "Tables, counter bar, cozy corners",
  cols: 15, rows: 11,
  spawnCol: 7, spawnRow: 9,
  layers: {
    floor: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // row 0 (wall row)
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 1
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 2
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 3
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 4
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 5
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 6
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 7
      [    0, 1,12,12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 8: rug(tile10) at col2,3 → carpet=12
      [    0, 1,12,12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 9: same
      [    0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // row 10 (bottom wall + doors at 6,7,8)
    ],
    walls: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],  // row 0
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 1
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 2
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 3
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 4
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 5
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 6
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 7
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 8
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 9
      [    2, 2, 2, 2, 2, 2, 7, 7, 7, 2, 2, 2, 2, 2, 2],  // row 10
    ],
  },
  objects: [
    // row 1: bookshelves at col 9,10,11,12 (tile 9)
    { id: generateObjectId(), type: "bookshelf", col: 9,  row: 1 },
    { id: generateObjectId(), type: "bookshelf", col: 10, row: 1 },
    { id: generateObjectId(), type: "bookshelf", col: 11, row: 1 },
    { id: generateObjectId(), type: "bookshelf", col: 12, row: 1 },
    // row 2: meeting_table at col 2 (tile 15), meeting_table at col 6 (tile 15)
    { id: generateObjectId(), type: "meeting_table", col: 2, row: 2 },
    { id: generateObjectId(), type: "meeting_table", col: 6, row: 2 },
    // row 3: plant at col 12 (tile 8)
    { id: generateObjectId(), type: "plant", col: 12, row: 3 },
    // row 4: meeting_table at col 9 (tile 15)
    { id: generateObjectId(), type: "meeting_table", col: 9, row: 4 },
    // row 5: meeting_table at col 2 (tile 15), plant at col 5 (tile 8)
    { id: generateObjectId(), type: "meeting_table", col: 2, row: 5 },
    { id: generateObjectId(), type: "plant", col: 5, row: 5 },
    // row 7: meeting_table at col 9 (tile 15), plant at col 12 (tile 8)
    { id: generateObjectId(), type: "meeting_table", col: 9, row: 7 },
    { id: generateObjectId(), type: "plant", col: 12, row: 7 },
    // row 8: meeting_table at col 6 (tile 15) — rug at col2,3 → carpet (floor layer)
    { id: generateObjectId(), type: "meeting_table", col: 6, row: 8 },
  ],
};

// ---------------------------------------------------------------------------
// CLASSROOM (15×11)
// Original tiles:
//  [3,1,1,1,1,1,1,1,1,1,1,1,1,1,4],
//  [2,0,0,0,0,0,14,14,14,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,15,0,0,0,0,0,0,2],
//  [2,0,0,5,6,0,0,0,0,5,6,0,0,0,2],
//  [2,0,0,5,6,0,0,0,0,5,6,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [2,0,0,5,6,0,0,0,0,5,6,0,0,0,2],
//  [2,0,0,5,6,0,0,0,0,5,6,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [2,0,0,0,0,0,0,0,0,0,0,0,0,0,2],
//  [11,1,1,1,1,1,13,13,13,1,1,1,1,1,12],
// ---------------------------------------------------------------------------
const CLASSROOM: MapTemplate = {
  id: "classroom", name: "Classroom", icon: "📚",
  description: "Rows of desks, podium, board",
  cols: 15, rows: 11,
  spawnCol: 7, spawnRow: 9,
  layers: {
    floor: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  // row 0 (wall row)
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 1
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 2
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 3
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 4
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 5
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 6
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 7
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 8
      [    0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],  // row 9
      [    0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],  // row 10 (bottom wall + doors at 6,7,8)
    ],
    walls: [
      //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      [    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],  // row 0
      [    2, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0, 2],  // row 1: whiteboards at col 6,7,8 → walls=2
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 2
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 3
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 4
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 5
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 6
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 7
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 8
      [    2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],  // row 9
      [    2, 2, 2, 2, 2, 2, 7, 7, 7, 2, 2, 2, 2, 2, 2],  // row 10
    ],
  },
  objects: [
    // row 1: whiteboards at col 6,7,8 (tile 14 → walls=2+obj:whiteboard)
    { id: generateObjectId(), type: "whiteboard", col: 6, row: 1 },
    { id: generateObjectId(), type: "whiteboard", col: 7, row: 1 },
    { id: generateObjectId(), type: "whiteboard", col: 8, row: 1 },
    // row 2: meeting_table (podium) at col 7 (tile 15)
    { id: generateObjectId(), type: "meeting_table", col: 7, row: 2 },
    // row 3: desk at col 3, desk at col 9 (tile 5); col4 and col10 = tile 6 (desk-bottom, discard)
    { id: generateObjectId(), type: "desk", col: 3, row: 3 },
    { id: generateObjectId(), type: "desk", col: 9, row: 3 },
    // row 4: desk at col 3, desk at col 9
    { id: generateObjectId(), type: "desk", col: 3, row: 4 },
    { id: generateObjectId(), type: "desk", col: 9, row: 4 },
    // row 6: desk at col 3, desk at col 9
    { id: generateObjectId(), type: "desk", col: 3, row: 6 },
    { id: generateObjectId(), type: "desk", col: 9, row: 6 },
    // row 7: desk at col 3, desk at col 9
    { id: generateObjectId(), type: "desk", col: 3, row: 7 },
    { id: generateObjectId(), type: "desk", col: 9, row: 7 },
  ],
};

export const MAP_TEMPLATES: Record<MapTemplateId, MapTemplate> = {
  office: OFFICE,
  cafe: CAFE,
  classroom: CLASSROOM,
};

export function getMapTemplate(id: string): MapTemplate | undefined {
  return MAP_TEMPLATES[id as MapTemplateId];
}
