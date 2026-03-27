/**
 * convert-templates-to-tiled.ts
 * Convert DeskRPG map templates to Tiled JSON (.tmj) format.
 *
 * Usage:  npx tsx scripts/convert-templates-to-tiled.ts
 */

import * as fs from "fs";
import * as path from "path";
import { MAP_TEMPLATES, type MapTemplate } from "./map-template-data";

const OUT_DIR = path.resolve(__dirname, "../public/assets/tiled-kit");
const FIRST_GID = 1;

// Convert a tileId to Tiled GID.  GID 0 = empty, otherwise tileId + firstgid.
function toGid(tileId: number): number {
  return tileId === 0 ? 0 : tileId + FIRST_GID;
}

// Flatten a 2D array (row-major) to 1D with GID conversion.
function flatten(grid: number[][]): number[] {
  const out: number[] = [];
  for (const row of grid) {
    for (const cell of row) {
      out.push(toGid(cell));
    }
  }
  return out;
}

function convertTemplate(template: MapTemplate): object {
  const { cols, rows, layers, objects, spawnCol, spawnRow } = template;

  // Build object list for the object layer
  let nextObjId = 1;
  const tiledObjects: object[] = [];

  // Spawn point
  tiledObjects.push({
    id: nextObjId++,
    name: "spawn",
    type: "spawn",
    x: spawnCol * 32,
    y: spawnRow * 32,
    width: 0,
    height: 0,
    point: true,
    visible: true,
  });

  // Map objects
  for (const obj of objects) {
    tiledObjects.push({
      id: nextObjId++,
      name: obj.type,
      type: obj.type,
      x: obj.col * 32,
      y: obj.row * 32,
      width: 32,
      height: 32,
      visible: true,
      properties: [
        { name: "objectType", type: "string", value: obj.type },
      ],
    });
  }

  return {
    compressionlevel: -1,
    height: rows,
    width: cols,
    tilewidth: 32,
    tileheight: 32,
    infinite: false,
    orientation: "orthogonal",
    renderorder: "right-down",
    type: "map",
    version: "1.10",
    tiledversion: "1.11.0",
    nextlayerid: 4,
    nextobjectid: nextObjId,
    tilesets: [
      {
        firstgid: FIRST_GID,
        source: "deskrpg-tileset.tsx",
      },
    ],
    layers: [
      {
        id: 1,
        name: "floor",
        type: "tilelayer",
        width: cols,
        height: rows,
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        data: flatten(layers.floor),
      },
      {
        id: 2,
        name: "walls",
        type: "tilelayer",
        width: cols,
        height: rows,
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        data: flatten(layers.walls),
      },
      {
        id: 3,
        name: "objects",
        type: "objectgroup",
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        draworder: "topdown",
        objects: tiledObjects,
      },
    ],
  };
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mapping: Record<string, string> = {
    office: "sample-office.tmj",
    cafe: "sample-cafe.tmj",
    classroom: "sample-classroom.tmj",
  };

  for (const [id, filename] of Object.entries(mapping)) {
    const template = MAP_TEMPLATES[id as keyof typeof MAP_TEMPLATES];
    if (!template) {
      console.error(`Template "${id}" not found, skipping.`);
      continue;
    }

    const tiledMap = convertTemplate(template);
    const outPath = path.join(OUT_DIR, filename);
    fs.writeFileSync(outPath, JSON.stringify(tiledMap, null, 2) + "\n");
    console.log(`  map -> ${outPath}`);
  }

  console.log("\nDone! Generated Tiled JSON maps.");
}

main();
