import Phaser from "phaser";
import { EventBus, pendingChannelData, setPendingChannelData } from "../EventBus";
import type { Socket } from "socket.io-client";
import { MapObject, MapData, OBJECT_TYPES, OBJECT_TYPE_LIST, computeOccupiedTiles, detectAndConvertMapData, generateObjectId, canPlaceObject, getObjectDimensions } from "@/lib/object-types";
import { getCenteredCameraBounds } from "../camera-layout";

// ---------------------------------------------------------------------------
// Map constants
// ---------------------------------------------------------------------------

const MAP_COLS = 40;
const MAP_ROWS = 30;
const TILE_SIZE = 32;
const PLAYER_SPEED = 120;

// Sprite frame layout: 9 cols x 4 rows (walk-only sheet 576x256)
const SPRITE_COLS = 9;
const DIR_UP = 0;
const DIR_LEFT = 1;
const DIR_DOWN = 2;
const DIR_RIGHT = 3;

const MOVE_SEND_INTERVAL = 66;
const LERP_FACTOR = 0.2;
const NPC_INTERACT_RADIUS = 64;

const MINIMAP_SIZE = 150;
const MINIMAP_PADDING = 10;
const MINIMAP_TOP = 50;
const MAIN_CAMERA_ZOOM = 2;

const DIR_NAME_MAP: Record<string, number> = {
  up: DIR_UP,
  left: DIR_LEFT,
  down: DIR_DOWN,
  right: DIR_RIGHT,
};
const DIR_NUM_TO_NAME = ["up", "left", "down", "right"];

// Tile indices (must match BootScene tileset)
const T = {
  EMPTY: 0,
  FLOOR: 1,
  WALL: 2,
  DESK: 3,
  CHAIR: 4,
  COMPUTER: 5,
  PLANT: 6,
  DOOR: 7,
  MEETING_TABLE: 8,
  COFFEE: 9,
  WATER_COOLER: 10,
  BOOKSHELF: 11,
  CARPET: 12,
  WHITEBOARD: 13,
  RECEPTION_DESK: 14,
  CUBICLE_WALL: 15,
};

// Tiles that block movement (walls layer only; objects handled by objectOccupiedTiles)
const COLLISION_TILES = new Set([
  T.WALL,
]);

// Tile names for the editor toolbar
const TILE_NAMES = [
  "Empty",
  "Floor",
  "Wall",
  "Desk",
  "Chair",
  "Computer",
  "Plant",
  "Door",
  "Mtg Table",
  "Coffee",
  "Cooler",
  "Bookshelf",
  "Carpet",
  "Whiteboard",
  "Reception",
  "Cubicle",
];

// ---------------------------------------------------------------------------
// A* Pathfinding
// ---------------------------------------------------------------------------

