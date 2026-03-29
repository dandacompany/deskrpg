/**
 * export-tileset.ts
 * Generate tileset PNG for Tiled editor and individual object PNGs.
 *
 * Usage:  npx tsx scripts/export-tileset.ts
 */

import { createCanvas, type CanvasRenderingContext2D } from "canvas";
import * as fs from "fs";
import * as path from "path";

const TILE = 32;
const OUT_DIR = path.resolve(__dirname, "../public/assets/tiled-kit");
const OBJ_DIR = path.join(OUT_DIR, "objects");

// ---------------------------------------------------------------------------
// Helper: convert 0xRRGGBB to "#rrggbb"
// ---------------------------------------------------------------------------
function hex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Helper: fillCircle (Phaser-compatible)
// ---------------------------------------------------------------------------
function fillCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Helper: strokeRect with lineWidth + color
// ---------------------------------------------------------------------------
function strokeRectWithStyle(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  lineWidth: number, color: string, alpha: number,
): void {
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Helper: lineBetween with lineWidth + color
// ---------------------------------------------------------------------------
function lineBetween(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  lineWidth: number, color: string, alpha: number,
): void {
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Draw the 16 tiles (mirrors BootScene.drawTile exactly)
// ---------------------------------------------------------------------------
function drawTile(ctx: CanvasRenderingContext2D, index: number): void {
  const x = index * TILE;

  switch (index) {
    case 0: // empty
      break;

    case 1: // floor
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      strokeRectWithStyle(ctx, x, 0, TILE, TILE, 1, hex(0x7a7368), 0.3);
      ctx.save();
      ctx.fillStyle = hex(0x7f7a6e);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x + 6, 6, 2, 2);
      ctx.fillRect(x + 18, 14, 2, 2);
      ctx.fillRect(x + 10, 24, 2, 2);
      ctx.fillRect(x + 26, 8, 2, 2);
      ctx.restore();
      break;

    case 2: // wall
      ctx.fillStyle = hex(0x4a4a5e);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x6a6a7e);
      ctx.fillRect(x, 0, TILE, 4);
      lineBetween(ctx, x, 16, x + TILE, 16, 1, hex(0x3a3a4e), 0.4);
      lineBetween(ctx, x + 16, 4, x + 16, 16, 1, hex(0x3a3a4e), 0.4);
      lineBetween(ctx, x + 8, 16, x + 8, TILE, 1, hex(0x3a3a4e), 0.4);
      lineBetween(ctx, x + 24, 16, x + 24, TILE, 1, hex(0x3a3a4e), 0.4);
      strokeRectWithStyle(ctx, x, 0, TILE, TILE, 1, hex(0x5a5a6e), 0.5);
      break;

    case 3: // desk
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x6b4226);
      ctx.fillRect(x + 2, 4, 28, 20);
      ctx.fillStyle = hex(0x523218);
      ctx.fillRect(x + 2, 22, 28, 4);
      lineBetween(ctx, x + 4, 8, x + 28, 8, 1, hex(0x7a5236), 0.4);
      lineBetween(ctx, x + 6, 14, x + 26, 14, 1, hex(0x7a5236), 0.4);
      break;

    case 4: // chair
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x4060b0);
      ctx.fillRect(x + 8, 10, 16, 14);
      ctx.fillStyle = hex(0x3050a0);
      ctx.fillRect(x + 8, 6, 16, 6);
      ctx.fillStyle = hex(0x333333);
      ctx.fillRect(x + 10, 24, 3, 4);
      ctx.fillRect(x + 19, 24, 3, 4);
      break;

    case 5: // computer screen
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x222233);
      ctx.fillRect(x + 6, 4, 20, 16);
      ctx.fillStyle = hex(0x1a3a2a);
      ctx.fillRect(x + 8, 6, 16, 12);
      ctx.fillStyle = hex(0x44ff44);
      fillCircle(ctx, x + 16, 12, 2);
      ctx.fillStyle = hex(0x444444);
      ctx.fillRect(x + 13, 20, 6, 4);
      ctx.fillRect(x + 10, 24, 12, 2);
      break;

    case 6: // plant
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x8b4513);
      ctx.fillRect(x + 10, 20, 12, 10);
      ctx.fillStyle = hex(0x6b3210);
      ctx.fillRect(x + 8, 18, 16, 4);
      ctx.fillStyle = hex(0x2d8b2d);
      fillCircle(ctx, x + 16, 12, 8);
      ctx.fillStyle = hex(0x3aa53a);
      fillCircle(ctx, x + 13, 10, 5);
      fillCircle(ctx, x + 19, 10, 5);
      fillCircle(ctx, x + 16, 7, 4);
      break;

    case 7: // door
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x6b5a3a);
      ctx.fillRect(x + 2, 0, 28, TILE);
      ctx.fillStyle = hex(0x8b7a5a);
      ctx.fillRect(x + 4, 2, 24, 28);
      ctx.fillStyle = hex(0xd4af37);
      fillCircle(ctx, x + 23, 18, 2);
      strokeRectWithStyle(ctx, x + 6, 4, 9, 12, 1, hex(0x7a6a4a), 0.5);
      strokeRectWithStyle(ctx, x + 17, 4, 9, 12, 1, hex(0x7a6a4a), 0.5);
      break;

    case 8: // meeting table
      ctx.fillStyle = hex(0x6b6560);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x4a3020);
      ctx.fillRect(x + 2, 2, 28, 28);
      ctx.fillStyle = hex(0x5a4030);
      ctx.fillRect(x + 4, 4, 24, 24);
      ctx.save();
      ctx.fillStyle = hex(0x6a5040);
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x + 6, 6, 10, 6);
      ctx.restore();
      break;

    case 9: // coffee area
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x5a4a3a);
      ctx.fillRect(x + 2, 4, 28, 24);
      ctx.fillStyle = hex(0x333333);
      ctx.fillRect(x + 6, 6, 12, 16);
      ctx.fillStyle = hex(0xff3333);
      fillCircle(ctx, x + 12, 10, 2);
      ctx.fillStyle = hex(0xffffff);
      ctx.fillRect(x + 20, 14, 6, 8);
      ctx.fillStyle = hex(0x8b6914);
      ctx.fillRect(x + 21, 15, 4, 6);
      break;

    case 10: // water cooler
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0xcccccc);
      ctx.fillRect(x + 8, 16, 16, 14);
      ctx.fillStyle = hex(0x88bbff);
      ctx.fillRect(x + 10, 2, 12, 16);
      ctx.fillStyle = hex(0x6699dd);
      ctx.fillRect(x + 10, 6, 12, 12);
      ctx.fillStyle = hex(0x4477bb);
      ctx.fillRect(x + 12, 0, 8, 4);
      ctx.fillStyle = hex(0x888888);
      ctx.fillRect(x + 22, 18, 4, 3);
      break;

    case 11: // bookshelf
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x5a3a1a);
      ctx.fillRect(x + 2, 2, 28, 28);
      ctx.fillStyle = hex(0x6b4a2a);
      ctx.fillRect(x + 2, 10, 28, 2);
      ctx.fillRect(x + 2, 20, 28, 2);
      {
        const bookColors = [0xcc3333, 0x3366cc, 0x33aa33, 0xccaa33, 0x9933cc, 0xcc6633];
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = hex(bookColors[i]);
          ctx.fillRect(x + 4 + i * 4, 3, 3, 7);
          ctx.fillRect(x + 4 + i * 4, 13, 3, 7);
          ctx.fillRect(x + 4 + i * 4, 23, 3, 5);
        }
      }
      break;

    case 12: // darker carpet
      ctx.fillStyle = hex(0x6b6560);
      ctx.fillRect(x, 0, TILE, TILE);
      strokeRectWithStyle(ctx, x, 0, TILE, TILE, 1, hex(0x5e5a55), 0.3);
      ctx.save();
      ctx.fillStyle = hex(0x625e58);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x + 4, 4, 3, 3);
      ctx.fillRect(x + 20, 12, 3, 3);
      ctx.fillRect(x + 12, 22, 3, 3);
      ctx.restore();
      break;

    case 13: // whiteboard
      ctx.fillStyle = hex(0x4a4a5e);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0xcccccc);
      ctx.fillRect(x + 3, 4, 26, 20);
      ctx.fillStyle = hex(0xf0f0f0);
      ctx.fillRect(x + 5, 6, 22, 16);
      lineBetween(ctx, x + 8, 10, x + 22, 10, 1, hex(0x3366cc), 0.5);
      lineBetween(ctx, x + 8, 14, x + 20, 14, 1, hex(0x3366cc), 0.5);
      lineBetween(ctx, x + 8, 18, x + 18, 18, 1, hex(0x3366cc), 0.5);
      ctx.fillStyle = hex(0xaaaaaa);
      ctx.fillRect(x + 6, 24, 20, 3);
      break;

    case 14: // reception desk
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x8b6b3a);
      ctx.fillRect(x + 2, 6, 28, 20);
      ctx.fillStyle = hex(0x9b7b4a);
      ctx.fillRect(x + 2, 4, 28, 6);
      ctx.fillStyle = hex(0x7b5b2a);
      ctx.fillRect(x + 4, 14, 24, 10);
      ctx.fillStyle = hex(0xd4af37);
      ctx.fillRect(x + 12, 16, 8, 4);
      break;

    case 15: // cubicle wall
      ctx.fillStyle = hex(0x8b8378);
      ctx.fillRect(x, 0, TILE, TILE);
      ctx.fillStyle = hex(0x888899);
      ctx.fillRect(x + 12, 0, 8, TILE);
      ctx.fillStyle = hex(0x777788);
      ctx.fillRect(x + 12, 0, 2, TILE);
      ctx.fillRect(x + 18, 0, 2, TILE);
      ctx.save();
      ctx.fillStyle = hex(0x9999aa);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x + 14, 4, 4, 4);
      ctx.fillRect(x + 14, 12, 4, 4);
      ctx.fillRect(x + 14, 20, 4, 4);
      ctx.restore();
      break;
  }
}

