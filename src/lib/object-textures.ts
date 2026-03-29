import Phaser from "phaser";
import { OBJECT_TYPES } from "./object-types";

const TILE = 32;

// Draw functions for each object type — each draws into a Graphics at (0,0)
const OBJECT_DRAWERS: Record<string, (g: Phaser.GameObjects.Graphics, w: number, h: number) => void> = {
  desk: (g, w, h) => {
    // Desk top
    g.fillStyle(0x6b4226);
    g.fillRect(2, 4, w - 4, h - 12);
    // Desk edge (darker)
    g.fillStyle(0x523218);
    g.fillRect(2, h - 10, w - 4, 4);
    // Wood grain
    g.lineStyle(1, 0x7a5236, 0.4);
    g.lineBetween(4, 8, w - 4, 8);
    g.lineBetween(6, 14, w - 6, 14);
  },

  chair: (g, w, h) => {
    // Seat
    g.fillStyle(0x4060b0);
    g.fillRect(8, 10, w - 16, h - 18);
    // Back
    g.fillStyle(0x3050a0);
    g.fillRect(8, 6, w - 16, 6);
    // Legs
    g.fillStyle(0x333333);
    g.fillRect(10, h - 8, 3, 4);
    g.fillRect(w - 13, h - 8, 3, 4);
  },

  computer: (g, w, h) => {
    // Monitor
    g.fillStyle(0x222233);
    g.fillRect(6, 2, w - 12, h - 12);
    // Screen
    g.fillStyle(0x1a3a2a);
    g.fillRect(8, 4, w - 16, h - 16);
    // Green indicator
    g.fillStyle(0x44ff44);
    g.fillCircle(w / 2, 10, 2);
    // Stand
    g.fillStyle(0x444444);
    g.fillRect(w / 2 - 3, h - 12, 6, 4);
    g.fillRect(w / 2 - 6, h - 8, 12, 2);
  },

  plant: (g, w, h) => {
    // Pot
    g.fillStyle(0x8b4513);
    g.fillRect(10, h - 12, w - 20, 10);
    g.fillStyle(0x6b3210);
    g.fillRect(8, h - 14, w - 16, 4);
    // Leaves
    g.fillStyle(0x2d8b2d);
    g.fillCircle(w / 2, h / 2 - 4, 8);
    g.fillStyle(0x3aa53a);
    g.fillCircle(w / 2 - 3, h / 2 - 6, 5);
    g.fillCircle(w / 2 + 3, h / 2 - 6, 5);
    g.fillCircle(w / 2, h / 2 - 9, 4);
  },

  bookshelf: (g, w, h) => {
    // Frame
    g.fillStyle(0x5a3a1a);
    g.fillRect(2, 2, w - 4, h - 4);
    // Shelves
    g.fillStyle(0x6b4a2a);
    g.fillRect(2, 10, w - 4, 2);
    g.fillRect(2, 20, w - 4, 2);
    // Books
    const colors = [0xcc3333, 0x3366cc, 0x33aa33, 0xccaa33, 0x9933cc, 0xcc6633];
    for (let i = 0; i < 6; i++) {
      g.fillStyle(colors[i]);
      g.fillRect(4 + i * 4, 3, 3, 7);
      g.fillRect(4 + i * 4, 13, 3, 7);
      g.fillRect(4 + i * 4, 23, 3, 5);
    }
  },

  meeting_table: (g, w, h) => {
    // Table surface
    g.fillStyle(0x4a3020);
    g.fillRect(2, 2, w - 4, h - 4);
    // Highlight
    g.fillStyle(0x5a4030);
    g.fillRect(4, 4, w - 8, h - 8);
    // Reflection
    g.fillStyle(0x6a5040, 0.4);
    g.fillRect(6, 6, w / 3, h / 3);
  },

  coffee: (g, w, h) => {
    // Counter
    g.fillStyle(0x5a4a3a);
    g.fillRect(2, 4, w - 4, h - 8);
    // Machine
    g.fillStyle(0x333333);
    g.fillRect(6, 6, 12, 16);
    // Red light
    g.fillStyle(0xff3333);
    g.fillCircle(12, 10, 2);
    // Cup
    g.fillStyle(0xffffff);
    g.fillRect(20, 14, 6, 8);
    g.fillStyle(0x8b6914);
    g.fillRect(21, 15, 4, 6);
  },

  water_cooler: (g, w, h) => {
    // Base
    g.fillStyle(0xcccccc);
    g.fillRect(8, h - 16, w - 16, 14);
    // Bottle
    g.fillStyle(0x88bbff);
    g.fillRect(10, 2, w - 20, h - 16);
    // Water level
    g.fillStyle(0x6699dd);
    g.fillRect(10, 6, w - 20, h - 20);
    // Cap
    g.fillStyle(0x4477bb);
    g.fillRect(12, 0, w - 24, 4);
    // Tap
    g.fillStyle(0x888888);
    g.fillRect(w - 10, h - 14, 4, 3);
  },

  whiteboard: (g, w, h) => {
    // Frame
    g.fillStyle(0xcccccc);
    g.fillRect(3, 4, w - 6, h - 8);
    // Surface
    g.fillStyle(0xf0f0f0);
    g.fillRect(5, 6, w - 10, h - 12);
    // Writing
    g.lineStyle(1, 0x3366cc, 0.5);
    g.lineBetween(8, 10, w - 10, 10);
    g.lineBetween(8, 14, w - 12, 14);
    g.lineBetween(8, 18, w - 14, 18);
    // Tray
    g.fillStyle(0xaaaaaa);
    g.fillRect(6, h - 8, w - 12, 3);
  },

  reception_desk: (g, w, h) => {
    // Body
    g.fillStyle(0x8b6b3a);
    g.fillRect(2, 6, w - 4, h - 10);
    // Counter top
    g.fillStyle(0x9b7b4a);
    g.fillRect(2, 4, w - 4, 6);
    // Front panel
    g.fillStyle(0x7b5b2a);
    g.fillRect(4, 14, w - 8, h - 18);
    // Logo
    g.fillStyle(0xd4af37);
    g.fillRect(w / 2 - 4, 16, 8, 4);
  },

  cubicle_wall: (g, w, h) => {
    // Partition
    g.fillStyle(0x888899);
    g.fillRect(w / 2 - 4, 0, 8, h);
    // Frame
    g.fillStyle(0x777788);
    g.fillRect(w / 2 - 4, 0, 2, h);
    g.fillRect(w / 2 + 2, 0, 2, h);
    // Texture
    g.fillStyle(0x9999aa, 0.3);
    g.fillRect(w / 2 - 2, 4, 4, 4);
    g.fillRect(w / 2 - 2, 12, 4, 4);
    g.fillRect(w / 2 - 2, 20, 4, 4);
  },
};