interface PathNode {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

function findPath(
  startTileX: number, startTileY: number,
  endTileX: number, endTileY: number,
  isWalkable: (tx: number, ty: number) => boolean
): { x: number; y: number }[] | null {
  const open: PathNode[] = [];
  const closed = new Set<string>();

  const start: PathNode = { x: startTileX, y: startTileY, g: 0, h: 0, f: 0, parent: null };
  start.h = Math.abs(endTileX - startTileX) + Math.abs(endTileY - startTileY);
  start.f = start.h;
  open.push(start);

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;
    const key = `${current.x},${current.y}`;

    if (current.x === endTileX && current.y === endTileY) {
      const path: { x: number; y: number }[] = [];
      let node: PathNode | null = current;
      while (node) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    closed.add(key);

    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nkey = `${nx},${ny}`;

      if (closed.has(nkey)) continue;
      if (!isWalkable(nx, ny)) continue;

      const g = current.g + 1;
      const h = Math.abs(endTileX - nx) + Math.abs(endTileY - ny);
      const f = g + h;

      const existing = open.find(n => n.x === nx && n.y === ny);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = f;
          existing.parent = current;
        }
      } else {
        open.push({ x: nx, y: ny, g, h, f, parent: current });
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Remote player wrapper
// ---------------------------------------------------------------------------

interface RemotePlayerData {
  id: string;
  characterName: string;
  appearance: unknown;
  x: number;
  y: number;
  direction: string;
  animation: string;
}

class RemotePlayer {
  sprite: Phaser.GameObjects.Sprite;
  nameLabel: Phaser.GameObjects.Text;
  targetX: number;
  targetY: number;
  direction: string;
  animation: string;
  textureKey: string;

  constructor(scene: Phaser.Scene, data: RemotePlayerData, textureKey: string) {
    this.textureKey = textureKey;
    this.targetX = data.x;
    this.targetY = data.y;
    this.direction = data.direction || "down";
    this.animation = data.animation || "idle";

    const dirIdx = DIR_NAME_MAP[this.direction] ?? DIR_DOWN;

    // Use textureKey if loaded, otherwise fallback placeholder
    const texKey = scene.textures.exists(textureKey) ? textureKey : "fallback-char";
    this.sprite = scene.add.sprite(data.x, data.y, texKey);
    if (texKey === textureKey) {
      this.sprite.setFrame(dirIdx * SPRITE_COLS);
    }
    this.sprite.setOrigin(0.5, 0.85);
    this.sprite.setDisplaySize(48, 48);

    this.nameLabel = scene.add.text(data.x, data.y - 44, data.characterName, {
      fontSize: "11px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 2,
      align: "center",
    });
    this.nameLabel.setOrigin(0.5, 1);
    this.nameLabel.setDepth(20001);
  }

  updatePosition(x: number, y: number, direction: string, animation: string) {
    this.targetX = x;
    this.targetY = y;
    this.direction = direction;
    this.animation = animation;
  }

  lerpUpdate() {
    const dx = this.targetX - this.sprite.x;
    const dy = this.targetY - this.sprite.y;

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.sprite.x = this.targetX;
      this.sprite.y = this.targetY;
    } else if (Math.abs(dx) > 200 || Math.abs(dy) > 200) {
      this.sprite.x = this.targetX;
      this.sprite.y = this.targetY;
    } else {
      this.sprite.x += dx * LERP_FACTOR;
      this.sprite.y += dy * LERP_FACTOR;
    }

    this.nameLabel.setPosition(this.sprite.x, this.sprite.y - 44);

    const dirIdx = DIR_NAME_MAP[this.direction] ?? DIR_DOWN;
    const animKey = `${this.textureKey}-walk-${this.direction}`;

    if (this.animation === "walk") {
      if (this.sprite.scene.anims.exists(animKey)) {
        this.sprite.anims.play(animKey, true);
      }
    } else {
      this.sprite.anims.stop();
      this.sprite.setFrame(dirIdx * SPRITE_COLS);
    }
  }

  distanceTo(x: number, y: number): number {
    const dx = this.sprite.x - x;
    const dy = this.sprite.y - y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private highlightGlow: Phaser.GameObjects.Graphics | null = null;
  private isHighlighted = false;

  setHighlight(on: boolean): void {
    if (on === this.isHighlighted) return;
    this.isHighlighted = on;
    if (on) {
      if (!this.highlightGlow) {
        this.highlightGlow = this.sprite.scene.add.graphics();
        this.highlightGlow.setDepth(20000);
      }
      this.highlightGlow.clear();
      this.highlightGlow.lineStyle(3, 0x60a5fa, 0.8);
      this.highlightGlow.strokeRoundedRect(
        this.sprite.x - 15, this.sprite.y - 39, 30, 48, 6
      );
      this.highlightGlow.lineStyle(5, 0x60a5fa, 0.3);
      this.highlightGlow.strokeRoundedRect(
        this.sprite.x - 17, this.sprite.y - 41, 34, 52, 8
      );
    } else {
      this.highlightGlow?.clear();
    }
  }

  updateHighlightPosition(): void {
    if (this.isHighlighted && this.highlightGlow) {
      this.highlightGlow.clear();
      this.highlightGlow.lineStyle(3, 0x60a5fa, 0.8);
      this.highlightGlow.strokeRoundedRect(
        this.sprite.x - 15, this.sprite.y - 39, 30, 48, 6
      );
      this.highlightGlow.lineStyle(5, 0x60a5fa, 0.3);
      this.highlightGlow.strokeRoundedRect(
        this.sprite.x - 17, this.sprite.y - 41, 34, 52, 8
      );
    }
  }

  destroy() {
    this.sprite.destroy();
    this.nameLabel.destroy();
    this.highlightGlow?.destroy();
  }
}

// ---------------------------------------------------------------------------
// NPC wrapper
// ---------------------------------------------------------------------------

interface NpcData {
  id: string;
  name: string;
  positionX: number;
  positionY: number;
  direction: string;
  appearance?: unknown;
}

class NpcSprite {
  id: string;
  name: string;
  sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle;
  nameLabel: Phaser.GameObjects.Text;
  pixelX: number;
  pixelY: number;
  private scene: Phaser.Scene;
  direction: number;
  private textureKey: string | null = null; // stored for walk animations

  // Movement fields (runtime-only, not persisted)
  homeCol: number;
  homeRow: number;
  homeDirection: number;
  currentPath: { x: number; y: number }[] | null = null;
  pathIndex = 0;
  moveState: "idle" | "moving-to-player" | "waiting" | "returning" = "idle";
  moveSpeed = 150; // px/s (faster than player's 120)
  pendingMessage: string | null = null;
  pendingReportId: string | null = null;
  pendingReportKind: string | null = null;
  arrivalBubbleText: string | null = null;
  waitDurationMs = 10000;
  private pathRecalcTimer = 0; // ms accumulated
  private stuckFrames = 0;
  private lastDist = Infinity;
  waitTimer = 0; // ms accumulated while in "waiting" state

  constructor(scene: Phaser.Scene, data: NpcData) {
    this.id = data.id;
    this.name = data.name;
    this.scene = scene;
    this.pixelX = data.positionX * TILE_SIZE + TILE_SIZE / 2;
    this.pixelY = data.positionY * TILE_SIZE + TILE_SIZE / 2;
    this.direction = DIR_NAME_MAP[data.direction] ?? DIR_DOWN;
    this.homeCol = data.positionX;
    this.homeRow = data.positionY;
    this.homeDirection = this.direction;

    const color = data.id === "sarah" ? 0xe879a0 : 0x5b9bd5;
    this.sprite = scene.add.rectangle(this.pixelX, this.pixelY, 28, 28, color);
    (this.sprite as Phaser.GameObjects.Rectangle).setStrokeStyle(2, 0xffffff);

    this.nameLabel = scene.add.text(this.pixelX, this.pixelY - 44, data.name, {
      fontSize: "11px",
      color: "#fbbf24",
      stroke: "#000000",
      strokeThickness: 3,
      align: "center",
      fontStyle: "bold",
    });
    this.nameLabel.setOrigin(0.5, 1);
    this.nameLabel.setDepth(20001);

    if (data.appearance) {
      const textureKey = `npc-${data.id}`;
      EventBus.emit("composite-remote-player", {
        id: data.id,
        appearance: data.appearance,
        textureKey,
      });

      const onReady = (result: { id: string; textureKey: string; dataUrl: string }) => {
        if (result.id !== data.id) return;
        EventBus.off("remote-spritesheet-ready", onReady);
        this.applyTexture(result.textureKey, result.dataUrl);
      };
      EventBus.on("remote-spritesheet-ready", onReady);
    }
  }

  private applyTexture(textureKey: string, dataUrl: string): void {
    if (!textureKey || !dataUrl) return;

    const img = new Image();
    img.onerror = () => {
      console.warn(`[NPC ${this.id}] Failed to load texture from dataUrl`);
    };
    img.onload = () => {
      try {
        // Use a unique key to avoid texture removal race conditions
        const uniqueKey = `${textureKey}-${Date.now()}`;
        const tex = this.scene.textures.addSpriteSheet(uniqueKey, img, {
          frameWidth: 64,
          frameHeight: 64,
        });
        if (!tex) return;

        const oldSprite = this.sprite;
        const newSprite = this.scene.add.sprite(this.pixelX, this.pixelY, uniqueKey);
        newSprite.setOrigin(0.5, 0.85);
        newSprite.setDisplaySize(48, 48);

        const idleFrame = this.direction * SPRITE_COLS;
        const totalFrames = tex.frameTotal - 1;
        if (idleFrame < totalFrames) {
          newSprite.setFrame(idleFrame);
        }
        this.sprite = newSprite;
        this.textureKey = uniqueKey;
        oldSprite.destroy();

        // Create walk animations for all 4 directions
        const walkDirs = [
          { name: "up", row: DIR_UP },
          { name: "left", row: DIR_LEFT },
          { name: "down", row: DIR_DOWN },
          { name: "right", row: DIR_RIGHT },
        ];
        for (const wd of walkDirs) {
          const wKey = `npc-${this.id}-walk-${wd.name}`;
          if (!this.scene.anims.exists(wKey) && (wd.row * SPRITE_COLS + SPRITE_COLS - 1) < totalFrames) {
            this.scene.anims.create({
              key: wKey,
              frames: this.scene.anims.generateFrameNumbers(uniqueKey, {
                start: wd.row * SPRITE_COLS + 1,
                end: wd.row * SPRITE_COLS + SPRITE_COLS - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
        }

        const animKey = `npc-${this.id}-idle-${Date.now()}`;
        const frame0 = this.direction * SPRITE_COLS;
        const frame1 = frame0 + 1;
        if (frame1 < totalFrames) {
          if (!this.scene.anims.exists(animKey)) {
            this.scene.anims.create({
              key: animKey,
              frames: [
                { key: uniqueKey, frame: frame0 },
                { key: uniqueKey, frame: frame1 },
              ],
              frameRate: 2,
              repeat: -1,
            });
            newSprite.play(animKey);
          }
        }
      } catch (err) {
        console.warn(`[NPC ${this.id}] Texture apply error:`, err);
      }
    };
    img.src = dataUrl;
  }

  private highlightGlow: Phaser.GameObjects.Graphics | null = null;
  private isHighlighted = false;

  setHighlight(on: boolean): void {
    if (on === this.isHighlighted) return;
    this.isHighlighted = on;

    if (on) {
      if (!this.highlightGlow) {
        this.highlightGlow = this.scene.add.graphics();
        this.highlightGlow.setDepth(20000);
      }
      this.highlightGlow.clear();
      this.highlightGlow.lineStyle(3, 0xfbbf24, 0.8);
      this.highlightGlow.strokeRoundedRect(
        this.pixelX - 15, this.pixelY - 39, 30, 48, 6
      );
      this.highlightGlow.lineStyle(5, 0xfbbf24, 0.3);
      this.highlightGlow.strokeRoundedRect(
        this.pixelX - 17, this.pixelY - 41, 34, 52, 8
      );
    } else {
      if (this.highlightGlow) {
        this.highlightGlow.clear();
      }
    }
  }

  distanceTo(x: number, y: number): number {
    const dx = this.pixelX - x;
    const dy = this.pixelY - y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  destroy() {
    this.sprite.destroy();
    this.nameLabel.destroy();
    if (this.highlightGlow) this.highlightGlow.destroy();
  }

  updateName(name: string): void {
    this.name = name;
    this.nameLabel.setText(name);
  }

  updateDirection(direction: string): void {
    this.homeDirection = DIR_NAME_MAP[direction] ?? DIR_DOWN;
    this.direction = this.homeDirection;
    this.stopWalkAnimation();
  }

  updateAppearance(appearance: unknown): void {
    if (!appearance) return;
    const textureKey = `npc-${this.id}`;
    EventBus.emit("composite-remote-player", {
      id: this.id,
      appearance,
      textureKey,
    });

    const onReady = (result: { id: string; textureKey: string; dataUrl: string }) => {
      if (result.id !== this.id) return;
      EventBus.off("remote-spritesheet-ready", onReady);
      this.applyTexture(result.textureKey, result.dataUrl);
    };
    EventBus.on("remote-spritesheet-ready", onReady);
  }

  updateFromData(data: { name?: string; direction?: string; appearance?: unknown }): void {
    if (typeof data.name === "string" && data.name.trim()) {
      this.updateName(data.name);
    }
    if (typeof data.direction === "string") {
      this.updateDirection(data.direction);
    }
    if (data.appearance !== undefined) {
      this.updateAppearance(data.appearance);
    }
  }

  moveTo(
    targetCol: number,
    targetRow: number,
    findPathFn: (sx: number, sy: number, ex: number, ey: number, walkable: (tx: number, ty: number) => boolean) => { x: number; y: number }[] | null,
    isWalkableFn: (tx: number, ty: number) => boolean,
    options?: {
      message?: string;
      reportId?: string;
      reportKind?: string;
      bubbleText?: string;
      waitDurationMs?: number;
    },
  ): boolean {
    const startCol = Math.floor(this.pixelX / TILE_SIZE);
    const startRow = Math.floor(this.pixelY / TILE_SIZE);

    // Path to player's tile directly — arrival is checked by NPC_INTERACT_RADIUS
    // so NPC will stop before actually overlapping the player
    const path = findPathFn(startCol, startRow, targetCol, targetRow, isWalkableFn);
    if (!path || path.length === 0) return false;

    this.currentPath = path;
    this.pathIndex = 0;
    this.stuckFrames = 0;
    this.lastDist = Infinity;
    this.pathRecalcTimer = 0;
    this.pendingMessage = options?.message || null;
    this.pendingReportId = options?.reportId || null;
    this.pendingReportKind = options?.reportKind || null;
    this.arrivalBubbleText = options?.bubbleText || null;
    this.waitDurationMs = options?.waitDurationMs ?? 10000;
    this.moveState = "moving-to-player";
    return true;
  }

  returnToHome(
    findPathFn: (sx: number, sy: number, ex: number, ey: number, walkable: (tx: number, ty: number) => boolean) => { x: number; y: number }[] | null,
    isWalkableFn: (tx: number, ty: number) => boolean,
  ): boolean {
    const startCol = Math.floor(this.pixelX / TILE_SIZE);
    const startRow = Math.floor(this.pixelY / TILE_SIZE);

    if (startCol === this.homeCol && startRow === this.homeRow) {
      this.moveState = "idle";
      this.snapToHome();
      return true;
    }

    // Allow home tile as walkable destination (it may be marked occupied)
    const homeCol = this.homeCol;
    const homeRow = this.homeRow;
    const walkableWithHome = (tx: number, ty: number) =>
      (tx === homeCol && ty === homeRow) || isWalkableFn(tx, ty);

    const path = findPathFn(startCol, startRow, this.homeCol, this.homeRow, walkableWithHome);
    if (!path || path.length === 0) {
      this.snapToHome();
      this.moveState = "idle";
      return true;
    }

    this.currentPath = path;
    this.pathIndex = 0;
    this.stuckFrames = 0;
    this.lastDist = Infinity;
    this.pathRecalcTimer = 0;
    this.pendingMessage = null;
    this.pendingReportId = null;
    this.pendingReportKind = null;
    this.arrivalBubbleText = null;
    this.waitDurationMs = 10000;
    this.moveState = "returning";
    return true;
  }

  private snapToHome(): void {
    this.pixelX = this.homeCol * TILE_SIZE + TILE_SIZE / 2;
    this.pixelY = this.homeRow * TILE_SIZE + TILE_SIZE / 2;
    this.direction = this.homeDirection;
    this.sprite.setPosition(this.pixelX, this.pixelY);
    this.nameLabel.setPosition(this.pixelX, this.pixelY - 44);
    if (this.highlightGlow) this.highlightGlow.clear();
    this.stopWalkAnimation();
  }

  private stopWalkAnimation(): void {
    if (this.sprite instanceof Phaser.GameObjects.Sprite && this.textureKey) {
      this.sprite.stop();
      const idleFrame = this.direction * SPRITE_COLS;
      this.sprite.setFrame(idleFrame);
    }
  }

  updateMovement(
    delta: number,
    playerX: number,
    playerY: number,
    findPathFn: (sx: number, sy: number, ex: number, ey: number, walkable: (tx: number, ty: number) => boolean) => { x: number; y: number }[] | null,
    isWalkableFn: (tx: number, ty: number) => boolean,
  ): "arrived" | "returning-done" | "moving" | "idle" {
    if (this.moveState === "idle" || this.moveState === "waiting") return "idle";
    if (!this.currentPath) return "idle";

    // --- Path recalculation (every 3s, only when moving toward player) ---
    if (this.moveState === "moving-to-player") {
      this.pathRecalcTimer += delta;
      if (this.pathRecalcTimer >= 3000) {
        this.pathRecalcTimer = 0;
        const distToPlayer = this.distanceTo(playerX, playerY);
        if (distToPlayer > TILE_SIZE + 4) {
          const playerCol = Math.floor(playerX / TILE_SIZE);
          const playerRow = Math.floor(playerY / TILE_SIZE);
          const startCol = Math.floor(this.pixelX / TILE_SIZE);
          const startRow = Math.floor(this.pixelY / TILE_SIZE);
          const newPath = findPathFn(startCol, startRow, playerCol, playerRow, isWalkableFn);
          if (newPath && newPath.length > 0) {
            this.currentPath = newPath;
            this.pathIndex = 0;
            this.stuckFrames = 0;
            this.lastDist = Infinity;
          }
        }
      }

      // --- Arrival check — close enough to interact (1 tile distance) ---
      const distToPlayer = this.distanceTo(playerX, playerY);
      if (distToPlayer < TILE_SIZE + 4) { // ~36px — right next to player
        this.currentPath = null;
        this.moveState = "waiting";
        const adx = playerX - this.pixelX;
        const ady = playerY - this.pixelY;
        if (Math.abs(adx) > Math.abs(ady)) {
          this.direction = adx > 0 ? DIR_RIGHT : DIR_LEFT;
        } else {
          this.direction = ady > 0 ? DIR_DOWN : DIR_UP;
        }
        this.stopWalkAnimation();
        this.waitTimer = 0;
        return "arrived";
      }
    }

    // --- Check if path is exhausted ---
    if (this.pathIndex >= this.currentPath.length) {
      if (this.moveState === "returning") {
        // Path ended — snap to home regardless of distance
        this.snapToHome();
        this.currentPath = null;
        this.moveState = "idle";
        return "returning-done";
      }
      // moving-to-player but path ended without reaching player — wait for recalc
      this.currentPath = null;
      return "moving";
    }

    // --- Follow path (matching player path-following pattern exactly) ---
    const target = this.currentPath[this.pathIndex];
    const targetPx = target.x * TILE_SIZE + TILE_SIZE / 2;
    const targetPy = target.y * TILE_SIZE + TILE_SIZE / 2;

    const dx = targetPx - this.pixelX;
    const dy = targetPy - this.pixelY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Stuck detection (same as player)
    if (dist < this.lastDist - 0.5) {
      this.stuckFrames = 0;
      this.lastDist = dist;
    } else {
      this.stuckFrames++;
    }

    const reached = dist < TILE_SIZE * 0.6;
    const stuck = this.stuckFrames > 30;

    if (reached || stuck) {
      // Advance to next waypoint (NO snap — just like player)
      this.pathIndex++;
      this.stuckFrames = 0;
      this.lastDist = Infinity;

      // Check if path is now complete
      if (this.pathIndex >= this.currentPath.length) {
        if (this.moveState === "returning") {
          this.snapToHome();
          this.currentPath = null;
          this.moveState = "idle";
          this.stopWalkAnimation();
          return "returning-done";
        }
        // Path ended for moving-to-player, wait for next recalc cycle
        this.currentPath = null;
        this.stopWalkAnimation();
        return "moving";
      }
    }

    // Always move toward current waypoint (velocity-based, like player's setVelocity)
    const curTarget = this.currentPath[this.pathIndex];
    const curPx = curTarget.x * TILE_SIZE + TILE_SIZE / 2;
    const curPy = curTarget.y * TILE_SIZE + TILE_SIZE / 2;
    const cdx = curPx - this.pixelX;
    const cdy = curPy - this.pixelY;

    const moveAmount = this.moveSpeed * (delta / 1000);
    const angle = Math.atan2(cdy, cdx);
    this.pixelX += Math.cos(angle) * moveAmount;
    this.pixelY += Math.sin(angle) * moveAmount;

    // Update direction
    if (Math.abs(cdx) > Math.abs(cdy)) {
      this.direction = cdx > 0 ? DIR_RIGHT : DIR_LEFT;
    } else {
      this.direction = cdy > 0 ? DIR_DOWN : DIR_UP;
    }

    // Play walk animation for current direction
    if (this.sprite instanceof Phaser.GameObjects.Sprite && this.textureKey) {
      const walkKey = `npc-${this.id}-walk-${DIR_NUM_TO_NAME[this.direction]}`;
      if (this.scene.anims.exists(walkKey) && this.sprite.anims.currentAnim?.key !== walkKey) {
        this.sprite.play(walkKey, true);
      }
    }

    // Update visual positions every frame
    this.sprite.setPosition(this.pixelX, this.pixelY);
    this.nameLabel.setPosition(this.pixelX, this.pixelY - 44);
    if (this.highlightGlow) {
      this.highlightGlow.clear();
      if (this.isHighlighted) this.setHighlight(true);
    }

    return "moving";
  }
}

// ---------------------------------------------------------------------------
// GameScene
// ---------------------------------------------------------------------------

export class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private interactKey!: Phaser.Input.Keyboard.Key;
  private tabKey!: Phaser.Input.Keyboard.Key;
  private currentDirection: number = DIR_DOWN;
  private playerReady = false;

  // Multiplayer
  private socket: Socket | null = null;
  private remotePlayers = new Map<string, RemotePlayer>();
  private lastMoveSent = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentDir = "";
  private lastSentAnim = "";
  private characterId = "";
  private characterName = "";
  private appearance: unknown = null;

  // NPCs
  private npcSprites: NpcSprite[] = [];
  private npcTilePositions: Set<string> = new Set(); // "col,row" for spawn collision check
  private npcPositionSyncTimer = 0;
  private nearbyNpcs: NpcSprite[] = [];
  private nearbyPlayers: { id: string; name: string }[] = [];
  private dialogOpen = false;
  private lastToastMessage: string | null = null;
  private lastChatInputEnabled: boolean | null = null;
  private editorKeys: { one?: Phaser.Input.Keyboard.Key; two?: Phaser.Input.Keyboard.Key; three?: Phaser.Input.Keyboard.Key; oKey?: Phaser.Input.Keyboard.Key } = {};
  private editorObjectMode = false;
  private selectedObjectType: string = "desk";
  private editorObjectPreview: Phaser.GameObjects.Sprite | null = null;

  // Minimap
  private minimap: Phaser.Cameras.Scene2D.Camera | null = null;
  private minimapBorder: Phaser.GameObjects.Graphics | null = null;

  // Path following
  private currentPath: { x: number; y: number }[] | null = null;
  private pathIndex: number = 0;
  private targetNpcId: string | null = null;
  private pathLine: Phaser.GameObjects.Graphics | null = null;
  private pathStuckTimer: number = 0;
  private pathLastDist: number = Infinity;

  // Map layers data (for walkability and editor)
  private floorData: number[][] = [];
  private wallsData: number[][] = [];
  private collisionData: number[][] = []; // Tiled Collision layer data
  private effectiveMapCols: number = MAP_COLS;
  private effectiveMapRows: number = MAP_ROWS;
  private currentMapPixelWidth: number = MAP_COLS * TILE_SIZE;
  private currentMapPixelHeight: number = MAP_ROWS * TILE_SIZE;
  private mapObjects: MapObject[] = [];
  private objectSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private ySortObjectSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private objectOccupiedTiles = new Set<string>();

  // Tilemap references
  private floorLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private wallsLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  // Individual sprites for foreground tile layers (depth >= 10000), for per-tile y-sort
  private foregroundTileSprites: Phaser.GameObjects.Sprite[] = [];

  // Auto-greeting tracking
  private greetedNpcs: Set<string> = new Set();

  // Editor state
  private editorMode = false;
  private selectedTile = 1;
  private selectedLayer = 0; // 0=floor, 1=walls
  private editorToolbar: Phaser.GameObjects.Container | null = null;
  private gridOverlay: Phaser.GameObjects.Graphics | null = null;
  private editorLayerText: Phaser.GameObjects.Text | null = null;
  private editorCursor: Phaser.GameObjects.Graphics | null = null;
  private editorSelectedHighlight: Phaser.GameObjects.Graphics | null = null;

  // Channel
  private channelId: string = "";
  private channelMapData: MapData | null = null;
  private tiledMode: boolean = false; // true when using Tiled JSON map (not legacy tilemap)
  private tiledSpawnCol: number | null = null;
  private tiledSpawnRow: number | null = null;
  private savedPosition: { x: number; y: number } | null = null;

  // Player name label
  private playerNameLabel: Phaser.GameObjects.Text | null = null;

  // Placement mode (NPC hiring)
  private placementMode = false;
  private placementHighlight: Phaser.GameObjects.Rectangle | null = null;
  private isChannelOwner = false;

  // Spawn set mode (channel owner sets spawn point)
  private spawnSetMode = false;
  private spawnHighlight: Phaser.GameObjects.Rectangle | null = null;
  private mapConfigSpawnCol: number | null = null;
  private mapConfigSpawnRow: number | null = null;
  private reportWaitMs = 20000;

  constructor() {
    super({ key: "GameScene" });
  }

  private applyMainCameraBounds(mapWidth: number, mapHeight: number): void {
    this.currentMapPixelWidth = mapWidth;
    this.currentMapPixelHeight = mapHeight;
    this.physics.world.setBounds(0, 0, mapWidth, mapHeight);

    const bounds = getCenteredCameraBounds({
      viewportWidth: this.cameras.main.width,
      viewportHeight: this.cameras.main.height,
      zoom: this.cameras.main.zoom || MAIN_CAMERA_ZOOM,
      mapWidth,
      mapHeight,
    });

    this.cameras.main.setBounds(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  private isWalkable(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileX >= this.effectiveMapCols || tileY < 0 || tileY >= this.effectiveMapRows) return false;
    // Check Collision layer (Tiled maps)
    if (this.collisionData.length > 0) {
      const collisionGid = this.collisionData[tileY]?.[tileX] ?? 0;
      if (collisionGid !== 0) return false;
    }
    // Legacy walls check
    if (this.wallsData.length > 0 && this.collisionData.length === 0) {
      const wallTile = this.wallsData[tileY]?.[tileX] ?? T.EMPTY;
      if (COLLISION_TILES.has(wallTile)) return false;
    }
    // Check object occupied tiles
    if (this.objectOccupiedTiles.has(`${tileX},${tileY}`)) return false;
    return true;
  }

  private createNpcWalkValidator(npcSelf: NpcSprite, targetCol: number, targetRow: number): (tx: number, ty: number) => boolean {
    return (tx: number, ty: number) => {
      if (!this.isWalkable(tx, ty)) return false;
      if (tx === targetCol && ty === targetRow) return true;
      const cx = tx * TILE_SIZE + TILE_SIZE / 2;
      const cy = ty * TILE_SIZE + TILE_SIZE / 2;
      const threshold = TILE_SIZE * 0.8;
      for (const other of this.npcSprites) {
        if (other === npcSelf) continue;
        if (Math.abs(other.pixelX - cx) < threshold && Math.abs(other.pixelY - cy) < threshold) return false;
      }
      for (const remote of this.remotePlayers.values()) {
        if (Math.abs(remote.sprite.x - cx) < threshold && Math.abs(remote.sprite.y - cy) < threshold) return false;
      }
      return true;
    };
  }

  private drawPathLine(path: { x: number; y: number }[]): void {
    if (!this.pathLine) {
      this.pathLine = this.add.graphics();
      this.pathLine.setDepth(20003);
    }
    const g = this.pathLine;
    g.clear();

    g.fillStyle(0xfbbf24, 0.4);
    for (let i = 1; i < path.length; i++) {
      const px = path[i].x * TILE_SIZE + TILE_SIZE / 2;
      const py = path[i].y * TILE_SIZE + TILE_SIZE / 2;
      g.fillCircle(px, py, 3);
    }

    if (path.length >= 2) {
      g.lineStyle(1.5, 0xfbbf24, 0.3);
      g.beginPath();
      g.moveTo(
        path[0].x * TILE_SIZE + TILE_SIZE / 2,
        path[0].y * TILE_SIZE + TILE_SIZE / 2
      );
      for (let i = 1; i < path.length; i++) {
        g.lineTo(
          path[i].x * TILE_SIZE + TILE_SIZE / 2,
          path[i].y * TILE_SIZE + TILE_SIZE / 2
        );
      }
      g.strokePath();
    }

    const last = path[path.length - 1];
    g.fillStyle(0xfbbf24, 0.6);
    g.fillCircle(last.x * TILE_SIZE + TILE_SIZE / 2, last.y * TILE_SIZE + TILE_SIZE / 2, 5);
  }

  private clearPathLine(): void {
    if (this.pathLine) {
      this.pathLine.clear();
    }
  }

  private findNearestWalkableTile(tileX: number, tileY: number): { x: number; y: number } | null {
    for (let radius = 1; radius < Math.max(MAP_COLS, MAP_ROWS); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const nx = tileX + dx;
          const ny = tileY + dy;
          if (this.isWalkable(nx, ny) && !this.isTileOccupied(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  create(): void {
    // Read pending channel data set by game page before scene creation
    let tiledJsonData: Record<string, unknown> | null = null;
    const initialChannelData = pendingChannelData;

    if (initialChannelData) {
      this.channelId = initialChannelData.channelId;

      if (initialChannelData.tiledJson) {
        // Explicit Tiled JSON passed from game page
        tiledJsonData = initialChannelData.tiledJson as Record<string, unknown>;
      } else if (initialChannelData.mapData) {
        // Check if mapData IS Tiled JSON (has tiledversion field)
        const mapData = initialChannelData.mapData as Record<string, unknown>;
        if ("tiledversion" in mapData) {
          tiledJsonData = mapData;
        } else {
          this.channelMapData = detectAndConvertMapData(mapData, MAP_COLS, MAP_ROWS);
        }
      }

      // Store spawn from mapConfig if available
      if (initialChannelData.mapConfig) {
        const config = initialChannelData.mapConfig as Record<string, unknown>;
        if (typeof config.spawnCol === "number") {
          this.tiledSpawnCol = config.spawnCol;
          this.mapConfigSpawnCol = config.spawnCol;
        }
        if (typeof config.spawnRow === "number") {
          this.tiledSpawnRow = config.spawnRow;
          this.mapConfigSpawnRow = config.spawnRow;
        }
      }

      // Restore saved position from last session
      if (initialChannelData.savedPosition) {
        this.savedPosition = initialChannelData.savedPosition;
      }

      if (typeof initialChannelData.reportWaitSeconds === "number") {
        this.reportWaitMs = Math.max(5000, initialChannelData.reportWaitSeconds * 1000);
      }

      setPendingChannelData(null); // consumed
    }

    if (tiledJsonData) {
      // Tiled JSON path — use Phaser's built-in Tiled JSON loader
      this.loadTiledMap(tiledJsonData);
    } else if (this.channelMapData) {
      this.floorData = this.channelMapData.layers.floor;
      this.wallsData = this.channelMapData.layers.walls;
      this.mapObjects = this.channelMapData.objects;

      this.createTilemap();
      this.renderObjects();
    } else {
      const waitingText = this.add
        .text(this.scale.width / 2, this.scale.height / 2, "Loading channel map...", {
          fontSize: "20px",
          color: "#ffffff",
          backgroundColor: "#111827",
          padding: { x: 12, y: 8 },
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(20000);

      const handleChannelDataReady = () => {
        EventBus.off("channel-data-ready", handleChannelDataReady);
        if (waitingText.active) waitingText.destroy();
        this.scene.restart();
      };

      EventBus.on("channel-data-ready", handleChannelDataReady);
      const cleanupChannelDataListener = () => {
        EventBus.off("channel-data-ready", handleChannelDataReady);
        if (waitingText.active) waitingText.destroy();
      };
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanupChannelDataListener);
      this.events.once(Phaser.Scenes.Events.DESTROY, cleanupChannelDataListener);
      return;
    }

    // Input keys
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.interactKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.FORWARD_SLASH, false, false);
      this.tabKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.TAB, false, false);
      this.editorKeys = {
        one: this.input.keyboard.addKey("ONE", false, false),
        two: this.input.keyboard.addKey("TWO", false, false),
        three: this.input.keyboard.addKey("THREE", false, false),
        oKey: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.O, false, false),
      };

      // Disable Phaser key capture when HTML inputs are focused
      // keyboard.enabled alone is not enough — addKey registers captures
      // at the KeyboardManager level which call preventDefault regardless.
      // We must call removeCapture/addCapture to truly release keys.
      const kbd = this.input.keyboard;
      const capturedKeys = [
        Phaser.Input.Keyboard.KeyCodes.FORWARD_SLASH,
        Phaser.Input.Keyboard.KeyCodes.TAB,
        Phaser.Input.Keyboard.KeyCodes.UP,
        Phaser.Input.Keyboard.KeyCodes.DOWN,
        Phaser.Input.Keyboard.KeyCodes.LEFT,
        Phaser.Input.Keyboard.KeyCodes.RIGHT,
        Phaser.Input.Keyboard.KeyCodes.SPACE,
      ];
      // Capture keys immediately on scene init so the browser never intercepts them
      // (e.g. Firefox Quick Find on '/', browser scroll on Space/Arrow keys).
      // addKey() with enableCapture=false only tracks the key without capture,
      // so we must call addCapture explicitly here.
      kbd.addCapture(capturedKeys);
      const shouldReleaseKeyboardCapture = (target: EventTarget | null) => {
        const el = target as HTMLElement | null;
        if (!el) return false;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
      };
      // Editor keys (ONE, TWO, THREE, O) are NOT captured globally —
      // they only work in editor mode which is not active during dialogs
      document.addEventListener("focusin", (e) => {
        if (!kbd) return;
        if (shouldReleaseKeyboardCapture(e.target)) {
          kbd.enabled = false;
          kbd.removeCapture(capturedKeys);
        }
      });
      document.addEventListener("focusout", () => {
        if (!kbd) return;
        kbd.enabled = false;
        this.time.delayedCall(50, () => {
          if (!kbd) return;
          if (shouldReleaseKeyboardCapture(document.activeElement)) {
            return;
          }
          kbd.addCapture(capturedKeys);
          kbd.enabled = true;
        });
      });
    }

    const mapWidth = MAP_COLS * TILE_SIZE;
    const mapHeight = MAP_ROWS * TILE_SIZE;

    this.cameras.main.setZoom(MAIN_CAMERA_ZOOM);
    this.applyMainCameraBounds(mapWidth, mapHeight);
    this.cameras.main.setRoundPixels(true);

    // Minimap
    const minimap = this.cameras.add(
      this.scale.width - MINIMAP_SIZE - MINIMAP_PADDING,
      MINIMAP_TOP,
      MINIMAP_SIZE,
      MINIMAP_SIZE
    );
    minimap.setZoom(MINIMAP_SIZE / Math.max(mapWidth, mapHeight));
    minimap.setBackgroundColor(0x1a1a2e);
    minimap.setBounds(0, 0, mapWidth, mapHeight);
    minimap.setScroll(0, 0);
    this.minimap = minimap;

    // Minimap border — theme-colored stroke
    const borderGfx = this.add.graphics();
    borderGfx.setScrollFactor(0);
    borderGfx.setDepth(9999);
    const bx = this.scale.width - MINIMAP_SIZE - MINIMAP_PADDING;
    const by = MINIMAP_TOP;
    // Outer border (wall color)
    borderGfx.lineStyle(3, 0x4a4a5e, 1);
    borderGfx.strokeRect(bx - 2, by - 2, MINIMAP_SIZE + 4, MINIMAP_SIZE + 4);
    // Inner highlight (floor color, subtle)
    borderGfx.lineStyle(1, 0x6a6a7e, 0.6);
    borderGfx.strokeRect(bx - 0.5, by - 0.5, MINIMAP_SIZE + 1, MINIMAP_SIZE + 1);
    // Corner accents (small squares at corners)
    const cs = 4;
    borderGfx.fillStyle(0x6b4226, 0.8);
    borderGfx.fillRect(bx - 3, by - 3, cs, cs);
    borderGfx.fillRect(bx + MINIMAP_SIZE - 1, by - 3, cs, cs);
    borderGfx.fillRect(bx - 3, by + MINIMAP_SIZE - 1, cs, cs);
    borderGfx.fillRect(bx + MINIMAP_SIZE - 1, by + MINIMAP_SIZE - 1, cs, cs);
    this.minimapBorder = borderGfx;

    this.scale.on("resize", (gameSize: Phaser.Structs.Size) => {
      this.cameras.main.setSize(gameSize.width, gameSize.height);
      this.applyMainCameraBounds(this.currentMapPixelWidth, this.currentMapPixelHeight);
      if (this.minimap) {
        this.minimap.setPosition(
          gameSize.width - MINIMAP_SIZE - MINIMAP_PADDING,
          MINIMAP_TOP
        );
      }
      // Redraw minimap border on resize
      if (this.minimapBorder) {
        this.minimapBorder.clear();
        const rx = gameSize.width - MINIMAP_SIZE - MINIMAP_PADDING;
        const ry = MINIMAP_TOP;
        this.minimapBorder.lineStyle(3, 0x4a4a5e, 1);
        this.minimapBorder.strokeRect(rx - 2, ry - 2, MINIMAP_SIZE + 4, MINIMAP_SIZE + 4);
        this.minimapBorder.lineStyle(1, 0x6a6a7e, 0.6);
        this.minimapBorder.strokeRect(rx - 0.5, ry - 0.5, MINIMAP_SIZE + 1, MINIMAP_SIZE + 1);
        this.minimapBorder.fillStyle(0x6b4226, 0.8);
        this.minimapBorder.fillRect(rx - 3, ry - 3, cs, cs);
        this.minimapBorder.fillRect(rx + MINIMAP_SIZE - 1, ry - 3, cs, cs);
        this.minimapBorder.fillRect(rx - 3, ry + MINIMAP_SIZE - 1, cs, cs);
        this.minimapBorder.fillRect(rx + MINIMAP_SIZE - 1, ry + MINIMAP_SIZE - 1, cs, cs);
      }
    });

    // Dialog events
    EventBus.on("dialog:open", () => {
      this.dialogOpen = true;
    });
    EventBus.on("dialog:close", () => {
      this.dialogOpen = false;
    });

    // Placement mode events
    EventBus.on("placement-mode-start", () => { this.placementMode = true; });
    EventBus.on("placement-mode-end", () => {
      this.placementMode = false;
      this.placementHighlight?.destroy();
      this.placementHighlight = null;
    });

    // Spawn set mode events
    EventBus.on("spawn-set-mode-start", () => { this.spawnSetMode = true; });
    EventBus.on("spawn-set-mode-end", () => {
      this.spawnSetMode = false;
      this.spawnHighlight?.destroy();
      this.spawnHighlight = null;
    });
    EventBus.on("task-automation-updated", (data: { reportWaitSeconds?: number }) => {
      if (typeof data.reportWaitSeconds === "number") {
        this.reportWaitMs = Math.max(5000, data.reportWaitSeconds * 1000);
      }
    });
    EventBus.on("owner-status", (data: { isOwner: boolean }) => { this.isChannelOwner = data.isOwner; });

    // Local NPC spawn/remove (from own hire/fire actions)
    EventBus.on("npc:spawn-local", (raw: { id: string; name: string; positionX: number; positionY: number; direction?: string; appearance?: unknown }) => {
      const npcData: NpcData = { ...raw, direction: raw.direction || "down" };
      if (this.npcSprites.some(n => n.id === npcData.id)) return;
      const npc = new NpcSprite(this, npcData);
      this.npcSprites.push(npc);
      this.npcTilePositions.add(`${npcData.positionX},${npcData.positionY}`);
    });
    EventBus.on("npc:remove-local", (data: { npcId: string }) => {
      this.removeNpcById(data.npcId);
    });
    EventBus.on("npc:update-local", (data: { npcId: string; name?: string; direction?: string; appearance?: unknown }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc) return;
      npc.updateFromData(data);
    });

    EventBus.on("npc:start-move", (data: { npcId: string; targetCol: number; targetRow: number; message?: string }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc || npc.moveState !== "idle") return;
      this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
      npc.moveTo(
        data.targetCol,
        data.targetRow,
        findPath,
        (tx: number, ty: number) => this.isWalkable(tx, ty) && !this.isTileOccupied(tx, ty),
        data.message ? { message: data.message } : undefined,
      );
    });

    EventBus.on("npc:call-to-player", (data: {
      npcId: string;
      message?: string;
      reportId?: string;
      reportKind?: string;
      bubbleText?: string;
      npcName?: string;
    }) => {
      if (!this.player) return;
      const playerCol = Math.floor(this.player.x / TILE_SIZE);
      const playerRow = Math.floor(this.player.y / TILE_SIZE);
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc || npc.moveState !== "idle") return;

      const dist = npc.distanceTo(this.player.x, this.player.y);
      if (dist < TILE_SIZE + 4) {
        npc.pendingMessage = data.message || null;
        npc.pendingReportId = data.reportId || null;
        npc.pendingReportKind = data.reportKind || null;
        npc.arrivalBubbleText = data.bubbleText || null;
        npc.waitDurationMs = data.reportKind === "complete" ? this.reportWaitMs : 10000;
        npc.moveState = "waiting";
        npc.waitTimer = 0;
        EventBus.emit("npc:bubble", { npcId: npc.id, text: npc.arrivalBubbleText || undefined });
        EventBus.emit("toast:show", {
          message: `Press / to talk to ${data.npcName || npc.name}`,
        });
        EventBus.emit("npc:movement-arrived", {
          npcId: npc.id,
          npcName: data.npcName || npc.name,
          pendingMessage: npc.pendingMessage,
          reportId: npc.pendingReportId,
          reportKind: npc.pendingReportKind,
        });
        return;
      }

      this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
      npc.moveTo(
        playerCol,
        playerRow,
        findPath,
        this.createNpcWalkValidator(npc, playerCol, playerRow),
        {
          message: data.message,
          reportId: data.reportId,
          reportKind: data.reportKind,
          bubbleText: data.bubbleText,
          waitDurationMs: data.reportKind === "complete" ? this.reportWaitMs : 10000,
        },
      );
    });

    // NPC finished responding — if far from player, walk to deliver the response
    EventBus.on("npc:deliver-response", (data: { npcId: string; npcName: string }) => {
      if (!this.player) return;
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc) return;

      const dist = npc.distanceTo(this.player.x, this.player.y);
      if (dist < TILE_SIZE + 4) {
        // Already close — just show bubble
        EventBus.emit("npc:bubble", { npcId: npc.id });
        return;
      }

      // NPC is far — walk to player (only if idle)
      if (npc.moveState !== "idle") return;
      this.npcTilePositions.delete(`${npc.homeCol},${npc.homeRow}`);
      const playerCol = Math.floor(this.player.x / TILE_SIZE);
      const playerRow = Math.floor(this.player.y / TILE_SIZE);
      npc.moveTo(
        playerCol,
        playerRow,
        findPath,
        this.createNpcWalkValidator(npc, playerCol, playerRow),
        {
          message: `${data.npcName}이(가) 대화를 원합니다`,
        },
      );
    });

    EventBus.on("npc:start-return", (data: { npcId: string }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc || npc.moveState !== "waiting") return;
      npc.returnToHome(
        findPath,
        (tx: number, ty: number) => this.isWalkable(tx, ty) && !this.isTileOccupied(tx, ty),
      );
    });

    EventBus.on("npc:approach-and-interact", (data: { npcId: string; npcName?: string }) => {
      this.approachNpcAndInteract(data.npcId, data.npcName);
    });

    // ESC key handler
    this.input.keyboard?.on("keydown-ESC", () => {
      if (this.placementMode) { EventBus.emit("placement-cancel"); }
      if (this.spawnSetMode) { EventBus.emit("spawn-set-cancel"); }
    });

    // Disable browser context menu so right-click is available for game use
    this.input.mouse?.disableContextMenu();

    // NPC hover highlight
    let lastHoveredNpc: NpcSprite | null = null;
    let lastHoveredRemote: RemotePlayer | null = null;
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      // Update editor cursor position
      if (this.editorMode && this.editorCursor) {
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const tileX = Math.floor(worldPoint.x / TILE_SIZE);
        const tileY = Math.floor(worldPoint.y / TILE_SIZE);
        this.editorCursor.clear();
        if (tileX >= 0 && tileX < MAP_COLS && tileY >= 0 && tileY < MAP_ROWS) {
          this.editorCursor.lineStyle(2, 0x00ff00, 0.8);
          this.editorCursor.strokeRect(tileX * TILE_SIZE, tileY * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }

        // Object mode hover preview
        if (this.editorObjectMode) {
          if (tileX >= 0 && tileX < MAP_COLS && tileY >= 0 && tileY < MAP_ROWS) {
            const def = OBJECT_TYPES[this.selectedObjectType];
            if (def) {
              const texKey = `obj-${this.selectedObjectType}`;
              if (!this.editorObjectPreview) {
                this.editorObjectPreview = this.add.sprite(0, 0, texKey);
                this.editorObjectPreview.setOrigin(0.5, 1);
                this.editorObjectPreview.setAlpha(0.5);
                this.editorObjectPreview.setDepth(20020);
              } else if (this.editorObjectPreview.texture.key !== texKey) {
                this.editorObjectPreview.setTexture(texKey);
              }

              const w = def.width || 1;
              const h = def.height || 1;
              const x = (tileX + w / 2) * TILE_SIZE;
              const y = (tileY + h) * TILE_SIZE;
              this.editorObjectPreview.setPosition(x, y);
              this.editorObjectPreview.setVisible(true);

              const valid = canPlaceObject(this.selectedObjectType, tileX, tileY, this.mapObjects, this.wallsData);
              this.editorObjectPreview.setTint(valid ? 0x44ff44 : 0xff4444);
            }
          } else {
            // Out of bounds — hide preview
            if (this.editorObjectPreview) {
              this.editorObjectPreview.setVisible(false);
            }
          }
        } else {
          // Not in object mode — hide preview if it exists
          if (this.editorObjectPreview) {
            this.editorObjectPreview.setVisible(false);
          }
        }
      }

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);

      // Check NPC hover — use 1.5× tile radius because NPC sprite origin (0.5, 0.85)
      // places the visual top ~40 px above pixelY, so TILE_SIZE alone misses head clicks
      let hoveredNpc: NpcSprite | null = null;
      for (const npc of this.npcSprites) {
        if (npc.distanceTo(worldPoint.x, worldPoint.y) < TILE_SIZE * 1.5) {
          hoveredNpc = npc;
          break;
        }
      }
      if (hoveredNpc !== lastHoveredNpc) {
        if (lastHoveredNpc) lastHoveredNpc.setHighlight(false);
        if (hoveredNpc) hoveredNpc.setHighlight(true);
        lastHoveredNpc = hoveredNpc;
      }

      // Check remote player hover
      let hoveredRemote: RemotePlayer | null = null;
      for (const remote of this.remotePlayers.values()) {
        if (remote.distanceTo(worldPoint.x, worldPoint.y) < TILE_SIZE) {
          hoveredRemote = remote;
          break;
        }
      }
      if (hoveredRemote !== lastHoveredRemote) {
        if (lastHoveredRemote) lastHoveredRemote.setHighlight(false);
        if (hoveredRemote) hoveredRemote.setHighlight(true);
        lastHoveredRemote = hoveredRemote;
      }

      if (this.game.canvas) {
        this.game.canvas.style.cursor = (hoveredNpc || hoveredRemote) ? "pointer" : "default";
      }
    });

    // Mouse click handler
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Placement mode: place NPC on clicked tile
      if (this.placementMode) {
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const col = Math.floor(worldPoint.x / TILE_SIZE);
        const row = Math.floor(worldPoint.y / TILE_SIZE);
        if (this.isWalkable(col, row) && !this.isTileOccupied(col, row)) {
          EventBus.emit("placement-complete", { col, row });
        }
        return;
      }

      // Spawn set mode: set spawn point on clicked tile
      if (this.spawnSetMode) {
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const col = Math.floor(worldPoint.x / TILE_SIZE);
        const row = Math.floor(worldPoint.y / TILE_SIZE);
        if (this.isWalkable(col, row)) {
          EventBus.emit("spawn:selected", { col, row });
        }
        return;
      }

      // Editor mode: place/erase tiles or objects
      if (this.editorMode) {
        if (this.editorObjectMode) {
          const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
          const tileX = Math.floor(worldPoint.x / TILE_SIZE);
          const tileY = Math.floor(worldPoint.y / TILE_SIZE);

          if (pointer.rightButtonDown()) {
            // Right-click: delete object at tile
            const objIndex = this.mapObjects.findIndex((obj) => {
              const def = OBJECT_TYPES[obj.type];
              const w = def?.width || 1;
              const h = def?.height || 1;
              return tileX >= obj.col && tileX < obj.col + w && tileY >= obj.row && tileY < obj.row + h;
            });
            if (objIndex >= 0) {
              const removed = this.mapObjects.splice(objIndex, 1)[0];
              this.renderObjects();
              this.socket?.emit("map:object-remove", { objectId: removed.id });
            }
          } else {
            // Left-click: place object
            if (canPlaceObject(this.selectedObjectType, tileX, tileY, this.mapObjects, this.wallsData)) {
              const obj: MapObject = {
                id: generateObjectId(),
                type: this.selectedObjectType,
                col: tileX,
                row: tileY,
              };
              this.mapObjects.push(obj);
              this.renderObjects();
              this.socket?.emit("map:object-add", { object: obj });
            }
          }
          return;
        }
        this.handleEditorClick(pointer);
        return;
      }

      if (!this.player || !this.playerReady) return;

      // Right-click on NPC: context menu
      if (pointer.rightButtonDown()) {
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        for (const npc of this.npcSprites) {
          if (npc.distanceTo(worldPoint.x, worldPoint.y) < TILE_SIZE * 1.5) {
            EventBus.emit("npc:context-menu", {
              npcId: npc.id,
              npcName: npc.name,
              screenX: pointer.x,
              screenY: pointer.y,
              moveState: npc.moveState,
            });
            return;
          }
        }
        return;
      }

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const worldX = worldPoint.x;
      const worldY = worldPoint.y;

      const targetTileX = Math.floor(worldX / TILE_SIZE);
      const targetTileY = Math.floor(worldY / TILE_SIZE);

      let clickedNpc: NpcSprite | null = null;
      for (const npc of this.npcSprites) {
        if (npc.distanceTo(worldX, worldY) < TILE_SIZE * 1.5) {
          clickedNpc = npc;
          break;
        }
      }

      const startTileX = Math.floor(this.player.x / TILE_SIZE);
      const startTileY = Math.floor(this.player.y / TILE_SIZE);

      let destTileX = targetTileX;
      let destTileY = targetTileY;

      if (clickedNpc) {
        destTileX = Math.floor(clickedNpc.pixelX / TILE_SIZE);
        destTileY = Math.floor(clickedNpc.pixelY / TILE_SIZE);
        const neighbors = [
          [destTileX, destTileY + 1],
          [destTileX, destTileY - 1],
          [destTileX - 1, destTileY],
          [destTileX + 1, destTileY],
        ];
        const walkable = neighbors.find(([x, y]) => this.isWalkable(x, y) && !this.isTileOccupied(x, y));
        if (walkable) {
          destTileX = walkable[0];
          destTileY = walkable[1];
        }
        this.targetNpcId = clickedNpc.id;
      } else {
        this.targetNpcId = null;
      }

      if (!this.isWalkable(destTileX, destTileY) || this.isTileOccupied(destTileX, destTileY)) {
        const nearest = this.findNearestWalkableTile(destTileX, destTileY);
        if (!nearest) return;
        destTileX = nearest.x;
        destTileY = nearest.y;
      }

      const path = findPath(startTileX, startTileY, destTileX, destTileY,
        (tx, ty) => this.isWalkable(tx, ty) && !this.isTileOccupied(tx, ty));

      if (path && path.length > 1) {
        this.currentPath = path;
        this.pathIndex = 1;
        this.pathStuckTimer = 0;
        this.pathLastDist = Infinity;
        this.drawPathLine(path);
      }
    });

    // Pre-fetch NPC positions before allowing player spawn, then load sprites
    this.prefetchNpcPositions().then((npcs) => {
      this.loadNpcs(npcs);
    });

    // Listen for spritesheet texture from React (only process once)
    let playerTextureLoaded = false;
    EventBus.on("spritesheet-ready", (dataUrl: string) => {
      if (playerTextureLoaded) return;
      playerTextureLoaded = true;
      this.loadPlayerTexture(dataUrl);
    });

    // Listen for socket from React — may arrive before or after player spawn
    const handleSocketReady = (data: {
      socket: Socket;
      characterId: string;
      characterName: string;
      appearance: unknown;
    }) => {
      this.socket = data.socket;
      this.characterId = data.characterId;
      this.characterName = data.characterName;
      this.appearance = data.appearance;
      this.setupSocketListeners();

      if (this.playerReady && this.player) {
        this.joinMultiplayer(this.player.x, this.player.y);
      }
    };
    EventBus.on("socket-ready", handleSocketReady);

    // Speech bubble listeners
    EventBus.on("chat:bubble", (data: { senderId: string }) => {
      this.showPlayerBubble(data.senderId);
    });
    EventBus.on("npc:bubble", (data: { npcId: string; text?: string }) => {
      this.showNpcBubbleIcon(data.npcId, data.text);
    });
    EventBus.on("npc:bubble-clear", (data: { npcId: string }) => {
      this.clearNpcBubble(data.npcId);
    });

    // Respond to position requests from React (for save-on-leave)
    EventBus.on("request-player-position", () => {
      if (this.player) {
        EventBus.emit("player-position-response", { x: this.player.x, y: this.player.y });
      }
    });

    // Tell React the scene is ready
    EventBus.emit("scene-ready");

    // Clean up GameScene's own EventBus listeners when this scene is destroyed.
    // This prevents stale listeners from accumulating across game recreations
    // (e.g. React Strict Mode double-invocation).
    this.events.once("destroy", () => {
      const gameSceneEvents = [
        "dialog:open", "dialog:close",
        "placement-mode-start", "placement-mode-end",
        "spawn-set-mode-start", "spawn-set-mode-end",
        "task-automation-updated",
        "owner-status",
        "npc:spawn-local", "npc:remove-local", "npc:update-local",
        "npc:start-move", "npc:call-to-player",
        "npc:deliver-response", "npc:start-return", "npc:approach-and-interact",
        "spritesheet-ready", "socket-ready",
        "chat:bubble", "npc:bubble", "npc:bubble-clear",
        "request-player-position",
      ];
      for (const ev of gameSceneEvents) {
        EventBus.removeAllListeners(ev);
      }
    });

    // Also re-request socket in case it was already sent before we registered
    EventBus.emit("request-socket");
  }