// ---------------------------------------------------------------------------
// Object draw functions (mirrors object-textures.ts OBJECT_DRAWERS)
// ---------------------------------------------------------------------------
type ObjDrawer = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

const OBJECT_DRAWERS: Record<string, ObjDrawer> = {
  desk: (ctx, w, h) => {
    ctx.fillStyle = hex(0x6b4226);
    ctx.fillRect(2, 4, w - 4, h - 12);
    ctx.fillStyle = hex(0x523218);
    ctx.fillRect(2, h - 10, w - 4, 4);
    lineBetween(ctx, 4, 8, w - 4, 8, 1, hex(0x7a5236), 0.4);
    lineBetween(ctx, 6, 14, w - 6, 14, 1, hex(0x7a5236), 0.4);
  },

  chair: (ctx, w, h) => {
    ctx.fillStyle = hex(0x4060b0);
    ctx.fillRect(8, 10, w - 16, h - 18);
    ctx.fillStyle = hex(0x3050a0);
    ctx.fillRect(8, 6, w - 16, 6);
    ctx.fillStyle = hex(0x333333);
    ctx.fillRect(10, h - 8, 3, 4);
    ctx.fillRect(w - 13, h - 8, 3, 4);
  },

  computer: (ctx, w, h) => {
    ctx.fillStyle = hex(0x222233);
    ctx.fillRect(6, 2, w - 12, h - 12);
    ctx.fillStyle = hex(0x1a3a2a);
    ctx.fillRect(8, 4, w - 16, h - 16);
    ctx.fillStyle = hex(0x44ff44);
    fillCircle(ctx, w / 2, 10, 2);
    ctx.fillStyle = hex(0x444444);
    ctx.fillRect(w / 2 - 3, h - 12, 6, 4);
    ctx.fillRect(w / 2 - 6, h - 8, 12, 2);
  },

  plant: (ctx, w, h) => {
    ctx.fillStyle = hex(0x8b4513);
    ctx.fillRect(10, h - 12, w - 20, 10);
    ctx.fillStyle = hex(0x6b3210);
    ctx.fillRect(8, h - 14, w - 16, 4);
    ctx.fillStyle = hex(0x2d8b2d);
    fillCircle(ctx, w / 2, h / 2 - 4, 8);
    ctx.fillStyle = hex(0x3aa53a);
    fillCircle(ctx, w / 2 - 3, h / 2 - 6, 5);
    fillCircle(ctx, w / 2 + 3, h / 2 - 6, 5);
    fillCircle(ctx, w / 2, h / 2 - 9, 4);
  },

  bookshelf: (ctx, w, h) => {
    ctx.fillStyle = hex(0x5a3a1a);
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = hex(0x6b4a2a);
    ctx.fillRect(2, 10, w - 4, 2);
    ctx.fillRect(2, 20, w - 4, 2);
    const colors = [0xcc3333, 0x3366cc, 0x33aa33, 0xccaa33, 0x9933cc, 0xcc6633];
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = hex(colors[i]);
      ctx.fillRect(4 + i * 4, 3, 3, 7);
      ctx.fillRect(4 + i * 4, 13, 3, 7);
      ctx.fillRect(4 + i * 4, 23, 3, 5);
    }
  },

  meeting_table: (ctx, w, h) => {
    ctx.fillStyle = hex(0x4a3020);
    ctx.fillRect(2, 2, w - 4, h - 4);
    ctx.fillStyle = hex(0x5a4030);
    ctx.fillRect(4, 4, w - 8, h - 8);
    ctx.save();
    ctx.fillStyle = hex(0x6a5040);
    ctx.globalAlpha = 0.4;
    ctx.fillRect(6, 6, w / 3, h / 3);
    ctx.restore();
  },

  coffee: (ctx, w, h) => {
    ctx.fillStyle = hex(0x5a4a3a);
    ctx.fillRect(2, 4, w - 4, h - 8);
    ctx.fillStyle = hex(0x333333);
    ctx.fillRect(6, 6, 12, 16);
    ctx.fillStyle = hex(0xff3333);
    fillCircle(ctx, 12, 10, 2);
    ctx.fillStyle = hex(0xffffff);
    ctx.fillRect(20, 14, 6, 8);
    ctx.fillStyle = hex(0x8b6914);
    ctx.fillRect(21, 15, 4, 6);
  },

  water_cooler: (ctx, w, h) => {
    ctx.fillStyle = hex(0xcccccc);
    ctx.fillRect(8, h - 16, w - 16, 14);
    ctx.fillStyle = hex(0x88bbff);
    ctx.fillRect(10, 2, w - 20, h - 16);
    ctx.fillStyle = hex(0x6699dd);
    ctx.fillRect(10, 6, w - 20, h - 20);
    ctx.fillStyle = hex(0x4477bb);
    ctx.fillRect(12, 0, w - 24, 4);
    ctx.fillStyle = hex(0x888888);
    ctx.fillRect(w - 10, h - 14, 4, 3);
  },

  whiteboard: (ctx, w, h) => {
    ctx.fillStyle = hex(0xcccccc);
    ctx.fillRect(3, 4, w - 6, h - 8);
    ctx.fillStyle = hex(0xf0f0f0);
    ctx.fillRect(5, 6, w - 10, h - 12);
    lineBetween(ctx, 8, 10, w - 10, 10, 1, hex(0x3366cc), 0.5);
    lineBetween(ctx, 8, 14, w - 12, 14, 1, hex(0x3366cc), 0.5);
    lineBetween(ctx, 8, 18, w - 14, 18, 1, hex(0x3366cc), 0.5);
    ctx.fillStyle = hex(0xaaaaaa);
    ctx.fillRect(6, h - 8, w - 12, 3);
  },

  reception_desk: (ctx, w, h) => {
    ctx.fillStyle = hex(0x8b6b3a);
    ctx.fillRect(2, 6, w - 4, h - 10);
    ctx.fillStyle = hex(0x9b7b4a);
    ctx.fillRect(2, 4, w - 4, 6);
    ctx.fillStyle = hex(0x7b5b2a);
    ctx.fillRect(4, 14, w - 8, h - 18);
    ctx.fillStyle = hex(0xd4af37);
    ctx.fillRect(w / 2 - 4, 16, 8, 4);
  },

  cubicle_wall: (ctx, w, h) => {
    ctx.fillStyle = hex(0x888899);
    ctx.fillRect(w / 2 - 4, 0, 8, h);
    ctx.fillStyle = hex(0x777788);
    ctx.fillRect(w / 2 - 4, 0, 2, h);
    ctx.fillRect(w / 2 + 2, 0, 2, h);
    ctx.save();
    ctx.fillStyle = hex(0x9999aa);
    ctx.globalAlpha = 0.3;
    ctx.fillRect(w / 2 - 2, 4, 4, 4);
    ctx.fillRect(w / 2 - 2, 12, 4, 4);
    ctx.fillRect(w / 2 - 2, 20, 4, 4);
    ctx.restore();
  },
};

