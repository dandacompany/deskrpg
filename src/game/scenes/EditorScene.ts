import Phaser from "phaser";
import { EventBus } from "../EventBus";
import { OBJECT_TYPES, canPlaceObject, generateObjectId } from "@/lib/object-types";
import type { MapObject } from "@/lib/object-types";

const TILE_SIZE = 32;

export type EditorTool = "paint" | "erase" | "fill" | "object" | "spawn";
export type EditorLayer = "floor" | "walls";

interface EditorMapData {
  layers: {
    floor: number[][];
    walls: number[][];
  };
  objects: MapObject[];
  spawn?: { col: number; row: number };
}

export class EditorScene extends Phaser.Scene {
  // Map data
  private floorData: number[][] = [];
  private wallsData: number[][] = [];
  private mapObjects: MapObject[] = [];
  private mapRows = 0;
  private mapCols = 0;

  // Tilemap layers
  private floorLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private wallsLayer: Phaser.Tilemaps.TilemapLayer | null = null;

  // Object sprites
  private objectSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();

  // Grid overlay
  private gridOverlay: Phaser.GameObjects.Graphics | null = null;

  // Spawn marker
  private spawnMarker: Phaser.GameObjects.Graphics | null = null;
  private spawnCol = 1;
  private spawnRow = 1;

  // Hover highlight
  private hoverGraphics: Phaser.GameObjects.Graphics | null = null;

  // Current tool state
  private currentTool: EditorTool = "paint";
  private activeLayer: EditorLayer = "floor";
  private selectedTile = 1; // floor tile by default
  private selectedObjectType = "desk";

  // Mouse state
  private isPainting = false;
  private isRightButtonDrag = false;
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private camStartX = 0;
  private camStartY = 0;

  // Bound event handlers (for cleanup)
  private boundHandlers: { event: string; fn: (...args: unknown[]) => void }[] = [];

  constructor() {
    super({ key: "EditorScene" });
  }

  create(): void {
    // Set up camera
    this.cameras.main.setBackgroundColor(0x1a1a2e);
    this.cameras.main.setRoundPixels(true);

    // Create graphics objects
    this.gridOverlay = this.add.graphics();
    this.hoverGraphics = this.add.graphics();
    this.spawnMarker = this.add.graphics();

    // Set up input
    this.setupInput();

    // Listen for EventBus events from React
    this.registerEventListeners();

    // Emit ready event on next frame — ensures create() is fully complete
    // and if scene is destroyed (React Strict Mode), the timer won't fire
    this.time.delayedCall(0, () => {
      EventBus.emit("editor:scene-ready");
    });
  }

  // ---------------------------------------------------------------------------
  // EventBus listeners
  // ---------------------------------------------------------------------------