function generateFlippedTexture(
  scene: Phaser.Scene,
  sourceKey: string,
  targetKey: string,
  w: number, h: number,
  flipX: boolean, flipY: boolean,
): void {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const sourceImage = scene.textures.get(sourceKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;

  ctx.save();
  if (flipX) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (flipY) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(sourceImage, 0, 0);
  ctx.restore();

  scene.textures.addCanvas(targetKey, canvas);
}

function generateTintedTexture(
  scene: Phaser.Scene,
  sourceKey: string,
  targetKey: string,
  w: number, h: number,
  brightness: number, // 0-1, where 1 = no change, 0.75 = slightly darker
): void {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const sourceImage = scene.textures.get(sourceKey).getSourceImage() as HTMLImageElement | HTMLCanvasElement;
  ctx.drawImage(sourceImage, 0, 0);

  // Darken overlay
  ctx.globalCompositeOperation = "multiply";
  const val = Math.round(brightness * 255);
  ctx.fillStyle = `rgb(${val},${val},${val})`;
  ctx.fillRect(0, 0, w, h);

  // Restore alpha from original
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(sourceImage, 0, 0);

  scene.textures.addCanvas(targetKey, canvas);
}

export function generateObjectTextures(scene: Phaser.Scene): void {
  for (const [typeId, def] of Object.entries(OBJECT_TYPES)) {
    const drawer = OBJECT_DRAWERS[typeId];
    if (!drawer || def.renderType !== "graphic") continue;

    const w = def.width * TILE;
    const h = def.height * TILE;

    // --- DOWN (default / front-facing) ---
    const gDown = scene.add.graphics();
    drawer(gDown, w, h);
    gDown.generateTexture(`obj-${typeId}-down`, w, h);
    gDown.generateTexture(`obj-${typeId}`, w, h); // backward compat alias
    gDown.destroy();

    // --- RIGHT (horizontal flip via canvas) ---
    generateFlippedTexture(scene, `obj-${typeId}-down`, `obj-${typeId}-right`, w, h, true, false);

    // --- LEFT (same as down for front-facing objects) ---
    generateFlippedTexture(scene, `obj-${typeId}-down`, `obj-${typeId}-left`, w, h, false, false);

    // --- UP (back view - darker tint) ---
    generateTintedTexture(scene, `obj-${typeId}-down`, `obj-${typeId}-up`, w, h, 0.75);
  }
}