// Object sizes (from OBJECT_TYPES)
const OBJECT_SIZES: Record<string, { w: number; h: number }> = {
  desk:           { w: 1, h: 1 },
  chair:          { w: 1, h: 1 },
  computer:       { w: 1, h: 1 },
  plant:          { w: 1, h: 1 },
  bookshelf:      { w: 1, h: 1 },
  meeting_table:  { w: 2, h: 2 },
  coffee:         { w: 1, h: 1 },
  water_cooler:   { w: 1, h: 1 },
  whiteboard:     { w: 1, h: 1 },
  reception_desk: { w: 2, h: 1 },
  cubicle_wall:   { w: 1, h: 1 },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  fs.mkdirSync(OBJ_DIR, { recursive: true });

  // 1. Generate tileset PNG (512x32 = 16 tiles in a row)
  const tilesetCanvas = createCanvas(16 * TILE, TILE);
  const tilesetCtx = tilesetCanvas.getContext("2d");

  for (let i = 0; i < 16; i++) {
    drawTile(tilesetCtx, i);
  }

  const tilesetPath = path.join(OUT_DIR, "deskrpg-tileset.png");
  fs.writeFileSync(tilesetPath, tilesetCanvas.toBuffer("image/png"));
  console.log(`  tileset -> ${tilesetPath}`);

  // 2. Generate individual object PNGs
  for (const [typeId, drawer] of Object.entries(OBJECT_DRAWERS)) {
    const size = OBJECT_SIZES[typeId];
    if (!size) continue;
    const w = size.w * TILE;
    const h = size.h * TILE;

    const objCanvas = createCanvas(w, h);
    const objCtx = objCanvas.getContext("2d");
    drawer(objCtx, w, h);

    const objPath = path.join(OBJ_DIR, `${typeId}.png`);
    fs.writeFileSync(objPath, objCanvas.toBuffer("image/png"));
    console.log(`  object  -> ${objPath}`);
  }

  console.log("\nDone! Generated tileset + object PNGs.");
}

main();