  private registerEventListeners(): void {
    const listen = (event: string, fn: (...args: unknown[]) => void) => {
      EventBus.on(event, fn);
      this.boundHandlers.push({ event, fn });
    };

    listen("editor:load-map", (data: unknown) => {
      this.loadMap(data as EditorMapData);
    });

    listen("editor:set-tool", (data: unknown) => {
      const payload = data as { tool?: string } | string;
      const tool = typeof payload === "string" ? payload : (payload as { tool: string }).tool;
      if (tool) this.currentTool = tool as EditorTool;
    });

    listen("editor:set-layer", (data: unknown) => {
      const payload = data as { layer?: string } | string;
      const layer = typeof payload === "string" ? payload : (payload as { layer: string }).layer;
      if (layer === "objects") {
        // "Objects" layer in palette maps to "object" tool in Phaser
        this.currentTool = "object";
      } else if (layer === "floor" || layer === "walls") {
        this.activeLayer = layer;
        // Switch back to paint tool if coming from object mode
        if (this.currentTool === "object") {
          this.currentTool = "paint";
        }
      }
    });

    listen("editor:set-tile", (data: unknown) => {
      const payload = data as Record<string, unknown>;
      if (payload && typeof payload === "object") {
        if ("tileId" in payload && typeof payload.tileId === "number") {
          this.selectedTile = payload.tileId;
        }
        if ("objectType" in payload && typeof payload.objectType === "string") {
          this.selectedObjectType = payload.objectType;
        }
      } else if (typeof data === "number") {
        this.selectedTile = data;
      } else if (typeof data === "string") {
        this.selectedObjectType = data;
      }
    });

    listen("editor:update-tile", (data: unknown) => {
      const { layer, row, col, value } = data as { layer: EditorLayer; row: number; col: number; value: number };
      if (layer === "floor") {
        if (this.floorData[row]) this.floorData[row][col] = value;
      } else {
        if (this.wallsData[row]) this.wallsData[row][col] = value;
      }
      this.rebuildTilemap();
    });

    listen("editor:update-objects", (objects: unknown) => {
      this.mapObjects = objects as MapObject[];
      this.renderObjects();
    });

    listen("editor:set-spawn", (data: unknown) => {
      const { col, row } = data as { col: number; row: number };
      this.spawnCol = col;
      this.spawnRow = row;
      this.drawSpawnMarker();
    });

    listen("editor:resize-map", (data: unknown) => {
      const { cols: newCols, rows: newRows } = data as { cols: number; rows: number };
      this.resizeMap(newCols, newRows);
    });

    listen("editor:request-map-data", () => {
      EventBus.emit("editor:map-data-response", {
        layers: {
          floor: this.floorData,
          walls: this.wallsData,
        },
        objects: this.mapObjects,
        spawnCol: this.spawnCol,
        spawnRow: this.spawnRow,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Map loading
  // ---------------------------------------------------------------------------

  private loadMap(data: EditorMapData): void {
    // Guard: scene may have been destroyed (React Strict Mode double-mount)
    if (!this.cameras?.main) return;

    this.floorData = data.layers.floor.map((row) => [...row]);
    this.wallsData = data.layers.walls.map((row) => [...row]);
    this.mapObjects = data.objects ? [...data.objects] : [];
    this.mapRows = this.floorData.length;
    this.mapCols = this.floorData[0]?.length || 0;

    if (data.spawn) {
      this.spawnCol = data.spawn.col;
      this.spawnRow = data.spawn.row;
    }

    // Set camera bounds
    const mapWidth = this.mapCols * TILE_SIZE;
    const mapHeight = this.mapRows * TILE_SIZE;
    this.cameras.main.setBounds(-TILE_SIZE, -TILE_SIZE, mapWidth + TILE_SIZE * 2, mapHeight + TILE_SIZE * 2);

    // Center camera on map
    this.cameras.main.centerOn(mapWidth / 2, mapHeight / 2);

    this.rebuildTilemap();
    this.renderObjects();
    this.drawGrid();
    this.drawSpawnMarker();
  }

  // ---------------------------------------------------------------------------
  // Map resize
  // ---------------------------------------------------------------------------

  private resizeMap(newCols: number, newRows: number): void {
    const oldFloor = this.floorData;
    const oldWalls = this.wallsData;

    // Create new arrays
    const newFloor: number[][] = [];
    const newWalls: number[][] = [];

    for (let r = 0; r < newRows; r++) {
      const floorRow = new Array(newCols).fill(0);
      const wallsRow = new Array(newCols).fill(0);

      for (let c = 0; c < newCols; c++) {
        // Copy existing data where available
        if (r < this.mapRows && c < this.mapCols) {
          floorRow[c] = oldFloor[r][c];
          wallsRow[c] = oldWalls[r][c];
        } else {
          // New cells: floor inside, walls on edges
          const isEdge = r === 0 || r === newRows - 1 || c === 0 || c === newCols - 1;
          floorRow[c] = isEdge ? 0 : 1; // FLOOR for interior
          wallsRow[c] = isEdge ? 2 : 0; // WALL for edges
        }
      }

      newFloor.push(floorRow);
      newWalls.push(wallsRow);
    }

    // Update edges for existing area too (if map grew)
    for (let r = 0; r < newRows; r++) {
      for (let c = 0; c < newCols; c++) {
        const isEdge = r === 0 || r === newRows - 1 || c === 0 || c === newCols - 1;
        if (isEdge && newWalls[r][c] === 0) {
          newWalls[r][c] = 2; // Add wall on new edges
          newFloor[r][c] = 0; // Remove floor under new walls
        }
      }
    }

    // Filter out objects that are now outside bounds
    this.mapObjects = this.mapObjects.filter((obj) => {
      return obj.col < newCols && obj.row < newRows;
    });

    // Clamp spawn
    this.spawnCol = Math.min(this.spawnCol, newCols - 1);
    this.spawnRow = Math.min(this.spawnRow, newRows - 1);

    this.floorData = newFloor;
    this.wallsData = newWalls;
    this.mapCols = newCols;
    this.mapRows = newRows;

    // Update camera bounds
    const mapWidth = this.mapCols * TILE_SIZE;
    const mapHeight = this.mapRows * TILE_SIZE;
    this.cameras.main.setBounds(-TILE_SIZE, -TILE_SIZE, mapWidth + TILE_SIZE * 2, mapHeight + TILE_SIZE * 2);

    this.rebuildTilemap();
    this.renderObjects();
    this.drawGrid();
    this.drawSpawnMarker();

    EventBus.emit("editor:map-resized", { cols: newCols, rows: newRows, spawnCol: this.spawnCol, spawnRow: this.spawnRow });
  }

  // ---------------------------------------------------------------------------
  // Tilemap creation (same approach as GameScene)
  // ---------------------------------------------------------------------------

  private rebuildTilemap(): void {
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

  // ---------------------------------------------------------------------------
  // Object rendering (same formula as GameScene)
  // ---------------------------------------------------------------------------

  private renderObjects(): void {
    for (const sprite of this.objectSprites.values()) {
      sprite.destroy();
    }
    this.objectSprites.clear();

    for (const obj of this.mapObjects) {
      const def = OBJECT_TYPES[obj.type];
      if (!def) continue;
      const texKey = `obj-${obj.type}`;
      if (!this.textures.exists(texKey)) continue;

      const w = def.width || 1;
      const h = def.height || 1;
      const x = (obj.col + w / 2) * TILE_SIZE;
      const y = (obj.row + h) * TILE_SIZE;

      const sprite = this.add.sprite(x, y, texKey);
      sprite.setOrigin(0.5, 1);

      if (def.depthMode === "fixed") {
        sprite.setDepth(def.fixedDepth ?? 5);
      } else {
        sprite.setDepth(y);
      }

      this.objectSprites.set(obj.id, sprite);
    }
  }

  // ---------------------------------------------------------------------------
  // Grid overlay
  // ---------------------------------------------------------------------------

  private drawGrid(): void {
    if (!this.gridOverlay) return;
    this.gridOverlay.clear();
    this.gridOverlay.lineStyle(1, 0xffffff, 0.1);
    this.gridOverlay.setDepth(900);

    for (let c = 0; c <= this.mapCols; c++) {
      this.gridOverlay.lineBetween(c * TILE_SIZE, 0, c * TILE_SIZE, this.mapRows * TILE_SIZE);
    }
    for (let r = 0; r <= this.mapRows; r++) {
      this.gridOverlay.lineBetween(0, r * TILE_SIZE, this.mapCols * TILE_SIZE, r * TILE_SIZE);
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn marker
  // ---------------------------------------------------------------------------

  private drawSpawnMarker(): void {
    if (!this.spawnMarker) return;
    this.spawnMarker.clear();
    this.spawnMarker.setDepth(950);

    const cx = this.spawnCol * TILE_SIZE + TILE_SIZE / 2;
    const cy = this.spawnRow * TILE_SIZE + TILE_SIZE / 2;

    // Draw a green diamond
    this.spawnMarker.fillStyle(0x22cc44, 0.7);
    this.spawnMarker.fillTriangle(
      cx, cy - 12,
      cx + 10, cy,
      cx, cy + 12,
    );
    this.spawnMarker.fillTriangle(
      cx, cy - 12,
      cx - 10, cy,
      cx, cy + 12,
    );

    // Outline
    this.spawnMarker.lineStyle(2, 0x44ff66, 0.9);
    this.spawnMarker.strokeCircle(cx, cy, 14);
  }

  // ---------------------------------------------------------------------------
  // Input setup
  // ---------------------------------------------------------------------------

  private setupInput(): void {
    // Pointer down
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Middle mouse for panning
      if (pointer.middleButtonDown()) {
        this.isPanning = true;
        this.panStartX = pointer.x;
        this.panStartY = pointer.y;
        this.camStartX = this.cameras.main.scrollX;
        this.camStartY = this.cameras.main.scrollY;
        return;
      }

      // Left click
      if (pointer.leftButtonDown()) {
        this.isPainting = true;
        this.applyTool(pointer);
      }

      // Right click to erase
      if (pointer.rightButtonDown()) {
        this.isPainting = true;
        this.isRightButtonDrag = true;
        this.applyErase(pointer);
      }
    });

    // Pointer move
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      // Panning
      if (this.isPanning) {
        const dx = this.panStartX - pointer.x;
        const dy = this.panStartY - pointer.y;
        this.cameras.main.scrollX = this.camStartX + dx;
        this.cameras.main.scrollY = this.camStartY + dy;
        return;
      }

      // Hover highlight
      const coords = this.getGridCoords(pointer);
      if (coords) {
        this.drawHoverHighlight(coords.col, coords.row);
        EventBus.emit("editor:tile-hover", { col: coords.col, row: coords.row });
      }

      // Paint/place while dragging
      if (this.isPainting && (this.currentTool === "paint" || this.currentTool === "erase" || this.currentTool === "object")) {
        if (this.isRightButtonDrag) {
          this.applyErase(pointer);
        } else {
          this.applyTool(pointer);
        }
      }
    });

    // Pointer up
    this.input.on("pointerup", () => {
      this.isPainting = false;
      this.isRightButtonDrag = false;
      this.isPanning = false;
    });

    // Scroll wheel for zoom
    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _gx: number, _gy: number, _dx: number, dy: number) => {
      const cam = this.cameras.main;
      const newZoom = Phaser.Math.Clamp(cam.zoom + (dy > 0 ? -0.1 : 0.1), 0.25, 3);
      cam.setZoom(newZoom);
    });
  }

  // ---------------------------------------------------------------------------
  // Grid coordinate helpers
  // ---------------------------------------------------------------------------

  private getGridCoords(pointer: Phaser.Input.Pointer): { col: number; row: number } | null {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const col = Math.floor(worldPoint.x / TILE_SIZE);
    const row = Math.floor(worldPoint.y / TILE_SIZE);

    if (col < 0 || col >= this.mapCols || row < 0 || row >= this.mapRows) {
      return null;
    }
    return { col, row };
  }

  // ---------------------------------------------------------------------------
  // Hover highlight
  // ---------------------------------------------------------------------------

  private drawHoverHighlight(col: number, row: number): void {
    if (!this.hoverGraphics) return;
    this.hoverGraphics.clear();
    this.hoverGraphics.setDepth(910);

    if (this.currentTool === "object") {
      const def = OBJECT_TYPES[this.selectedObjectType];
      if (def) {
        const w = def.width || 1;
        const h = def.height || 1;
        const canPlace = canPlaceObject(this.selectedObjectType, col, row, this.mapObjects, this.wallsData);
        const color = canPlace ? 0x44ff44 : 0xff4444;
        this.hoverGraphics.lineStyle(2, color, 0.8);
        this.hoverGraphics.strokeRect(col * TILE_SIZE, row * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);
        this.hoverGraphics.fillStyle(color, 0.2);
        this.hoverGraphics.fillRect(col * TILE_SIZE, row * TILE_SIZE, w * TILE_SIZE, h * TILE_SIZE);
      }
    } else if (this.currentTool === "spawn") {
      this.hoverGraphics.lineStyle(2, 0x22cc44, 0.8);
      this.hoverGraphics.strokeRect(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      this.hoverGraphics.fillStyle(0x22cc44, 0.2);
      this.hoverGraphics.fillRect(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    } else {
      this.hoverGraphics.lineStyle(2, 0xffffff, 0.6);
      this.hoverGraphics.strokeRect(col * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool application
  // ---------------------------------------------------------------------------

  private applyTool(pointer: Phaser.Input.Pointer): void {
    const coords = this.getGridCoords(pointer);
    if (!coords) return;
    const { col, row } = coords;

    switch (this.currentTool) {
      case "paint":
        this.paintTile(col, row);
        break;
      case "erase":
        this.eraseTile(col, row);
        break;
      case "fill":
        this.floodFill(col, row);
        break;
      case "object":
        this.placeObject(col, row);
        break;
      case "spawn":
        this.setSpawn(col, row);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Erase via right-click (works regardless of current tool)
  // ---------------------------------------------------------------------------

  private applyErase(pointer: Phaser.Input.Pointer): void {
    const coords = this.getGridCoords(pointer);
    if (!coords) return;
    const { col, row } = coords;

    // If in object tool mode, remove object at position
    if (this.currentTool === "object") {
      const existingIdx = this.mapObjects.findIndex((obj) => {
        const def = OBJECT_TYPES[obj.type];
        if (!def) return false;
        const w = def.width || 1;
        const h = def.height || 1;
        return col >= obj.col && col < obj.col + w && row >= obj.row && row < obj.row + h;
      });
      if (existingIdx >= 0) {
        this.mapObjects.splice(existingIdx, 1);
        this.renderObjects();
        EventBus.emit("editor:objects-changed", [...this.mapObjects]);
      }
      return;
    }

    // Otherwise erase tile on active layer
    this.eraseTile(col, row);
  }

  // ---------------------------------------------------------------------------
  // Paint tile
  // ---------------------------------------------------------------------------

  private paintTile(col: number, row: number): void {
    const layer = this.activeLayer;
    const data = layer === "floor" ? this.floorData : this.wallsData;
    const oldValue = data[row]?.[col];

    if (oldValue === undefined || oldValue === this.selectedTile) return;

    data[row][col] = this.selectedTile;
    this.rebuildTilemap();

    EventBus.emit("editor:tile-changed", {
      layer,
      row,
      col,
      prev: oldValue,
      next: this.selectedTile,
    });
  }

  // ---------------------------------------------------------------------------
  // Erase tile
  // ---------------------------------------------------------------------------

  private eraseTile(col: number, row: number): void {
    const layer = this.activeLayer;
    const data = layer === "floor" ? this.floorData : this.wallsData;
    const oldValue = data[row]?.[col];

    if (oldValue === undefined || oldValue === 0) return;

    data[row][col] = 0;
    this.rebuildTilemap();

    EventBus.emit("editor:tile-changed", {
      layer,
      row,
      col,
      prev: oldValue,
      next: 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Flood fill (stack-based)
  // ---------------------------------------------------------------------------

  private floodFill(col: number, row: number): void {
    const layer = this.activeLayer;
    const data = layer === "floor" ? this.floorData : this.wallsData;
    const targetValue = data[row]?.[col];

    if (targetValue === undefined || targetValue === this.selectedTile) return;

    const changes: { row: number; col: number; oldValue: number }[] = [];
    const stack: [number, number][] = [[col, row]];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const [c, r] = stack.pop()!;
      const key = `${c},${r}`;

      if (visited.has(key)) continue;
      if (c < 0 || c >= this.mapCols || r < 0 || r >= this.mapRows) continue;
      if (data[r][c] !== targetValue) continue;

      visited.add(key);
      changes.push({ row: r, col: c, oldValue: targetValue });
      data[r][c] = this.selectedTile;

      stack.push([c + 1, r]);
      stack.push([c - 1, r]);
      stack.push([c, r + 1]);
      stack.push([c, r - 1]);
    }

    if (changes.length > 0) {
      this.rebuildTilemap();
      EventBus.emit("editor:fill-applied", {
        layer,
        changes,
        newValue: this.selectedTile,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Object placement / removal
  // ---------------------------------------------------------------------------

  private placeObject(col: number, row: number): void {
    // Check if there's already an object at this position — if so, remove it
    const existingIdx = this.mapObjects.findIndex((obj) => {
      const def = OBJECT_TYPES[obj.type];
      if (!def) return false;
      const w = def.width || 1;
      const h = def.height || 1;
      return col >= obj.col && col < obj.col + w && row >= obj.row && row < obj.row + h;
    });

    if (existingIdx >= 0) {
      // Remove existing object
      this.mapObjects.splice(existingIdx, 1);
      this.renderObjects();
      EventBus.emit("editor:objects-changed", [...this.mapObjects]);
      return;
    }

    // Try to place new object
    if (!canPlaceObject(this.selectedObjectType, col, row, this.mapObjects, this.wallsData)) {
      return;
    }

    const newObj: MapObject = {
      id: generateObjectId(),
      type: this.selectedObjectType,
      col,
      row,
    };

    this.mapObjects.push(newObj);
    this.renderObjects();
    EventBus.emit("editor:objects-changed", [...this.mapObjects]);
  }

  // ---------------------------------------------------------------------------
  // Spawn placement
  // ---------------------------------------------------------------------------

  private setSpawn(col: number, row: number): void {
    this.spawnCol = col;
    this.spawnRow = row;
    this.drawSpawnMarker();
    EventBus.emit("editor:spawn-changed", { col, row });
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    // Remove all EventBus listeners
    for (const { event, fn } of this.boundHandlers) {
      EventBus.off(event, fn);
    }
    this.boundHandlers = [];

    // Destroy sprites
    for (const sprite of this.objectSprites.values()) {
      sprite.destroy();
    }
    this.objectSprites.clear();

  }
}