  // ---------------------------------------------------------------------------
  // Tiled JSON map loading
  // ---------------------------------------------------------------------------

  private loadTiledMap(tiledJson: Record<string, unknown>): void {
    this.tiledMode = true;
    // Resolve external tileset references — Phaser doesn't support them
    const tilesetArr = tiledJson.tilesets as Array<Record<string, unknown>>;
    if (tilesetArr) {
      for (let i = 0; i < tilesetArr.length; i++) {
        if (tilesetArr[i].source && !tilesetArr[i].image) {
          // Replace external reference with embedded DeskRPG default tileset
          const firstgid = tilesetArr[i].firstgid || 1;
          tilesetArr[i] = {
            firstgid,
            name: "deskrpg-tileset",
            tilewidth: 32,
            tileheight: 32,
            tilecount: 16,
            columns: 16,
            image: "deskrpg-tileset.png",
            imagewidth: 512,
            imageheight: 32,
          };
        }
      }
    }

    // Destroy existing layers if any
    if (this.floorLayer) { this.floorLayer.destroy(); this.floorLayer = null; }
    if (this.wallsLayer) { this.wallsLayer.destroy(); this.wallsLayer = null; }
    for (const s of this.foregroundTileSprites) s.destroy();
    this.foregroundTileSprites = [];

    // Add Tiled JSON to Phaser's tilemap cache
    this.cache.tilemap.add("channel-map", {
      format: Phaser.Tilemaps.Formats.TILED_JSON,
      data: tiledJson,
    });

    // Load custom tileset images before creating the tilemap
    const tilesetDefs = (tiledJson.tilesets as Array<{
      firstgid: number;
      source?: string;
      name?: string;
      image?: string;
      tilewidth?: number;
      tileheight?: number;
    }>) || [];

    const imagesToLoad: { key: string; url: string; tileWidth: number; tileHeight: number }[] = [];
    for (const ts of tilesetDefs) {
      const tsName = ts.name || ts.source?.replace(/\.tsx$/, "") || "deskrpg-tileset";
      const tsImage = ts.image || "";
      const tileW = ts.tilewidth || TILE_SIZE;
      const tileH = ts.tileheight || TILE_SIZE;

      // Skip if texture already loaded (e.g. "office-tiles" from BootScene)
      if (this.textures.exists(tsName)) continue;

      // Determine image URL
      if (tsImage.startsWith("data:")) {
        // Base64 data URL — load directly
        imagesToLoad.push({ key: tsName, url: tsImage, tileWidth: tileW, tileHeight: tileH });
      } else if (tsImage.startsWith("/")) {
        // Absolute path (e.g. /assets/uploads/{id}/tileset.png)
        imagesToLoad.push({ key: tsName, url: tsImage, tileWidth: tileW, tileHeight: tileH });
      } else if (tsImage && tsImage !== "deskrpg-tileset.png") {
        // Relative path — try common locations
        imagesToLoad.push({ key: tsName, url: `/assets/uploads/${tsImage}`, tileWidth: tileW, tileHeight: tileH });
      }
    }

    if (imagesToLoad.length > 0) {
      // Dynamically load tileset images, then continue
      for (const img of imagesToLoad) {
        this.load.image(img.key, img.url);
      }
      this.load.once("complete", () => {
        this.finishTiledMapLoad(tiledJson, imagesToLoad);
      });
      this.load.once("loaderror", (file: { key: string; url: string }) => {
        console.error("[GameScene] Failed to load tileset image:", file.key, file.url);
      });
      this.load.start();
      return;
    }

    // No custom images to load — proceed immediately
    this.finishTiledMapLoad(tiledJson, []);
  }

  private finishTiledMapLoad(tiledJson: Record<string, unknown>, loadedImages: { key: string; tileWidth: number; tileHeight: number }[]): void {
    const map = this.make.tilemap({ key: "channel-map" });

    // Add tilesets to the map
    const tilesetDefs = (tiledJson.tilesets as Array<{
      firstgid: number;
      source?: string;
      name?: string;
      image?: string;
      tilewidth?: number;
      tileheight?: number;
    }>) || [];

    for (const ts of tilesetDefs) {
      const tsName = ts.name || ts.source?.replace(/\.tsx$/, "") || "deskrpg-tileset";
      const tileW = ts.tilewidth || TILE_SIZE;
      const tileH = ts.tileheight || TILE_SIZE;

      if (this.textures.exists(tsName)) {
        // Custom loaded texture or BootScene texture
        map.addTilesetImage(tsName, tsName, tileW, tileH, 0, 0);
      } else if (this.textures.exists("office-tiles") && (tsName === "deskrpg-tileset" || (ts.image || "").includes("deskrpg"))) {
        // DeskRPG default tileset → use office-tiles
        map.addTilesetImage(tsName, "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
      } else if (this.textures.exists("office-tiles")) {
        // Unknown tileset but office-tiles available — use as fallback
        console.warn(`[GameScene] Unknown tileset "${tsName}", using office-tiles fallback`);
        map.addTilesetImage(tsName, "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
      }
    }

    // Ensure each tileset's texture has per-tile frame entries so foreground
    // tile sprites can reference individual frames via (texKey, localFrameIndex).
    for (const ts of tilesetDefs) {
      const tsName = ts.name || ts.source?.replace(/\.tsx$/, "") || "deskrpg-tileset";
      const phaserTs = map.getTileset(tsName);
      if (!phaserTs || !phaserTs.image) continue;
      const texture = phaserTs.image as Phaser.Textures.Texture;
      const cols = phaserTs.columns || 1;
      const total = phaserTs.total || 1;
      const tw = phaserTs.tileWidth;
      const th = phaserTs.tileHeight;
      for (let fi = 0; fi < total; fi++) {
        if (!texture.has(String(fi))) {
          const col = fi % cols;
          const row = Math.floor(fi / cols);
          texture.add(String(fi), 0, col * tw, row * th, tw, th);
        }
      }
    }

    // Create tile layers — try by name first, fallback to order
    const mapWidth = (tiledJson.width as number) || MAP_COLS;
    const mapHeight = (tiledJson.height as number) || MAP_ROWS;

    // Set effective map dimensions for isWalkable bounds check
    this.effectiveMapCols = mapWidth;
    this.effectiveMapRows = mapHeight;

    // Update physics/camera bounds to actual Tiled map size
    const tiledPixelW = mapWidth * TILE_SIZE;
    const tiledPixelH = mapHeight * TILE_SIZE;
    this.applyMainCameraBounds(tiledPixelW, tiledPixelH);
    // Extract collision layer data for walkability checks
    this.collisionData = [];
    const tiledLayersRaw = (tiledJson.layers as Array<{ name: string; type: string; data?: number[]; width?: number }>) || [];
    const collisionLayerData = tiledLayersRaw.find(l => l.type === 'tilelayer' && l.name.toLowerCase() === 'collision');
    if (collisionLayerData?.data) {
      const w = collisionLayerData.width || mapWidth;
      for (let r = 0; r < mapHeight; r++) {
        this.collisionData.push(collisionLayerData.data.slice(r * w, (r + 1) * w));
      }
    }

    // Get all tile layer names from the Tiled JSON
    const tiledLayers = (tiledJson.layers as Array<{ name: string; type: string }>) || [];
    const tileLayerNames = tiledLayers.filter(l => l.type === "tilelayer").map(l => l.name);

    // Try named layers first, fallback to first/second tile layer by order
    const floorLayerName = tileLayerNames.find(n => n.toLowerCase() === "floor") || tileLayerNames[0];
    const wallsLayerName = tileLayerNames.find(n => n.toLowerCase() === "walls") || tileLayerNames[1];

    let floorLayer: Phaser.Tilemaps.TilemapLayer | null = null;
    if (floorLayerName) {
      floorLayer = map.createLayer(floorLayerName, map.tilesets);
      if (floorLayer) {
        floorLayer.setDepth(0);
        this.floorLayer = floorLayer;
      }
    }

    let wallsLayer: Phaser.Tilemaps.TilemapLayer | null = null;
    if (wallsLayerName && wallsLayerName !== floorLayerName) {
      wallsLayer = map.createLayer(wallsLayerName, map.tilesets);
      if (wallsLayer) {
        wallsLayer.setDepth(1);
        this.wallsLayer = wallsLayer;
        // Walls layer is decorative only — collision is handled by the Collision layer
      }
    }

    // Create any remaining tile layers (3rd, 4th, etc.)
    // Depth rules (matching map editor CHARACTER_DEPTH_THRESHOLD = 10000):
    //   "collision"   → semi-transparent debug overlay (depth 9999)
    //   depth >= 10000 (by name or "depth" property) → per-tile sprites for y-sort
    //   depth <  10000 → static TilemapLayer at assigned depth
    const allRawLayers = (tiledJson.layers as Array<Record<string, unknown>>) || [];

    /** Read the numeric `depth` property from a Tiled layer's properties array. */
    const getLayerDepthProp = (layerName: string, fallback: number): number => {
      const raw = allRawLayers.find(l => l.name === layerName);
      if (!raw) return fallback;
      const props = raw.properties as Array<{ name: string; type: string; value: unknown }> | undefined;
      if (!props) return fallback;
      const dp = props.find(p => p.name === 'depth');
      if (!dp) return fallback;
      if (dp.type === 'int' || dp.type === 'float') return Number(dp.value) || fallback;
      if (dp.type === 'string' && dp.value === 'y-sort') return 5000;
      return fallback;
    };

    for (let i = 0; i < tileLayerNames.length; i++) {
      const name = tileLayerNames[i];
      if (name === floorLayerName || name === wallsLayerName) continue;
      const nameLower = name.toLowerCase();

      // Determine target depth
      let layerDepth: number;
      if (nameLower === "collision") {
        layerDepth = 9999;
      } else if (nameLower === "foreground" || nameLower === "above" || nameLower === "overlay") {
        layerDepth = getLayerDepthProp(name, 10000);
      } else {
        layerDepth = getLayerDepthProp(name, i + 2);
      }

      if (layerDepth >= 10000) {
        // Foreground layer: convert to individual sprites so every tile gets
        // its own depth (10000 + tile bottom pixel) — enabling per-tile y-sort
        // that matches the map editor's charAboveRow split-render logic.
        const tempLayer = map.createLayer(name, map.tilesets);
        if (tempLayer) {
          const layerAlpha = (allRawLayers.find(l => l.name === name)?.opacity as number) ?? 1;
          tempLayer.forEachTile((tile: Phaser.Tilemaps.Tile) => {
            if (tile.index < 0) return;
            const tileset = tile.tileset;
            if (!tileset || !tileset.image) return;
            const texKey = (tileset.image as Phaser.Textures.Texture).key;
            const localFrame = String(tile.index - tileset.firstgid);
            const px = tile.pixelX + tile.width / 2;
            const py = tile.pixelY + tile.height / 2;
            const sprite = this.add.sprite(px, py, texKey, localFrame);
            sprite.setOrigin(0.5, 0.5);
            sprite.setAlpha(layerAlpha);
            if (tile.flipX) sprite.setFlipX(true);
            if (tile.flipY) sprite.setFlipY(true);
            // Depth = layerDepth base + bottom edge of tile row → y-sort with player
            sprite.setDepth(layerDepth + tile.pixelY + tile.height);
            this.foregroundTileSprites.push(sprite);
          });
          tempLayer.destroy();
        }
      } else {
        // Background layer: static TilemapLayer
        const extraLayer = map.createLayer(name, map.tilesets);
        if (extraLayer) {
          if (nameLower === "collision") {
            extraLayer.setAlpha(0.7);
            extraLayer.setDepth(9999);
          } else {
            extraLayer.setDepth(layerDepth);
          }
        }
      }
    }

    // Extract floor/walls data arrays for the legacy collision system
    // (isWalkable() checks floorData/wallsData directly)
    this.floorData = [];
    this.wallsData = [];
    for (let r = 0; r < mapHeight; r++) {
      const floorRow = new Array(mapWidth).fill(0);
      const wallsRow = new Array(mapWidth).fill(0);
      for (let c = 0; c < mapWidth; c++) {
        if (floorLayer) {
          const tile = floorLayer.getTileAt(c, r);
          floorRow[c] = tile ? tile.index : 0;
        }
        if (wallsLayer) {
          const tile = wallsLayer.getTileAt(c, r);
          wallsRow[c] = tile ? tile.index : 0;
        }
      }
      this.floorData.push(floorRow);
      this.wallsData.push(wallsRow);
    }

    // Process object layers + Collision layer
    this.mapObjects = [];
    const collisionCells = new Set<string>();
    const allLayers = tiledJson.layers as Array<Record<string, unknown>> | undefined;
    for (const layer of allLayers || []) {
      const layerName = ((layer.name as string) || "").toLowerCase();

      // --- Collision layer (objectgroup): all objects become collision rects ---
      if (layer.type === "objectgroup" && layerName === "collision") {
        const objects = layer.objects as Array<Record<string, unknown>> | undefined;
        for (const obj of objects || []) {
          const ox = (obj.x as number) || 0;
          const oy = (obj.y as number) || 0;
          const ow = (obj.width as number) || TILE_SIZE;
          const oh = (obj.height as number) || TILE_SIZE;
          // Convert pixel rect to tile cells
          const startCol = Math.floor(ox / TILE_SIZE);
          const startRow = Math.floor(oy / TILE_SIZE);
          const endCol = Math.ceil((ox + ow) / TILE_SIZE);
          const endRow = Math.ceil((oy + oh) / TILE_SIZE);
          for (let r = startRow; r < endRow; r++) {
            for (let c = startCol; c < endCol; c++) {
              collisionCells.add(`${c},${r}`);
            }
          }
        }
        continue; // Don't process collision layer as regular objects
      }

      // --- Collision layer (tilelayer): any non-zero tile is collision ---
      if (layer.type === "tilelayer" && layerName === "collision") {
        const data = layer.data as number[] | undefined;
        if (data) {
          for (let r = 0; r < mapHeight; r++) {
            for (let c = 0; c < mapWidth; c++) {
              const gid = data[r * mapWidth + c] || 0;
              if (gid !== 0) {
                collisionCells.add(`${c},${r}`);
              }
            }
          }
        }
        // Show collision tile layer with transparency
        const collisionTileLayer = map.getLayer(layer.name as string);
        if (collisionTileLayer?.tilemapLayer) {
          collisionTileLayer.tilemapLayer.setAlpha(0.7);
          collisionTileLayer.tilemapLayer.setDepth(9999);
        }
        continue;
      }

      // --- Regular object layers ---
      if (layer.type === "objectgroup") {
        const objects = layer.objects as Array<Record<string, unknown>> | undefined;
        for (const obj of objects || []) {
          // Spawn point — use Objects layer as fallback only if mapConfig hasn't set one
          if (obj.name === "spawn" || obj.type === "spawn") {
            if (this.mapConfigSpawnCol === null) {
              this.tiledSpawnCol = Math.floor((obj.x as number) / TILE_SIZE);
            }
            if (this.mapConfigSpawnRow === null) {
              this.tiledSpawnRow = Math.floor((obj.y as number) / TILE_SIZE);
            }
            continue;
          }

          // Furniture/object — only add if type is recognized
          const objectType = (obj.type as string) || "";
          if (objectType && OBJECT_TYPES[objectType]) {
            this.mapObjects.push({
              id: generateObjectId(),
              type: objectType,
              col: Math.floor((obj.x as number) / TILE_SIZE),
              row: Math.floor((obj.y as number) / TILE_SIZE),
            });
          }
        }
      }
    }

    this.renderObjects();
    this.objectOccupiedTiles = computeOccupiedTiles(this.mapObjects);
    // Merge collision layer cells into objectOccupiedTiles
    for (const cell of collisionCells) {
      this.objectOccupiedTiles.add(cell);
    }
  }

  // ---------------------------------------------------------------------------
  // Tilemap creation
  // ---------------------------------------------------------------------------

  private createTilemap(): void {
    // Destroy existing layers if any
    if (this.floorLayer) { this.floorLayer.destroy(); this.floorLayer = null; }
    if (this.wallsLayer) { this.wallsLayer.destroy(); this.wallsLayer = null; }

    // Floor layer
    const floorMap = this.make.tilemap({
      data: this.floorData,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
    const floorTileset = floorMap.addTilesetImage("office-tiles", "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
    if (floorTileset) {
      this.floorLayer = floorMap.createLayer(0, floorTileset, 0, 0);
      if (this.floorLayer) {
        this.floorLayer.setDepth(0);
      }
    }

    // Walls layer
    const wallsMap = this.make.tilemap({
      data: this.wallsData,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
    const wallsTileset = wallsMap.addTilesetImage("office-tiles", "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
    if (wallsTileset) {
      this.wallsLayer = wallsMap.createLayer(0, wallsTileset, 0, 0);
      if (this.wallsLayer) {
        this.wallsLayer.setDepth(1);
      }
    }
  }

  private renderObjects(): void {
    // Destroy existing sprites
    for (const sprite of this.objectSprites.values()) {
      sprite.destroy();
    }
    this.objectSprites.clear();
    this.ySortObjectSprites.clear();

    for (const obj of this.mapObjects) {
      const def = OBJECT_TYPES[obj.type];
      if (!def) continue;
      const dir = obj.direction || "down";
      let texKey = `obj-${obj.type}-${dir}`;
      if (!this.textures.exists(texKey)) {
        texKey = `obj-${obj.type}`; // fallback
      }
      if (!this.textures.exists(texKey)) continue;

      const { width: w, height: h } = getObjectDimensions(obj.type, obj.direction);
      const x = (obj.col + w / 2) * TILE_SIZE;
      const y = (obj.row + h) * TILE_SIZE;

      const sprite = this.add.sprite(x, y, texKey);
      sprite.setOrigin(0.5, 1);

      if (def.depthMode === "fixed") {
        sprite.setDepth(def.fixedDepth ?? 5);
      } else {
        this.ySortObjectSprites.set(obj.id, sprite);
      }

      this.objectSprites.set(obj.id, sprite);
    }

    this.objectOccupiedTiles = computeOccupiedTiles(this.mapObjects);
  }

  // ---------------------------------------------------------------------------
  // Map Editor
  // ---------------------------------------------------------------------------

  private toggleEditor(): void {
    this.editorMode = !this.editorMode;

    if (this.editorMode) {
      this.showEditor();
    } else {
      this.hideEditor();
    }
  }

  private showEditor(): void {
    const cam = this.cameras.main;

    // Grid overlay
    if (!this.gridOverlay) {
      this.gridOverlay = this.add.graphics();
      this.gridOverlay.setDepth(20020);
    }
    this.drawGrid();

    // Editor cursor (follows mouse)
    if (!this.editorCursor) {
      this.editorCursor = this.add.graphics();
      this.editorCursor.setDepth(20020);
    }

    // Toolbar container (fixed to camera via scrollFactor)
    if (!this.editorToolbar) {
      this.editorToolbar = this.add.container(0, 0);
      this.editorToolbar.setDepth(20020);
      this.editorToolbar.setScrollFactor(0);

      this.buildToolbar();
    }
    this.editorToolbar.setVisible(true);

    // Layer indicator
    if (!this.editorLayerText) {
      this.editorLayerText = this.add.text(10, 10, "", {
        fontSize: "12px",
        color: "#00ff00",
        stroke: "#000000",
        strokeThickness: 3,
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 4 },
      });
      this.editorLayerText.setDepth(20020);
      this.editorLayerText.setScrollFactor(0);
    }
    this.updateLayerText();
    this.editorLayerText.setVisible(true);

    // Status text
    const statusText = this.add.text(10, 35, "Editor Mode | LMB: place | RMB: erase | 1/2/3: layer | Tab: exit", {
      fontSize: "10px",
      color: "#aaaaaa",
      stroke: "#000000",
      strokeThickness: 2,
      backgroundColor: "#000000aa",
      padding: { x: 4, y: 2 },
    });
    statusText.setDepth(20020);
    statusText.setScrollFactor(0);
    statusText.setName("editor-status");

    // "Save" button
    const saveBtn = this.add.text(cam.width / 2, cam.height / 2 - 60, "[ SAVE MAP ]", {
      fontSize: "14px",
      color: "#00ff00",
      stroke: "#000000",
      strokeThickness: 3,
      backgroundColor: "#333333",
      padding: { x: 10, y: 6 },
    });
    saveBtn.setOrigin(0.5);
    saveBtn.setDepth(20020);
    saveBtn.setScrollFactor(0);
    saveBtn.setInteractive({ useHandCursor: true });
    saveBtn.setName("editor-save-btn");
    saveBtn.setPosition(cam.width / 2, 12);
    saveBtn.on("pointerdown", () => {
      this.saveMap();
    });
    saveBtn.on("pointerover", () => {
      saveBtn.setStyle({ color: "#44ff44" });
    });
    saveBtn.on("pointerout", () => {
      saveBtn.setStyle({ color: "#00ff00" });
    });
  }

  private hideEditor(): void {
    if (this.gridOverlay) {
      this.gridOverlay.clear();
    }
    if (this.editorCursor) {
      this.editorCursor.clear();
    }
    if (this.editorToolbar) {
      this.editorToolbar.setVisible(false);
    }
    if (this.editorLayerText) {
      this.editorLayerText.setVisible(false);
    }
    // Destroy object preview and reset object mode
    if (this.editorObjectPreview) {
      this.editorObjectPreview.destroy();
      this.editorObjectPreview = null;
    }
    this.editorObjectMode = false;
    // Remove status text and save button
    const status = this.children.getByName("editor-status");
    if (status) status.destroy();
    const saveBtn = this.children.getByName("editor-save-btn");
    if (saveBtn) saveBtn.destroy();
  }

  private drawGrid(): void {
    if (!this.gridOverlay) return;
    this.gridOverlay.clear();

    this.gridOverlay.lineStyle(1, 0xffffff, 0.15);
    for (let c = 0; c <= MAP_COLS; c++) {
      this.gridOverlay.lineBetween(c * TILE_SIZE, 0, c * TILE_SIZE, MAP_ROWS * TILE_SIZE);
    }
    for (let r = 0; r <= MAP_ROWS; r++) {
      this.gridOverlay.lineBetween(0, r * TILE_SIZE, MAP_COLS * TILE_SIZE, r * TILE_SIZE);
    }
  }

  private buildToolbar(): void {
    if (!this.editorToolbar) return;

    const cam = this.cameras.main;
    const tileCount = 16;
    const btnSize = 28;
    const gap = 4;
    const totalWidth = tileCount * (btnSize + gap);
    const startX = (cam.width / cam.zoom - totalWidth) / 2;
    const y = cam.height / cam.zoom - btnSize - 12;

    // Background bar
    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.7);
    bg.fillRoundedRect(startX - 8, y - 8, totalWidth + 16, btnSize + 30, 6);
    this.editorToolbar.add(bg);

    // Selected tile highlight
    this.editorSelectedHighlight = this.add.graphics();
    this.editorToolbar.add(this.editorSelectedHighlight);

    for (let i = 0; i < tileCount; i++) {
      const bx = startX + i * (btnSize + gap);

      // Tile preview (small copy from the texture)
      const tileImg = this.add.image(bx + btnSize / 2, y + btnSize / 2, "office-tiles");
      tileImg.setCrop(i * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
      tileImg.setDisplaySize(btnSize, btnSize);
      tileImg.setOrigin(0.5, 0.5);
      this.editorToolbar.add(tileImg);

      // Label
      const label = this.add.text(bx + btnSize / 2, y + btnSize + 2, `${i}`, {
        fontSize: "7px",
        color: "#aaaaaa",
        align: "center",
      });
      label.setOrigin(0.5, 0);
      this.editorToolbar.add(label);

      // Invisible interactive zone
      const zone = this.add.zone(bx + btnSize / 2, y + btnSize / 2, btnSize, btnSize);
      zone.setInteractive({ useHandCursor: true });
      zone.on("pointerdown", () => {
        this.selectedTile = i;
        this.updateToolbarHighlight();
      });
      this.editorToolbar.add(zone);
    }

    this.updateToolbarHighlight();
  }

  private updateToolbarHighlight(): void {
    if (!this.editorSelectedHighlight || !this.editorToolbar) return;

    const cam = this.cameras.main;
    const tileCount = 16;
    const btnSize = 28;
    const gap = 4;
    const totalWidth = tileCount * (btnSize + gap);
    const startX = (cam.width / cam.zoom - totalWidth) / 2;
    const y = cam.height / cam.zoom - btnSize - 12;

    const bx = startX + this.selectedTile * (btnSize + gap);

    this.editorSelectedHighlight.clear();
    this.editorSelectedHighlight.lineStyle(2, 0x00ff00, 1);
    this.editorSelectedHighlight.strokeRect(bx - 1, y - 1, btnSize + 2, btnSize + 2);
  }

  private updateLayerText(): void {
    if (!this.editorLayerText) return;
    if (this.editorObjectMode) {
      const typeIndex = OBJECT_TYPE_LIST.findIndex((t) => t.id === this.selectedObjectType);
      const indexLabel = typeIndex >= 0 ? ` (${typeIndex + 1})` : "";
      this.editorLayerText.setText(`Object Mode: ${this.selectedObjectType}${indexLabel} | O: toggle mode`);
    } else {
      const layerNames = ["Floor (1)", "Walls (2)"];
      this.editorLayerText.setText(`Layer: ${layerNames[this.selectedLayer] ?? "Unknown"} | Tile: ${TILE_NAMES[this.selectedTile]} | O: object mode`);
    }
  }

  private handleEditorClick(pointer: Phaser.Input.Pointer): void {
    if (this.tiledMode) return; // Legacy tile editor not supported for Tiled JSON maps
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const tileX = Math.floor(worldPoint.x / TILE_SIZE);
    const tileY = Math.floor(worldPoint.y / TILE_SIZE);

    if (tileX < 0 || tileX >= MAP_COLS || tileY < 0 || tileY >= MAP_ROWS) return;

    // Right-click: erase (set to empty or floor depending on layer)
    let layerName: string;
    let tileId: number;
    if (pointer.rightButtonDown()) {
      if (this.selectedLayer === 0) {
        this.floorData[tileY][tileX] = T.FLOOR;
        layerName = "floor";
        tileId = T.FLOOR;
      } else {
        this.wallsData[tileY][tileX] = T.EMPTY;
        layerName = "walls";
        tileId = T.EMPTY;
      }
    } else {
      // Left-click: place selected tile
      if (this.selectedLayer === 0) {
        this.floorData[tileY][tileX] = this.selectedTile;
        layerName = "floor";
        tileId = this.selectedTile;
      } else {
        this.wallsData[tileY][tileX] = this.selectedTile;
        layerName = "walls";
        tileId = this.selectedTile;
      }
    }

    // Recreate the tilemap to reflect changes
    this.createTilemap();

    // Broadcast tile change to other players in the channel
    this.socket?.emit("map:tiles-update", { layer: layerName, row: tileY, col: tileX, tileId });

  }

  private saveMap(): void {
    const mapData: MapData = {
      layers: {
        floor: this.floorData,
        walls: this.wallsData,
      },
      objects: this.mapObjects,
    };

    // Save to localStorage (may fail in restricted contexts)
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("deskrpg-map-office", JSON.stringify(mapData));
      }
    } catch {
      // Storage access denied — skip
    }

    // Save to server (channel API if available, otherwise legacy maps API)
    const saveUrl = this.channelId
      ? `/api/channels/${this.channelId}`
      : "/api/maps/office";
    const saveMethod = this.channelId ? "PUT" : "POST";
    const saveBody = this.channelId
      ? { mapData }
      : { mapId: "office", layers: mapData };
    fetch(saveUrl, {
      method: saveMethod,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saveBody),
    })
      .then((res) => {
        if (res.ok) {
          // Flash the save button green
          const saveBtn = this.children.getByName("editor-save-btn") as Phaser.GameObjects.Text | null;
          if (saveBtn) {
            saveBtn.setText("[ SAVED! ]");
            this.time.delayedCall(1500, () => {
              if (saveBtn.active) saveBtn.setText("[ SAVE MAP ]");
            });
          }
        } else {
          console.error("[MapEditor] Server save failed:", res.status);
        }
      })
      .catch((err) => {
        console.error("[MapEditor] Server save error:", err);
      });
  }

  // ---------------------------------------------------------------------------
  // Load NPCs
  // ---------------------------------------------------------------------------

  /** Fetch NPC positions early so spawn collision check works before sprites load */
  private async prefetchNpcPositions(): Promise<NpcData[]> {
    try {
      const url = this.channelId ? `/api/npcs?channelId=${this.channelId}` : "/api/npcs";
      const res = await fetch(url);
      const data = await res.json();
      const npcs: NpcData[] = data.npcs || [];
      for (const npc of npcs) {
        this.npcTilePositions.add(`${npc.positionX},${npc.positionY}`);
      }
      return npcs;
    } catch (err) {
      console.error("[GameScene] prefetchNpcPositions failed:", err);
      return [];
    }
  }

  private loadNpcs(npcDataList: NpcData[]): void {
    for (const npc of npcDataList) {
      this.npcTilePositions.add(`${npc.positionX},${npc.positionY}`);
      const npcSprite = new NpcSprite(this, npc);
      this.npcSprites.push(npcSprite);
    }
  }

  private removeNpcById(npcId: string): void {
    const idx = this.npcSprites.findIndex(n => n.id === npcId);
    if (idx === -1) return;
    const npc = this.npcSprites[idx];
    const col = Math.floor(npc.pixelX / TILE_SIZE);
    const row = Math.floor(npc.pixelY / TILE_SIZE);
    this.npcTilePositions.delete(`${col},${row}`);
    npc.destroy();
    this.npcSprites.splice(idx, 1);
  }

  // ---------------------------------------------------------------------------
  // Socket.io listeners
  // ---------------------------------------------------------------------------

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on("players:state", (data: { players: RemotePlayerData[] }) => {
      for (const p of data.players) {
        this.addRemotePlayer(p);
      }
    });

    this.socket.on("player:joined", (data: RemotePlayerData) => {
      this.addRemotePlayer(data);
    });

    this.socket.on(
      "player:moved",
      (data: { id: string; x: number; y: number; direction: string; animation: string }) => {
        const remote = this.remotePlayers.get(data.id);
        if (remote) {
          remote.updatePosition(data.x, data.y, data.direction, data.animation);
        }
      }
    );

    this.socket.on("player:left", (data: { id: string }) => {
      const remote = this.remotePlayers.get(data.id);
      if (remote) {
        remote.destroy();
        this.remotePlayers.delete(data.id);
      }
    });

    // NPC real-time sync
    this.socket.on("npc:added", (npcData: NpcData) => {
      if (this.npcSprites.some(n => n.id === npcData.id)) return;
      const npc = new NpcSprite(this, npcData);
      this.npcSprites.push(npc);
      this.npcTilePositions.add(`${npcData.positionX},${npcData.positionY}`);
    });

    this.socket.on("npc:updated", (data: { npcId: string; name?: string; direction?: string; appearance?: unknown }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc) return;
      npc.updateFromData(data);
    });

    this.socket.on("npc:removed", (data: { npcId: string }) => {
      this.removeNpcById(data.npcId);
    });

    // Map editing real-time sync
    this.socket.on("map:object-added", (data: { object: MapObject }) => {
      this.mapObjects.push(data.object);
      this.renderObjects();
    });

    this.socket.on("map:object-removed", (data: { objectId: string }) => {
      this.mapObjects = this.mapObjects.filter(o => o.id !== data.objectId);
      this.renderObjects();
    });

    this.socket.on("map:tiles-updated", (data: { layer: string; row: number; col: number; tileId: number }) => {
      if (this.tiledMode) return; // Tiled JSON maps don't use legacy tile editing
      if (data.layer === "floor" && this.floorData[data.row]) {
        this.floorData[data.row][data.col] = data.tileId;
      } else if (data.layer === "walls" && this.wallsData[data.row]) {
        this.wallsData[data.row][data.col] = data.tileId;
      }
      this.createTilemap();
    });

    this.socket.on("npc:stop-moving", (data: { npcId: string }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc) return;
      if (npc.sprite instanceof Phaser.GameObjects.Sprite) {
        npc.sprite.stop();
        const idleFrame = npc.direction * SPRITE_COLS;
        npc.sprite.setFrame(idleFrame);
      }
    });

    this.socket.on("npc:position-sync", (data: { npcId: string; x: number; y: number; direction: string }) => {
      const npc = this.npcSprites.find(n => n.id === data.npcId);
      if (!npc) return;
      npc.pixelX = data.x;
      npc.pixelY = data.y;
      npc.direction = DIR_NAME_MAP[data.direction] ?? DIR_DOWN;
      npc.sprite.setPosition(data.x, data.y);
      npc.nameLabel.setPosition(data.x, data.y - 44);

      // Play walk animation matching direction (on other clients)
      if (npc.sprite instanceof Phaser.GameObjects.Sprite) {
        const walkKey = `npc-${npc.id}-walk-${data.direction}`;
        if (this.anims.exists(walkKey) && npc.sprite.anims.currentAnim?.key !== walkKey) {
          npc.sprite.play(walkKey, true);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Remote player management
  // ---------------------------------------------------------------------------

  private addRemotePlayer(data: RemotePlayerData): void {
    if (this.remotePlayers.has(data.id)) return;

    const textureKey = `remote-${data.id}`;

    EventBus.emit("composite-remote-player", {
      id: data.id,
      appearance: data.appearance,
    });

    const handler = (result: { id: string; dataUrl: string }) => {
      if (result.id !== data.id) return;
      EventBus.off("remote-spritesheet-ready", handler);

      // Skip if this player was already added (duplicate event)
      if (this.remotePlayers.has(data.id)) return;

      const img = new window.Image();
      img.onload = () => {
        if (this.remotePlayers.has(data.id)) return;
        if (!this.textures.exists(textureKey)) {
          this.textures.addSpriteSheet(textureKey, img, {
            frameWidth: 64,
            frameHeight: 64,
          });
        }
        this.createRemoteAnimations(textureKey);
        const remote = new RemotePlayer(this, data, textureKey);
        this.remotePlayers.set(data.id, remote);
      };
      img.src = result.dataUrl;
    };

    EventBus.on("remote-spritesheet-ready", handler);
  }

  private createRemoteAnimations(textureKey: string): void {
    const directions = [
      { key: `${textureKey}-walk-up`, row: DIR_UP },
      { key: `${textureKey}-walk-left`, row: DIR_LEFT },
      { key: `${textureKey}-walk-down`, row: DIR_DOWN },
      { key: `${textureKey}-walk-right`, row: DIR_RIGHT },
    ];

    for (const dir of directions) {
      if (this.anims.exists(dir.key)) continue;
      this.anims.create({
        key: dir.key,
        frames: this.anims.generateFrameNumbers(textureKey, {
          start: dir.row * SPRITE_COLS + 1,
          end: dir.row * SPRITE_COLS + SPRITE_COLS - 1,
        }),
        frameRate: 10,
        repeat: -1,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Local player setup
  // ---------------------------------------------------------------------------

  private loadPlayerTexture(dataUrl: string): void {
    if (this.playerReady) return;

    const img = new Image();
    img.onerror = () => {
      this.createPlayer(); // fallback texture will be used
    };
    img.onload = () => {
      try {
        if (!this.textures.exists("player")) {
          this.textures.addSpriteSheet("player", img, {
            frameWidth: 64,
            frameHeight: 64,
          });
        }
      } catch {
        // texture add failed — createPlayer will use fallback
      }
      this.createPlayer();
    };
    img.src = dataUrl;
  }

  /** Check if a tile is occupied by an NPC, remote player, or known NPC position */
  private isTileOccupied(col: number, row: number): boolean {
    // Check pre-recorded NPC positions (available before sprites load)
    if (this.npcTilePositions.has(`${col},${row}`)) return true;

    const cx = col * TILE_SIZE + TILE_SIZE / 2;
    const cy = row * TILE_SIZE + TILE_SIZE / 2;
    const threshold = TILE_SIZE * 0.8;

    for (const npc of this.npcSprites) {
      if (Math.abs(npc.pixelX - cx) < threshold && Math.abs(npc.pixelY - cy) < threshold) {
        return true;
      }
    }
    for (const remote of this.remotePlayers.values()) {
      if (Math.abs(remote.sprite.x - cx) < threshold && Math.abs(remote.sprite.y - cy) < threshold) {
        return true;
      }
    }
    return false;
  }

  /** Find a free walkable spawn position near the preferred tile */
  private findFreeSpawn(preferCol: number, preferRow: number): { col: number; row: number } {
    // Try the preferred position first
    if (this.isWalkable(preferCol, preferRow) && !this.isTileOccupied(preferCol, preferRow)) {
      return { col: preferCol, row: preferRow };
    }
    // Spiral outward to find a free tile
    for (let radius = 1; radius < Math.max(MAP_COLS, MAP_ROWS); radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const c = preferCol + dx;
          const r = preferRow + dy;
          if (this.isWalkable(c, r) && !this.isTileOccupied(c, r)) {
            return { col: c, row: r };
          }
        }
      }
    }
    return { col: preferCol, row: preferRow }; // fallback
  }

  private createPlayer(): void {
    if (this.playerReady) return; // prevent double creation

    let spawnX: number;
    let spawnY: number;

    // Priority: mapConfig spawn (owner-set) > savedPosition (last session) > Objects layer / default
    if (this.mapConfigSpawnCol !== null && this.mapConfigSpawnRow !== null) {
      // Owner explicitly configured spawn — always use it, ignore saved position
      const { col: spawnCol, row: spawnRow } = this.findFreeSpawn(this.mapConfigSpawnCol, this.mapConfigSpawnRow);
      spawnX = spawnCol * TILE_SIZE + TILE_SIZE / 2;
      spawnY = spawnRow * TILE_SIZE + TILE_SIZE / 2;
      this.savedPosition = null;
    } else if (this.savedPosition) {
      // Restore saved position from last session (pixel coordinates)
      spawnX = this.savedPosition.x;
      spawnY = this.savedPosition.y;
      this.savedPosition = null; // consumed
    } else {
      // Find a free spawn position, checking NPCs, remote players, AND object occupied tiles
      const preferSpawnCol = this.tiledSpawnCol ?? 8;
      const preferSpawnRow = this.tiledSpawnRow ?? 3;
      const { col: spawnCol, row: spawnRow } = this.findFreeSpawn(preferSpawnCol, preferSpawnRow);
      spawnX = spawnCol * TILE_SIZE + TILE_SIZE / 2;
      spawnY = spawnRow * TILE_SIZE + TILE_SIZE / 2;
    }

    const playerTex = this.textures.exists("player") ? "player" : "fallback-char";
    this.player = this.physics.add.sprite(spawnX, spawnY, playerTex, playerTex === "player" ? DIR_DOWN * SPRITE_COLS : 0);
    this.player.setOrigin(0.5, 0.85);
    this.player.setDisplaySize(48, 48);
    this.player.setSize(15, 12);
    this.player.setOffset(17, 32);
    this.player.setCollideWorldBounds(true);

    // Player name label (same style as remote players)
    this.playerNameLabel = this.add.text(spawnX, spawnY - 44, this.characterName, {
      fontSize: "11px",
      color: "#ffffff",
      stroke: "#000000",
      strokeThickness: 2,
      align: "center",
    });
    this.playerNameLabel.setOrigin(0.5, 1);
    this.playerNameLabel.setDepth(20001);

    this.createAnimations();
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);

    this.playerReady = true;
    EventBus.emit("player-spawned");

    this.joinMultiplayer(spawnX, spawnY);
  }

  private createAnimations(): void {
    const directions = [
      { key: "walk-up", row: DIR_UP },
      { key: "walk-left", row: DIR_LEFT },
      { key: "walk-down", row: DIR_DOWN },
      { key: "walk-right", row: DIR_RIGHT },
    ];

    for (const dir of directions) {
      if (this.anims.exists(dir.key)) continue;
      this.anims.create({
        key: dir.key,
        frames: this.anims.generateFrameNumbers("player", {
          start: dir.row * SPRITE_COLS + 1,
          end: dir.row * SPRITE_COLS + SPRITE_COLS - 1,
        }),
        frameRate: 10,
        repeat: -1,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Multiplayer join
  // ---------------------------------------------------------------------------

  private joinMultiplayer(x: number, y: number): void {
    if (!this.socket || !this.characterId) return;

    this.socket.emit("player:join", {
      characterId: this.characterId,
      characterName: this.characterName,
      appearance: this.appearance,
      mapId: this.channelId || "office",
      x,
      y,
    });
  }

  // ---------------------------------------------------------------------------
  // Send position (throttled)
  // ---------------------------------------------------------------------------

  private sendPosition(x: number, y: number, direction: string, animation: string): void {
    if (!this.socket) return;

    const now = Date.now();
    if (now - this.lastMoveSent < MOVE_SEND_INTERVAL) return;

    if (
      Math.abs(x - this.lastSentX) < 0.5 &&
      Math.abs(y - this.lastSentY) < 0.5 &&
      direction === this.lastSentDir &&
      animation === this.lastSentAnim
    ) {
      return;
    }

    this.lastMoveSent = now;
    this.lastSentX = x;
    this.lastSentY = y;
    this.lastSentDir = direction;
    this.lastSentAnim = animation;

    this.socket.emit("player:move", { x, y, direction, animation });
  }

  // ---------------------------------------------------------------------------
  // Speech bubbles (icon only, no text)
  // ---------------------------------------------------------------------------

  private npcBubbles: Map<string, Phaser.GameObjects.Container> = new Map();

  private createBubbleIcon(x: number, y: number, text?: string): Phaser.GameObjects.Container {
    const container = this.add.container(x, y - 44);
    const gfx = this.add.graphics();

    if (text) {
      const label = this.add.text(0, -2, text, {
        fontSize: "11px",
        color: "#111827",
        fontStyle: "bold",
        padding: { left: 6, right: 6, top: 3, bottom: 3 },
      });
      label.setOrigin(0.5, 0.5);
      const width = Math.max(64, label.width + 12);
      const height = label.height + 8;
      gfx.fillStyle(0xffffff, 0.95);
      gfx.fillRoundedRect(-width / 2, -height / 2, width, height, 6);
      gfx.lineStyle(1, 0xcccccc, 0.8);
      gfx.strokeRoundedRect(-width / 2, -height / 2, width, height, 6);
      gfx.fillStyle(0xffffff, 0.95);
      gfx.fillTriangle(-4, height / 2 - 1, 4, height / 2 - 1, 0, height / 2 + 6);
      container.add(gfx);
      container.add(label);
    } else {
      // White bubble with subtle border
      gfx.fillStyle(0xffffff, 0.95);
      gfx.fillRoundedRect(-12, -11, 24, 18, 5);
      gfx.lineStyle(1, 0xcccccc, 0.8);
      gfx.strokeRoundedRect(-12, -11, 24, 18, 5);
      // Tail
      gfx.fillStyle(0xffffff, 0.95);
      gfx.fillTriangle(-3, 7, 3, 7, 0, 13);
      container.add(gfx);
      // Black dots
      const dots = this.add.graphics();
      dots.fillStyle(0x333333, 1);
      dots.fillCircle(-5, -2, 2);
      dots.fillCircle(0, -2, 2);
      dots.fillCircle(5, -2, 2);
      container.add(dots);
    }

    container.setDepth(20002);
    return container;
  }

  private showPlayerBubble(senderId: string): void {
    const remote = this.remotePlayers.get(senderId);
    if (!remote) return;

    const bubble = this.createBubbleIcon(remote.sprite.x, remote.sprite.y);

    // Player bubbles: fade after 4 seconds
    this.tweens.add({
      targets: bubble,
      alpha: 0,
      duration: 500,
      delay: 3500,
      onComplete: () => bubble.destroy(),
    });
  }

  private showNpcBubbleIcon(npcId: string, text?: string): void {
    if (this.npcBubbles.has(npcId)) {
      if (!text) return;
      this.clearNpcBubble(npcId);
    }

    const npc = this.npcSprites.find((n) => n.id === npcId);
    if (!npc) return;

    const bubble = this.createBubbleIcon(npc.pixelX, npc.pixelY, text);
    this.npcBubbles.set(npcId, bubble);
  }

  private clearNpcBubble(npcId: string): void {
    const bubble = this.npcBubbles.get(npcId);
    if (bubble) {
      bubble.destroy();
      this.npcBubbles.delete(npcId);
    }
  }

  // ---------------------------------------------------------------------------
  // NPC proximity check
  // ---------------------------------------------------------------------------

  private checkNpcProximity(): void {
    if (!this.playerReady || !this.player) return;

    const nearby: NpcSprite[] = [];
    for (const npc of this.npcSprites) {
      if (npc.distanceTo(this.player.x, this.player.y) < NPC_INTERACT_RADIUS) {
        nearby.push(npc);
      }
    }
    nearby.sort((a, b) =>
      a.distanceTo(this.player.x, this.player.y) - b.distanceTo(this.player.x, this.player.y)
    );
    this.nearbyNpcs = nearby;

    // Auto-greet NPCs on first approach
    for (const npc of nearby) {
      if (!this.greetedNpcs.has(npc.id) && !this.dialogOpen && npc.moveState === "idle") {
        this.greetedNpcs.add(npc.id);
        EventBus.emit("npc:auto-greet", { npcId: npc.id, npcName: npc.name });
      }
    }

    // Check nearby remote players
    const nearbyP: { id: string; name: string }[] = [];
    for (const [id, remote] of this.remotePlayers) {
      if (remote.distanceTo(this.player.x, this.player.y) < NPC_INTERACT_RADIUS) {
        nearbyP.push({ id, name: remote.nameLabel.text });
      }
    }
    this.nearbyPlayers = nearbyP;

    const hasNearby = nearby.length > 0 || nearbyP.length > 0;

    // NPC dialog: auto-close when no NPCs nearby
    // But don't auto-close if an NPC is walking toward the player (delivering response)
    const npcApproaching = this.npcSprites.some(n => n.moveState === "moving-to-player");
    if (this.dialogOpen && nearby.length === 0 && this.nearbyPlayers.length === 0 && !npcApproaching) {
      EventBus.emit("npc:dialog-auto-close");
    }

    // Channel chat: notify input enable/disable based on player proximity
    const inputEnabled = nearbyP.length > 0;
    if (inputEnabled !== this.lastChatInputEnabled) {
      this.lastChatInputEnabled = inputEnabled;
      EventBus.emit("chat:input-enabled", inputEnabled);
    }

    if (hasNearby && !this.dialogOpen) {
      const targetName = nearby.length > 0
        ? nearby[0].name
        : nearbyP[0].name;
      const msg = `Press / to talk to ${targetName}`;
      if (msg !== this.lastToastMessage) {
        this.lastToastMessage = msg;
        EventBus.emit("toast:show", { message: msg });
      }
    } else if (!this.dialogOpen) {
      if (this.lastToastMessage !== null) {
        this.lastToastMessage = null;
        EventBus.emit("toast:hide");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Y-sort depth helper
  // ---------------------------------------------------------------------------

  private updateYSortDepth(sprite: { y: number; displayHeight: number; originY: number; setDepth(v: number): void }): void {
    // footY = pixel y of the character's bottom edge.
    // Base 10000 puts characters in the same depth range as foreground tile sprites
    // (depth = 10000 + tile.bottom) so per-tile y-sort works for all players/NPCs.
    const footY = sprite.y + sprite.displayHeight * (1 - sprite.originY);
    sprite.setDepth(10000 + footY);
  }

  private approachNpcAndInteract(npcId: string, npcName?: string): void {
    if (!this.player || !this.playerReady) return;

    const npc = this.npcSprites.find((entry) => entry.id === npcId);
    if (!npc || npc.moveState !== "idle") return;

    if (npc.distanceTo(this.player.x, this.player.y) < NPC_INTERACT_RADIUS) {
      EventBus.emit("npc:interact", { npcId: npc.id, npcName: npcName || npc.name });
      return;
    }

    const npcTileX = Math.floor(npc.pixelX / TILE_SIZE);
    const npcTileY = Math.floor(npc.pixelY / TILE_SIZE);
    const startTileX = Math.floor(this.player.x / TILE_SIZE);
    const startTileY = Math.floor(this.player.y / TILE_SIZE);

    let destTileX = npcTileX;
    let destTileY = npcTileY;
    const neighbors = [
      [npcTileX, npcTileY + 1],
      [npcTileX, npcTileY - 1],
      [npcTileX - 1, npcTileY],
      [npcTileX + 1, npcTileY],
    ];
    const walkable = neighbors.find(([x, y]) => this.isWalkable(x, y) && !this.isTileOccupied(x, y));
    if (walkable) {
      destTileX = walkable[0];
      destTileY = walkable[1];
    }

    if (!this.isWalkable(destTileX, destTileY) || this.isTileOccupied(destTileX, destTileY)) {
      const nearest = this.findNearestWalkableTile(destTileX, destTileY);
      if (!nearest) return;
      destTileX = nearest.x;
      destTileY = nearest.y;
    }

    const path = findPath(
      startTileX,
      startTileY,
      destTileX,
      destTileY,
      (tx, ty) => this.isWalkable(tx, ty) && !this.isTileOccupied(tx, ty),
    );

    if (!path || path.length <= 1) {
      EventBus.emit("npc:interact", { npcId: npc.id, npcName: npcName || npc.name });
      return;
    }

    this.currentPath = path;
    this.pathIndex = 1;
    this.pathStuckTimer = 0;
    this.pathLastDist = Infinity;
    this.targetNpcId = npc.id;
    this.drawPathLine(path);
  }

  // ---------------------------------------------------------------------------
  // Update loop
  // ---------------------------------------------------------------------------

  update(): void {
    // Lerp remote players every frame
    for (const remote of this.remotePlayers.values()) {
      remote.lerpUpdate();
    }

    // Update NPC movement
    if (this.player) {
      // Auto-return NPCs that have been waiting long enough without an open dialog
      for (const npc of this.npcSprites) {
        if (npc.moveState === "waiting" && !this.dialogOpen) {
          npc.waitTimer += this.game.loop.delta;
          if (npc.waitTimer >= npc.waitDurationMs) {
            npc.waitTimer = 0;
            this.clearNpcBubble(npc.id);
            npc.returnToHome(
              findPath,
              (tx: number, ty: number) => this.isWalkable(tx, ty) && !this.isTileOccupied(tx, ty),
            );
            EventBus.emit("npc:movement-returned", { npcId: npc.id });
            this.socket?.emit("npc:return-home", { channelId: this.channelId, npcId: npc.id });
          }
        }
      }

      for (const npc of this.npcSprites) {
        if (npc.moveState === "idle" || npc.moveState === "waiting") continue;
        const pCol = Math.floor(this.player.x / TILE_SIZE);
        const pRow = Math.floor(this.player.y / TILE_SIZE);
        // Walkable check excludes this NPC itself (prevents self-blocking)
        const npcSelf = npc;
        const result = npc.updateMovement(
          this.game.loop.delta,
          this.player.x,
          this.player.y,
          findPath,
          (tx: number, ty: number) => {
            if (!this.isWalkable(tx, ty)) return false;
            if (tx === pCol && ty === pRow) return true; // player tile always walkable
            // Check occupation excluding self
            const cx = tx * TILE_SIZE + TILE_SIZE / 2;
            const cy = ty * TILE_SIZE + TILE_SIZE / 2;
            const threshold = TILE_SIZE * 0.8;
            for (const other of this.npcSprites) {
              if (other === npcSelf) continue; // skip self
              if (Math.abs(other.pixelX - cx) < threshold && Math.abs(other.pixelY - cy) < threshold) return false;
            }
            for (const remote of this.remotePlayers.values()) {
              if (Math.abs(remote.sprite.x - cx) < threshold && Math.abs(remote.sprite.y - cy) < threshold) return false;
            }
            return true;
          },
        );
        if (result === "arrived") {
          EventBus.emit("npc:bubble", {
            npcId: npc.id,
            text: npc.arrivalBubbleText || undefined,
          });
          EventBus.emit("toast:show", {
            message: `Press / to talk to ${npc.name}`,
          });
          EventBus.emit("npc:movement-arrived", {
            npcId: npc.id,
            npcName: npc.name,
            pendingMessage: npc.pendingMessage,
            reportId: npc.pendingReportId,
            reportKind: npc.pendingReportKind,
          });
          this.socket?.emit("npc:arrived", {
            channelId: this.channelId,
            npcId: npc.id,
          });
        } else if (result === "returning-done") {
          this.npcTilePositions.add(`${npc.homeCol},${npc.homeRow}`);
          EventBus.emit("npc:movement-returned", { npcId: npc.id });
        }
      }

      // Update NPC bubble positions to follow sprites
      for (const [npcId, bubble] of this.npcBubbles) {
        const npc = this.npcSprites.find(n => n.id === npcId);
        if (npc) bubble.setPosition(npc.pixelX, npc.pixelY - 44);
      }

      // Sync moving NPC positions to server every 200ms
      this.npcPositionSyncTimer += this.game.loop.delta;
      if (this.npcPositionSyncTimer >= 200) {
        this.npcPositionSyncTimer = 0;
        for (const npc of this.npcSprites) {
          if (npc.moveState === "moving-to-player" || npc.moveState === "returning") {
            this.socket?.emit("npc:position-update", {
              channelId: this.channelId,
              npcId: npc.id,
              x: npc.pixelX,
              y: npc.pixelY,
              direction: DIR_NUM_TO_NAME[npc.direction] ?? "down",
            });
          }
        }
      }
    }

    // Tab key to toggle editor
    if (this.tabKey && Phaser.Input.Keyboard.JustDown(this.tabKey)) {
      this.toggleEditor();
    }

    // Editor mode: handle layer/object switching with number keys and O key
    if (this.editorMode) {
      // O key: toggle between tile mode and object mode
      if (this.editorKeys.oKey && Phaser.Input.Keyboard.JustDown(this.editorKeys.oKey)) {
        this.editorObjectMode = !this.editorObjectMode;
        this.updateLayerText();
        if (!this.editorObjectMode && this.editorObjectPreview) {
          this.editorObjectPreview.destroy();
          this.editorObjectPreview = null;
        }
      }

      if (this.editorObjectMode) {
        // Number keys 1-9 select object type
        const typeList = OBJECT_TYPE_LIST;
        const numKeys = [this.editorKeys.one, this.editorKeys.two, this.editorKeys.three];
        for (let i = 0; i < numKeys.length && i < typeList.length; i++) {
          const key = numKeys[i];
          if (key && Phaser.Input.Keyboard.JustDown(key)) {
            this.selectedObjectType = typeList[i].id;
            this.updateLayerText();
            // Destroy existing preview so it recreates with new texture
            if (this.editorObjectPreview) {
              this.editorObjectPreview.destroy();
              this.editorObjectPreview = null;
            }
          }
        }
      } else {
        // Tile mode: number keys select layer
        if (this.editorKeys.one && Phaser.Input.Keyboard.JustDown(this.editorKeys.one)) {
          this.selectedLayer = 0;
          this.updateLayerText();
        }
        if (this.editorKeys.two && Phaser.Input.Keyboard.JustDown(this.editorKeys.two)) {
          this.selectedLayer = 1;
          this.updateLayerText();
        }
      }
    }

    // Placement mode: show tile highlight under cursor
    if (this.placementMode) {
      const pointer = this.input.activePointer;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const col = Math.floor(worldPoint.x / TILE_SIZE);
      const row = Math.floor(worldPoint.y / TILE_SIZE);
      if (this.isWalkable(col, row) && !this.isTileOccupied(col, row)) {
        if (!this.placementHighlight) {
          this.placementHighlight = this.add.rectangle(0, 0, TILE_SIZE, TILE_SIZE, 0x4f46e5, 0.4);
          this.placementHighlight.setDepth(20020);
        }
        this.placementHighlight.setPosition(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2);
        this.placementHighlight.setVisible(true);
      } else {
        this.placementHighlight?.setVisible(false);
      }
      return; // Skip normal movement in placement mode
    }

    // Spawn set mode: show green tile highlight under cursor
    if (this.spawnSetMode) {
      const pointer = this.input.activePointer;
      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      const col = Math.floor(worldPoint.x / TILE_SIZE);
      const row = Math.floor(worldPoint.y / TILE_SIZE);
      if (this.isWalkable(col, row)) {
        if (!this.spawnHighlight) {
          this.spawnHighlight = this.add.rectangle(0, 0, TILE_SIZE, TILE_SIZE, 0x22c55e, 0.5);
          this.spawnHighlight.setDepth(20020);
        }
        this.spawnHighlight.setPosition(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2);
        this.spawnHighlight.setVisible(true);
      } else {
        this.spawnHighlight?.setVisible(false);
      }
      return; // Skip normal movement in spawn set mode
    }

    if (!this.playerReady || !this.player?.body) return;

    this.checkNpcProximity();

    // / key for NPC/player interaction
    if (this.interactKey && Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      const activeEl = document.activeElement as HTMLElement | null;
      const isTypingTarget = !!activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.tagName === "SELECT" ||
        activeEl.isContentEditable
      );
      if (isTypingTarget) {
        return;
      }
      if (!this.dialogOpen) {
        const npcEntries = this.nearbyNpcs.map((n) => ({ id: n.id, name: n.name, type: "npc" as const }));
        const playerEntries = this.nearbyPlayers.map((p) => ({ id: p.id, name: p.name, type: "player" as const }));
        const allNearby = [...npcEntries, ...playerEntries];

        if (allNearby.length === 1) {
          if (allNearby[0].type === "npc") {
            EventBus.emit("npc:interact", { npcId: allNearby[0].id, npcName: allNearby[0].name });
          } else {
            EventBus.emit("player:chat-open");
          }
        } else if (allNearby.length > 1) {
          EventBus.emit("interact:select", { targets: allNearby });
        }
      }
    }

    const body = this.player.body as Phaser.Physics.Arcade.Body;

    // Detect keyboard input
    const left = this.cursors?.left.isDown;
    const right = this.cursors?.right.isDown;
    const up = this.cursors?.up.isDown;
    const down = this.cursors?.down.isDown;
    const hasKeyboardInput = left || right || up || down;

    // Arrow keys cancel path following
    if (hasKeyboardInput && this.currentPath) {
      this.currentPath = null;
      this.clearPathLine();
      this.targetNpcId = null;
    }

    // Path following
    if (this.currentPath && this.pathIndex < this.currentPath.length) {
      const target = this.currentPath[this.pathIndex];
      const targetPixelX = target.x * TILE_SIZE + TILE_SIZE / 2;
      const targetPixelY = target.y * TILE_SIZE + TILE_SIZE / 2;

      const dx = targetPixelX - this.player.x;
      const dy = targetPixelY - this.player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.pathLastDist - 0.5) {
        this.pathStuckTimer = 0;
        this.pathLastDist = dist;
      } else {
        this.pathStuckTimer++;
      }

      const reached = dist < TILE_SIZE * 0.6;
      const stuck = this.pathStuckTimer > 30;

      if (reached || stuck) {
        this.pathIndex++;
        this.pathStuckTimer = 0;
        this.pathLastDist = Infinity;
        if (this.pathIndex >= this.currentPath.length) {
          this.currentPath = null;
          this.clearPathLine();
          body.setVelocity(0, 0);

          if (this.targetNpcId) {
            const npc = this.npcSprites.find((n) => n.id === this.targetNpcId);
            if (npc) {
              EventBus.emit("npc:interact", { npcId: npc.id, npcName: npc.name });
            }
            this.targetNpcId = null;
          }
        }
      } else {
        const angle = Math.atan2(dy, dx);
        body.setVelocity(
          Math.cos(angle) * PLAYER_SPEED,
          Math.sin(angle) * PLAYER_SPEED
        );

        if (Math.abs(dx) > Math.abs(dy)) {
          this.currentDirection = dx > 0 ? DIR_RIGHT : DIR_LEFT;
        } else {
          this.currentDirection = dy > 0 ? DIR_DOWN : DIR_UP;
        }

        const walkKey = `walk-${DIR_NUM_TO_NAME[this.currentDirection]}`;
        if (this.player.anims.currentAnim?.key !== walkKey) {
          this.player.play(walkKey, true);
        }
      }

      this.sendPosition(
        this.player.x,
        this.player.y,
        DIR_NUM_TO_NAME[this.currentDirection],
        "walk"
      );

      // Update player name label position
      if (this.playerNameLabel && this.player) {
        this.playerNameLabel.setPosition(this.player.x, this.player.y - 44);
      }
      // Y-sort depth ordering (path following early-return path)
      if (this.player) this.updateYSortDepth(this.player);
      for (const remote of this.remotePlayers.values()) {
        if (remote.sprite) this.updateYSortDepth(remote.sprite);
      }
      for (const npc of this.npcSprites) {
        if (npc.sprite) this.updateYSortDepth(npc.sprite);
      }
      for (const sprite of this.ySortObjectSprites.values()) {
        this.updateYSortDepth(sprite);
      }
      return;
    }

    // Manual collision check (since we don't use layer colliders with multi-layer)
    if (hasKeyboardInput) {
      const nextX = this.player.x + (left ? -4 : right ? 4 : 0);
      const nextY = this.player.y + (up ? -4 : down ? 4 : 0);
      const nextTileX = Math.floor(nextX / TILE_SIZE);
      const nextTileY = Math.floor(nextY / TILE_SIZE);

      // Check if the next tile is walkable
      const currentTileX = Math.floor(this.player.x / TILE_SIZE);
      const currentTileY = Math.floor(this.player.y / TILE_SIZE);

      let vx = 0;
      let vy = 0;

      // Check horizontal movement (walkable + not occupied by NPC/player)
      if (left) {
        const checkX = Math.floor((this.player.x - 12) / TILE_SIZE);
        if (this.isWalkable(checkX, currentTileY) && !this.isTileOccupied(checkX, currentTileY)) vx = -PLAYER_SPEED;
      } else if (right) {
        const checkX = Math.floor((this.player.x + 12) / TILE_SIZE);
        if (this.isWalkable(checkX, currentTileY) && !this.isTileOccupied(checkX, currentTileY)) vx = PLAYER_SPEED;
      }

      // Check vertical movement (walkable + not occupied by NPC/player)
      if (up) {
        const checkY = Math.floor((this.player.y - 12) / TILE_SIZE);
        if (this.isWalkable(currentTileX, checkY) && !this.isTileOccupied(currentTileX, checkY)) vy = -PLAYER_SPEED;
      } else if (down) {
        const checkY = Math.floor((this.player.y + 12) / TILE_SIZE);
        if (this.isWalkable(currentTileX, checkY) && !this.isTileOccupied(currentTileX, checkY)) vy = PLAYER_SPEED;
      }

      if (vx !== 0 && vy !== 0) {
        const factor = Math.SQRT1_2;
        vx *= factor;
        vy *= factor;
      }

      body.setVelocity(vx, vy);

      if (vx !== 0 || vy !== 0) {
        if (Math.abs(vx) >= Math.abs(vy)) {
          this.currentDirection = vx < 0 ? DIR_LEFT : DIR_RIGHT;
        } else {
          this.currentDirection = vy < 0 ? DIR_UP : DIR_DOWN;
        }

        const animKey = `walk-${DIR_NUM_TO_NAME[this.currentDirection]}`;
        this.player.anims.play(animKey, true);

        this.sendPosition(
          this.player.x,
          this.player.y,
          DIR_NUM_TO_NAME[this.currentDirection],
          "walk"
        );
      } else {
        this.player.anims.stop();
        this.player.setFrame(this.currentDirection * SPRITE_COLS);

        this.sendPosition(
          this.player.x,
          this.player.y,
          DIR_NUM_TO_NAME[this.currentDirection],
          "idle"
        );
      }
    } else {
      body.setVelocity(0, 0);
      this.player.anims.stop();
      this.player.setFrame(this.currentDirection * SPRITE_COLS);

      this.sendPosition(
        this.player.x,
        this.player.y,
        DIR_NUM_TO_NAME[this.currentDirection],
        "idle"
      );
    }

    // Update player name label position
    if (this.playerNameLabel && this.player) {
      this.playerNameLabel.setPosition(this.player.x, this.player.y - 40);
    }
    // Y-sort depth ordering
    if (this.player) {
      this.updateYSortDepth(this.player);
    }
    for (const remote of this.remotePlayers.values()) {
      if (remote.sprite) this.updateYSortDepth(remote.sprite);
    }
    for (const npc of this.npcSprites) {
      if (npc.sprite) this.updateYSortDepth(npc.sprite);
    }
    for (const sprite of this.ySortObjectSprites.values()) {
      this.updateYSortDepth(sprite);
    }
  }
}
