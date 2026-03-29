# Map Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a map editor page where users can create, edit, and delete map templates stored in the database, using a Phaser-based WYSIWYG tile painting interface.

**Architecture:** New `map_templates` DB table replaces hardcoded templates. Separate `/map-editor` pages with a Phaser `EditorScene` that reuses existing tile/object rendering. Channel creation page switches from hardcoded to DB-backed template selection.

**Tech Stack:** Next.js 16 App Router, Phaser 3, Drizzle ORM (PG + SQLite dual), Tailwind CSS, EventBus

**Spec:** `docs/superpowers/specs/2026-03-27-map-editor-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/schema.ts` (modify) | Add `mapTemplates` table definition |
| `src/db/schema-sqlite.ts` (modify) | Add SQLite `mapTemplates` table |
| `src/db/index.ts` (modify) | Export `mapTemplates` table |
| `src/lib/map-editor-utils.ts` | Blank map generation, validation helpers |
| `src/app/api/map-templates/route.ts` | GET (list), POST (create) |
| `src/app/api/map-templates/[id]/route.ts` | GET, PUT, DELETE |
| `scripts/seed-map-templates.ts` | Seed 3 built-in templates into DB |
| `src/game/scenes/EditorBootScene.ts` | Asset loading for editor (reuses BootScene logic) |
| `src/game/scenes/EditorScene.ts` | Phaser editor scene with grid, painting, EventBus |
| `src/game/editor-main.ts` | Phaser game config for editor mode |
| `src/components/MapEditorPhaser.tsx` | React wrapper for Phaser editor canvas |
| `src/components/MapEditorPalette.tsx` | Tile/object palette + tool selector |
| `src/components/MapEditorToolbar.tsx` | Bottom status bar (name, size, spawn, undo/redo) |
| `src/app/map-editor/page.tsx` | Template list page |
| `src/app/map-editor/[id]/page.tsx` | Editor page (edit existing) |
| `src/app/map-editor/new/page.tsx` | Editor page (create new) |

### Modified Files

| File | Change |
|------|--------|
| `src/app/channels/create/page.tsx` | Replace hardcoded template buttons with DB-fetched list |
| `src/app/api/channels/route.ts` | Replace `getMapTemplate()` with DB lookup by `mapTemplateId` |
| `scripts/setup-lite.js` | Add seed execution after schema push |

### Removed (after migration verified)

| File | Reason |
|------|--------|
| `src/lib/map-templates.ts` | Data migrated to DB via seed script |

---

## Task 1: DB Schema — Add `mapTemplates` Table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema-sqlite.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Add mapTemplates to PG schema**

Add after the `mapPortals` table definition in `src/db/schema.ts`:

```typescript
export const mapTemplates = pgTable("map_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  icon: varchar("icon", { length: 10 }).notNull().default("🗺️"),
  description: varchar("description", { length: 500 }),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: jsonb("layers").notNull(),
  objects: jsonb("objects").notNull().default([]),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
```

- [ ] **Step 2: Add mapTemplates to SQLite schema**

Add after the `mapPortals` table definition in `src/db/schema-sqlite.ts`:

```typescript
export const mapTemplates = sqliteTable("map_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("🗺️"),
  description: text("description"),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: text("layers").notNull(),
  objects: text("objects").notNull().default("[]"),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});
```

- [ ] **Step 3: Export mapTemplates from db/index.ts**

Add to `src/db/index.ts` after `export const tasks = activeSchema.tasks;`:

```typescript
export const mapTemplates = activeSchema.mapTemplates;
```

- [ ] **Step 4: Push schema to SQLite**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx drizzle-kit push --config=drizzle-sqlite.config.ts --force`

Expected: Schema pushed with new `map_templates` table created.

- [ ] **Step 5: Verify table exists**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsx -e "const Database = require('better-sqlite3'); const db = new Database('data/deskrpg.db'); console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='map_templates'\").get());"`

Expected: `{ name: 'map_templates' }`

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/schema-sqlite.ts src/db/index.ts
git commit -m "feat: add map_templates DB table (PG + SQLite)"
```

---

## Task 2: Seed Script — Migrate Hardcoded Templates to DB

**Files:**
- Create: `scripts/seed-map-templates.ts`
- Modify: `scripts/setup-lite.js`

- [ ] **Step 1: Create seed script**

Create `scripts/seed-map-templates.ts`:

```typescript
// scripts/seed-map-templates.ts — Seed built-in map templates into DB
import { getDb, mapTemplates, jsonForDb } from "../src/db";
import { MAP_TEMPLATES } from "../src/lib/map-templates";
import { eq } from "drizzle-orm";

async function seed() {
  const db = getDb();

  for (const template of Object.values(MAP_TEMPLATES)) {
    // Check if already seeded (by name match)
    const existing = await db
      .select({ id: mapTemplates.id })
      .from(mapTemplates)
      .where(eq(mapTemplates.name, template.name))
      .limit(1);

    if (existing.length > 0) {
      console.log(`[seed] Skipping "${template.name}" — already exists`);
      continue;
    }

    await db.insert(mapTemplates).values({
      name: template.name,
      icon: template.icon,
      description: template.description,
      cols: template.cols,
      rows: template.rows,
      layers: jsonForDb({ floor: template.layers.floor, walls: template.layers.walls }),
      objects: jsonForDb(template.objects),
      spawnCol: template.spawnCol,
      spawnRow: template.spawnRow,
      createdBy: null,
    });

    console.log(`[seed] Inserted template: "${template.name}"`);
  }

  console.log("[seed] Map templates seeded successfully");
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run seed script to verify**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && DB_TYPE=sqlite SQLITE_PATH=data/deskrpg.db npx tsx scripts/seed-map-templates.ts`

Expected:
```
[seed] Inserted template: "Office"
[seed] Inserted template: "Cafe"
[seed] Inserted template: "Classroom"
[seed] Map templates seeded successfully
```

- [ ] **Step 3: Update setup-lite.js to run seed after schema push**

In `scripts/setup-lite.js`, add after the schema push `try/catch` block (before the final `console.log` line):

```javascript
// 5. Seed built-in map templates
console.log("[setup] Seeding map templates...");
try {
  execFileSync("npx", ["tsx", "scripts/seed-map-templates.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DB_TYPE: "sqlite", SQLITE_PATH: "data/deskrpg.db" },
  });
} catch {
  console.warn("[setup] Seed failed (non-critical — templates can be added manually)");
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-map-templates.ts scripts/setup-lite.js
git commit -m "feat: add seed script for built-in map templates"
```

---

## Task 3: Map Editor Utilities

**Files:**
- Create: `src/lib/map-editor-utils.ts`

- [ ] **Step 1: Create utility module**

Create `src/lib/map-editor-utils.ts`:

```typescript
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
        // No floor under walls (except doors)
      } else {
        floorRow[c] = TILES.FLOOR;
      }
    }

    floor.push(floorRow);
    walls.push(wallsRow);
  }

  const spawnCol = Math.floor(cols / 2);
  const spawnRow = rows - 2; // One row above the door

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
  // Check spawn is not on a wall
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
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/map-editor-utils.ts
git commit -m "feat: add map editor utility functions"
```

---

## Task 4: API Routes — Map Template CRUD

**Files:**
- Create: `src/app/api/map-templates/route.ts`
- Create: `src/app/api/map-templates/[id]/route.ts`

- [ ] **Step 1: Create list + create route**

Create `src/app/api/map-templates/route.ts`:

```typescript
import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/internal-rpc";
import { validateMapTemplate } from "@/lib/map-editor-utils";
import { desc } from "drizzle-orm";

// GET /api/map-templates — list all templates (lightweight, no layers/objects)
export async function GET() {
  try {
    const rows = await db
      .select({
        id: mapTemplates.id,
        name: mapTemplates.name,
        icon: mapTemplates.icon,
        description: mapTemplates.description,
        cols: mapTemplates.cols,
        rows: mapTemplates.rows,
        createdAt: mapTemplates.createdAt,
      })
      .from(mapTemplates)
      .orderBy(desc(mapTemplates.createdAt));

    return NextResponse.json({ templates: rows });
  } catch (err) {
    console.error("Failed to list map templates:", err);
    return NextResponse.json({ error: "Failed to list templates" }, { status: 500 });
  }
}

// POST /api/map-templates — create new template
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { name, icon, description, cols, rows, layers, objects, spawnCol, spawnRow } = body;

    const validationError = validateMapTemplate({ name, cols, rows, layers, spawnCol, spawnRow });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const [template] = await db
      .insert(mapTemplates)
      .values({
        name: name.trim(),
        icon: icon || "🗺️",
        description: description?.trim() || null,
        cols,
        rows,
        layers: jsonForDb(layers),
        objects: jsonForDb(objects || []),
        spawnCol,
        spawnRow,
        createdBy: userId,
      })
      .returning();

    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    console.error("Failed to create map template:", err);
    return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create single-template CRUD route**

Create `src/app/api/map-templates/[id]/route.ts`:

```typescript
import { db, mapTemplates, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { validateMapTemplate } from "@/lib/map-editor-utils";

type Params = { params: Promise<{ id: string }> };

// GET /api/map-templates/:id — full template with layers and objects
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const [template] = await db
      .select()
      .from(mapTemplates)
      .where(eq(mapTemplates.id, id))
      .limit(1);

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({ template });
  } catch (err) {
    console.error("Failed to get map template:", err);
    return NextResponse.json({ error: "Failed to get template" }, { status: 500 });
  }
}

// PUT /api/map-templates/:id — update template
export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { name, icon, description, cols, rows, layers, objects, spawnCol, spawnRow } = body;

    const validationError = validateMapTemplate({ name, cols, rows, layers, spawnCol, spawnRow });
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const [updated] = await db
      .update(mapTemplates)
      .set({
        name: name.trim(),
        icon: icon || "🗺️",
        description: description?.trim() || null,
        cols,
        rows,
        layers: jsonForDb(layers),
        objects: jsonForDb(objects || []),
        spawnCol,
        spawnRow,
        updatedAt: new Date(),
      })
      .where(eq(mapTemplates.id, id))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({ template: updated });
  } catch (err) {
    console.error("Failed to update map template:", err);
    return NextResponse.json({ error: "Failed to update template" }, { status: 500 });
  }
}

// DELETE /api/map-templates/:id — delete template
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const deleted = await db
      .delete(mapTemplates)
      .where(eq(mapTemplates.id, id))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete map template:", err);
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify API works with dev server**

Start the dev server and test with curl:

```bash
# List templates (should return seeded office, cafe, classroom)
curl -s http://localhost:3001/api/map-templates | jq '.templates | length'
# Expected: 3
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/map-templates/route.ts src/app/api/map-templates/\[id\]/route.ts
git commit -m "feat: add map template CRUD API endpoints"
```

---

## Task 5: Phaser EditorScene

**Files:**
- Create: `src/game/scenes/EditorBootScene.ts`
- Create: `src/game/scenes/EditorScene.ts`
- Create: `src/game/editor-main.ts`

- [ ] **Step 1: Create EditorBootScene**

Create `src/game/scenes/EditorBootScene.ts` — reuses BootScene's tile generation:

```typescript
import { BootScene } from "./BootScene";

/**
 * EditorBootScene — loads the same tileset and object textures as BootScene,
 * then starts EditorScene instead of GameScene.
 */
export class EditorBootScene extends BootScene {
  constructor() {
    super();
    // Override the scene key
    (this as unknown as { sys: { settings: { key: string } } }).sys.settings.key = "EditorBootScene";
  }

  create(): void {
    // Reuse parent's asset generation (generates "office-tiles" and object textures)
    super.create();

    // BootScene.create() calls this.scene.start("GameScene") — we need to override.
    // Stop GameScene if it was started and start EditorScene instead
    this.scene.stop("GameScene");
    this.scene.start("EditorScene");
  }
}
```

Wait — BootScene.create() calls `this.scene.start("GameScene")` at the end, which we don't want. Let me re-check. Yes, line 322: `this.scene.start("GameScene");`. We need a different approach — extract the asset generation into a shared function, or just duplicate the minimal code.

Replace the above with a cleaner approach — extract the texture generation:

Create `src/game/scenes/EditorBootScene.ts`:

```typescript
import Phaser from "phaser";
import { generateObjectTextures } from "@/lib/object-textures";

// Import the drawTile function — it's not exported from BootScene,
// so we replicate the tileset generation here.
// BootScene generates a 512x32 "office-tiles" texture with 16 tiles.

const TILE = 32;

function drawTile(g: Phaser.GameObjects.Graphics, index: number): void {
  const x = index * TILE;
  switch (index) {
    case 0: break; // empty
    case 1: // floor
      g.fillStyle(0x8b8378); g.fillRect(x, 0, TILE, TILE);
      g.lineStyle(1, 0x7a7368, 0.3); g.strokeRect(x, 0, TILE, TILE);
      g.fillStyle(0x7f7a6e, 0.3);
      g.fillRect(x+6,6,2,2); g.fillRect(x+18,14,2,2); g.fillRect(x+10,24,2,2); g.fillRect(x+26,8,2,2);
      break;
    case 2: // wall
      g.fillStyle(0x4a4a5e); g.fillRect(x, 0, TILE, TILE);
      g.fillStyle(0x6a6a7e); g.fillRect(x, 0, TILE, 4);
      g.lineStyle(1, 0x3a3a4e, 0.4);
      g.lineBetween(x,16,x+TILE,16); g.lineBetween(x+16,4,x+16,16);
      g.lineBetween(x+8,16,x+8,TILE); g.lineBetween(x+24,16,x+24,TILE);
      g.lineStyle(1, 0x5a5a6e, 0.5); g.strokeRect(x, 0, TILE, TILE);
      break;
    case 7: // door
      g.fillStyle(0x8b8378); g.fillRect(x, 0, TILE, TILE);
      g.fillStyle(0x6b5a3a); g.fillRect(x+2, 0, 28, TILE);
      g.fillStyle(0x8b7a5a); g.fillRect(x+4, 2, 24, 28);
      g.fillStyle(0xd4af37); g.fillCircle(x+23, 18, 2);
      g.lineStyle(1, 0x7a6a4a, 0.5); g.strokeRect(x+6,4,9,12); g.strokeRect(x+17,4,9,12);
      break;
    case 12: // carpet
      g.fillStyle(0x6b6560); g.fillRect(x, 0, TILE, TILE);
      g.lineStyle(1, 0x5e5a55, 0.3); g.strokeRect(x, 0, TILE, TILE);
      g.fillStyle(0x625e58, 0.3);
      g.fillRect(x+4,4,3,3); g.fillRect(x+20,12,3,3); g.fillRect(x+12,22,3,3);
      break;
    default: {
      // For tiles 3-6, 8-11, 13-15: draw floor as base (these are object tiles in the tileset)
      g.fillStyle(0x8b8378); g.fillRect(x, 0, TILE, TILE);
      break;
    }
  }
}

export class EditorBootScene extends Phaser.Scene {
  constructor() {
    super({ key: "EditorBootScene" });
  }

  create(): void {
    const graphics = this.add.graphics();
    for (let i = 0; i < 16; i++) {
      drawTile(graphics, i);
    }
    graphics.generateTexture("office-tiles", 16 * TILE, TILE);
    graphics.destroy();

    generateObjectTextures(this);

    this.scene.start("EditorScene");
  }
}
```

- [ ] **Step 2: Create EditorScene**

Create `src/game/scenes/EditorScene.ts`:

```typescript
import Phaser from "phaser";
import { EventBus } from "../EventBus";
import type { MapObject } from "@/lib/object-types";
import { OBJECT_TYPES, generateObjectId, canPlaceObject, computeOccupiedTiles } from "@/lib/object-types";

const TILE_SIZE = 32;

type EditorTool = "paint" | "erase" | "fill" | "spawn";
type EditorLayer = "floor" | "walls" | "objects";

export class EditorScene extends Phaser.Scene {
  // Map data
  private floorData: number[][] = [];
  private wallsData: number[][] = [];
  private mapObjects: MapObject[] = [];
  private mapCols = 15;
  private mapRows = 11;
  private spawnCol = 7;
  private spawnRow = 9;

  // Rendering
  private floorLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private wallsLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private objectSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private gridOverlay: Phaser.GameObjects.Graphics | null = null;
  private hoverGraphics: Phaser.GameObjects.Graphics | null = null;
  private spawnMarker: Phaser.GameObjects.Graphics | null = null;

  // Editor state
  private currentTool: EditorTool = "paint";
  private currentLayer: EditorLayer = "floor";
  private selectedTileId = 1; // FLOOR
  private selectedObjectType = "desk";
  private isDragging = false;
  private lastDragCol = -1;
  private lastDragRow = -1;

  constructor() {
    super({ key: "EditorScene" });
  }

  create(): void {
    // Set world bounds
    this.cameras.main.setBounds(0, 0, this.mapCols * TILE_SIZE, this.mapRows * TILE_SIZE);

    // Listen for React events
    EventBus.on("editor:load-map", this.handleLoadMap.bind(this));
    EventBus.on("editor:set-tool", this.handleSetTool.bind(this));
    EventBus.on("editor:set-layer", this.handleSetLayer.bind(this));
    EventBus.on("editor:set-tile", this.handleSetTile.bind(this));
    EventBus.on("editor:update-tile", this.handleUpdateTile.bind(this));
    EventBus.on("editor:update-objects", this.handleUpdateObjects.bind(this));
    EventBus.on("editor:set-spawn", this.handleSetSpawn.bind(this));

    // Mouse events
    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("pointermove", this.onPointerMove, this);
    this.input.on("pointerup", this.onPointerUp, this);

    // Graphics
    this.gridOverlay = this.add.graphics().setDepth(100);
    this.hoverGraphics = this.add.graphics().setDepth(101);
    this.spawnMarker = this.add.graphics().setDepth(99);

    // Camera drag
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (pointer.middleButtonDown()) {
        this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
        this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
      }
    });

    // Zoom
    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _gx: number[], _gy: number[], _gz: number[], _gw: number, _gh: number, event: WheelEvent) => {
      const cam = this.cameras.main;
      const newZoom = Phaser.Math.Clamp(cam.zoom + (event.deltaY > 0 ? -0.1 : 0.1), 0.5, 3);
      cam.setZoom(newZoom);
    });

    // Tell React we're ready
    EventBus.emit("editor:scene-ready");
  }

  // --- Event handlers from React ---

  private handleLoadMap(data: { layers: { floor: number[][]; walls: number[][] }; objects: MapObject[]; cols: number; rows: number; spawnCol: number; spawnRow: number }): void {
    this.mapCols = data.cols;
    this.mapRows = data.rows;
    this.floorData = data.layers.floor;
    this.wallsData = data.layers.walls;
    this.mapObjects = data.objects || [];
    this.spawnCol = data.spawnCol;
    this.spawnRow = data.spawnRow;

    this.cameras.main.setBounds(0, 0, this.mapCols * TILE_SIZE, this.mapRows * TILE_SIZE);
    // Center camera
    this.cameras.main.centerOn((this.mapCols * TILE_SIZE) / 2, (this.mapRows * TILE_SIZE) / 2);

    this.createTilemap();
    this.renderObjects();
    this.drawGrid();
    this.drawSpawnMarker();
  }

  private handleSetTool(data: { tool: EditorTool }): void {
    this.currentTool = data.tool;
  }

  private handleSetLayer(data: { layer: EditorLayer }): void {
    this.currentLayer = data.layer;
  }

  private handleSetTile(data: { tileId?: number; objectType?: string }): void {
    if (data.tileId !== undefined) this.selectedTileId = data.tileId;
    if (data.objectType !== undefined) this.selectedObjectType = data.objectType;
  }

  private handleUpdateTile(data: { layer: string; col: number; row: number; value: number }): void {
    if (data.layer === "floor") {
      this.floorData[data.row][data.col] = data.value;
    } else {
      this.wallsData[data.row][data.col] = data.value;
    }
    this.createTilemap();
  }

  private handleUpdateObjects(data: { objects: MapObject[] }): void {
    this.mapObjects = data.objects;
    this.renderObjects();
  }

  private handleSetSpawn(data: { col: number; row: number }): void {
    this.spawnCol = data.col;
    this.spawnRow = data.row;
    this.drawSpawnMarker();
  }

  // --- Mouse interaction ---

  private getGridCoords(pointer: Phaser.Input.Pointer): { col: number; row: number } | null {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const col = Math.floor(worldPoint.x / TILE_SIZE);
    const row = Math.floor(worldPoint.y / TILE_SIZE);
    if (col < 0 || col >= this.mapCols || row < 0 || row >= this.mapRows) return null;
    return { col, row };
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (pointer.middleButtonDown()) return;
    const coords = this.getGridCoords(pointer);
    if (!coords) return;

    this.isDragging = true;
    this.lastDragCol = coords.col;
    this.lastDragRow = coords.row;
    this.applyTool(coords.col, coords.row, pointer.rightButtonDown());
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const coords = this.getGridCoords(pointer);
    if (!coords) {
      this.hoverGraphics?.clear();
      return;
    }

    // Hover highlight
    this.hoverGraphics?.clear();
    this.hoverGraphics?.lineStyle(2, 0x00ff00, 0.6);
    this.hoverGraphics?.strokeRect(coords.col * TILE_SIZE, coords.row * TILE_SIZE, TILE_SIZE, TILE_SIZE);

    EventBus.emit("editor:tile-hover", { col: coords.col, row: coords.row });

    // Drag painting
    if (this.isDragging && pointer.leftButtonDown() && (coords.col !== this.lastDragCol || coords.row !== this.lastDragRow)) {
      this.lastDragCol = coords.col;
      this.lastDragRow = coords.row;
      this.applyTool(coords.col, coords.row, false);
    }
  }

  private onPointerUp(): void {
    this.isDragging = false;
  }

  private applyTool(col: number, row: number, isRightClick: boolean): void {
    if (this.currentTool === "spawn") {
      // Set spawn point
      const prevCol = this.spawnCol;
      const prevRow = this.spawnRow;
      this.spawnCol = col;
      this.spawnRow = row;
      this.drawSpawnMarker();
      EventBus.emit("editor:spawn-changed", { col, row, prevCol, prevRow });
      return;
    }

    if (this.currentLayer === "objects") {
      this.applyObjectTool(col, row, isRightClick);
      return;
    }

    const isErase = this.currentTool === "erase" || isRightClick;

    if (this.currentTool === "fill" && !isErase) {
      this.floodFill(col, row);
      return;
    }

    // Paint or erase on tile layer
    const layer = this.currentLayer;
    const prevValue = layer === "floor" ? this.floorData[row][col] : this.wallsData[row][col];
    const newValue = isErase ? (layer === "floor" ? 1 : 0) : this.selectedTileId;

    if (prevValue === newValue) return;

    if (layer === "floor") {
      this.floorData[row][col] = newValue;
    } else {
      this.wallsData[row][col] = newValue;
    }

    this.createTilemap();
    EventBus.emit("editor:tile-changed", { layer, col, row, prev: prevValue, next: newValue });
  }

  private applyObjectTool(col: number, row: number, isRightClick: boolean): void {
    const isErase = this.currentTool === "erase" || isRightClick;

    if (isErase) {
      const idx = this.mapObjects.findIndex((o) => o.col === col && o.row === row);
      if (idx >= 0) {
        const prev = [...this.mapObjects];
        this.mapObjects.splice(idx, 1);
        this.renderObjects();
        EventBus.emit("editor:objects-changed", { prev, next: [...this.mapObjects] });
      }
      return;
    }

    // Place object
    if (!canPlaceObject(this.selectedObjectType, col, row, this.mapObjects, this.wallsData)) return;

    const prev = [...this.mapObjects];
    this.mapObjects.push({
      id: generateObjectId(),
      type: this.selectedObjectType,
      col,
      row,
    });
    this.renderObjects();
    EventBus.emit("editor:objects-changed", { prev, next: [...this.mapObjects] });
  }

  private floodFill(startCol: number, startRow: number): void {
    const layer = this.currentLayer === "floor" ? this.floorData : this.wallsData;
    const targetValue = layer[startRow][startCol];
    const fillValue = this.selectedTileId;
    if (targetValue === fillValue) return;

    const stack: [number, number][] = [[startCol, startRow]];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const [c, r] = stack.pop()!;
      const key = `${c},${r}`;
      if (visited.has(key)) continue;
      if (c < 0 || c >= this.mapCols || r < 0 || r >= this.mapRows) continue;
      if (layer[r][c] !== targetValue) continue;

      visited.add(key);
      layer[r][c] = fillValue;

      stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
    }

    this.createTilemap();
    EventBus.emit("editor:fill-applied", { layer: this.currentLayer, count: visited.size });
  }

  // --- Rendering ---

  private createTilemap(): void {
    if (this.floorLayer) { this.floorLayer.destroy(); this.floorLayer = null; }
    if (this.wallsLayer) { this.wallsLayer.destroy(); this.wallsLayer = null; }

    const floorMap = this.make.tilemap({ data: this.floorData, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    const floorTileset = floorMap.addTilesetImage("office-tiles", "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
    if (floorTileset) {
      this.floorLayer = floorMap.createLayer(0, floorTileset, 0, 0);
      this.floorLayer?.setDepth(0);
    }

    const wallsMap = this.make.tilemap({ data: this.wallsData, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    const wallsTileset = wallsMap.addTilesetImage("office-tiles", "office-tiles", TILE_SIZE, TILE_SIZE, 0, 0);
    if (wallsTileset) {
      this.wallsLayer = wallsMap.createLayer(0, wallsTileset, 0, 0);
      this.wallsLayer?.setDepth(1);
    }
  }

  private renderObjects(): void {
    for (const sprite of this.objectSprites.values()) sprite.destroy();
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

  private drawGrid(): void {
    if (!this.gridOverlay) return;
    this.gridOverlay.clear();
    this.gridOverlay.lineStyle(1, 0xffffff, 0.15);

    for (let c = 0; c <= this.mapCols; c++) {
      this.gridOverlay.lineBetween(c * TILE_SIZE, 0, c * TILE_SIZE, this.mapRows * TILE_SIZE);
    }
    for (let r = 0; r <= this.mapRows; r++) {
      this.gridOverlay.lineBetween(0, r * TILE_SIZE, this.mapCols * TILE_SIZE, r * TILE_SIZE);
    }
  }

  private drawSpawnMarker(): void {
    if (!this.spawnMarker) return;
    this.spawnMarker.clear();
    this.spawnMarker.lineStyle(2, 0xff4444, 0.8);
    this.spawnMarker.strokeRect(this.spawnCol * TILE_SIZE + 2, this.spawnRow * TILE_SIZE + 2, TILE_SIZE - 4, TILE_SIZE - 4);
    // Draw an X
    const cx = this.spawnCol * TILE_SIZE + TILE_SIZE / 2;
    const cy = this.spawnRow * TILE_SIZE + TILE_SIZE / 2;
    this.spawnMarker.lineBetween(cx - 6, cy - 6, cx + 6, cy + 6);
    this.spawnMarker.lineBetween(cx - 6, cy + 6, cx + 6, cy - 6);
  }

  // Cleanup
  destroy(): void {
    EventBus.removeAllListeners("editor:load-map");
    EventBus.removeAllListeners("editor:set-tool");
    EventBus.removeAllListeners("editor:set-layer");
    EventBus.removeAllListeners("editor:set-tile");
    EventBus.removeAllListeners("editor:update-tile");
    EventBus.removeAllListeners("editor:update-objects");
    EventBus.removeAllListeners("editor:set-spawn");
    super.destroy();
  }
}
```

- [ ] **Step 3: Create editor-main.ts**

Create `src/game/editor-main.ts`:

```typescript
import Phaser from "phaser";
import { EditorBootScene } from "./scenes/EditorBootScene";
import { EditorScene } from "./scenes/EditorScene";

export function createEditorGame(parent: string, width: number, height: number): Phaser.Game {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width,
    height,
    parent,
    backgroundColor: "#1a1a2e",
    pixelArt: true,
    banner: false,
    disableContextMenu: true,
    scene: [EditorBootScene, EditorScene],
    scale: {
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.NO_CENTER,
    },
  };

  return new Phaser.Game(config);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/game/scenes/EditorBootScene.ts src/game/scenes/EditorScene.ts src/game/editor-main.ts
git commit -m "feat: add Phaser EditorScene with tile painting and object placement"
```

---

## Task 6: React Map Editor Components

**Files:**
- Create: `src/components/MapEditorPhaser.tsx`
- Create: `src/components/MapEditorPalette.tsx`
- Create: `src/components/MapEditorToolbar.tsx`

- [ ] **Step 1: Create MapEditorPhaser component**

Create `src/components/MapEditorPhaser.tsx`:

```typescript
"use client";

import { useEffect, useRef } from "react";
import { EventBus } from "@/game/EventBus";
import type { MapObject } from "@/lib/object-types";

interface MapEditorPhaserProps {
  mapData: {
    layers: { floor: number[][]; walls: number[][] };
    objects: MapObject[];
  };
  cols: number;
  rows: number;
  spawnCol: number;
  spawnRow: number;
  onTileChanged?: (data: { layer: string; col: number; row: number; prev: number; next: number }) => void;
  onObjectsChanged?: (data: { prev: MapObject[]; next: MapObject[] }) => void;
  onSpawnChanged?: (data: { col: number; row: number; prevCol: number; prevRow: number }) => void;
  onFillApplied?: (data: { layer: string; count: number }) => void;
}

export default function MapEditorPhaser({
  mapData,
  cols,
  rows,
  spawnCol,
  spawnRow,
  onTileChanged,
  onObjectsChanged,
  onSpawnChanged,
  onFillApplied,
}: MapEditorPhaserProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const mapLoadedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    import("@/game/editor-main").then(({ createEditorGame }) => {
      const game = createEditorGame("map-editor-canvas", width, height);
      gameRef.current = game;

      EventBus.on("editor:scene-ready", () => {
        if (!mapLoadedRef.current) {
          mapLoadedRef.current = true;
          EventBus.emit("editor:load-map", {
            layers: mapData.layers,
            objects: mapData.objects,
            cols,
            rows,
            spawnCol,
            spawnRow,
          });
        }
      });
    });

    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
      mapLoadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for editor events → forward to React callbacks
  useEffect(() => {
    const handleTileChanged = (data: { layer: string; col: number; row: number; prev: number; next: number }) => onTileChanged?.(data);
    const handleObjectsChanged = (data: { prev: MapObject[]; next: MapObject[] }) => onObjectsChanged?.(data);
    const handleSpawnChanged = (data: { col: number; row: number; prevCol: number; prevRow: number }) => onSpawnChanged?.(data);
    const handleFill = (data: { layer: string; count: number }) => onFillApplied?.(data);

    EventBus.on("editor:tile-changed", handleTileChanged);
    EventBus.on("editor:objects-changed", handleObjectsChanged);
    EventBus.on("editor:spawn-changed", handleSpawnChanged);
    EventBus.on("editor:fill-applied", handleFill);

    return () => {
      EventBus.off("editor:tile-changed", handleTileChanged);
      EventBus.off("editor:objects-changed", handleObjectsChanged);
      EventBus.off("editor:spawn-changed", handleSpawnChanged);
      EventBus.off("editor:fill-applied", handleFill);
    };
  }, [onTileChanged, onObjectsChanged, onSpawnChanged, onFillApplied]);

  return (
    <div
      ref={containerRef}
      id="map-editor-canvas"
      className="w-full h-full bg-[#1a1a2e]"
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
```

- [ ] **Step 2: Create MapEditorPalette component**

Create `src/components/MapEditorPalette.tsx`:

```typescript
"use client";

import { EventBus } from "@/game/EventBus";
import { OBJECT_TYPE_LIST } from "@/lib/object-types";
import { FLOOR_PALETTE, WALL_PALETTE } from "@/lib/map-editor-utils";

type EditorTool = "paint" | "erase" | "fill" | "spawn";
type EditorLayer = "floor" | "walls" | "objects";

interface MapEditorPaletteProps {
  currentLayer: EditorLayer;
  currentTool: EditorTool;
  selectedTileId: number;
  selectedObjectType: string;
  onLayerChange: (layer: EditorLayer) => void;
  onToolChange: (tool: EditorTool) => void;
  onTileSelect: (tileId: number) => void;
  onObjectSelect: (objectType: string) => void;
}

export default function MapEditorPalette({
  currentLayer,
  currentTool,
  selectedTileId,
  selectedObjectType,
  onLayerChange,
  onToolChange,
  onTileSelect,
  onObjectSelect,
}: MapEditorPaletteProps) {
  const handleLayerChange = (layer: EditorLayer) => {
    onLayerChange(layer);
    EventBus.emit("editor:set-layer", { layer });
  };

  const handleToolChange = (tool: EditorTool) => {
    onToolChange(tool);
    EventBus.emit("editor:set-tool", { tool });
  };

  const handleTileSelect = (tileId: number) => {
    onTileSelect(tileId);
    EventBus.emit("editor:set-tile", { tileId });
  };

  const handleObjectSelect = (objectType: string) => {
    onObjectSelect(objectType);
    EventBus.emit("editor:set-tile", { objectType });
  };

  const palette = currentLayer === "floor" ? FLOOR_PALETTE : WALL_PALETTE;

  const layers: { id: EditorLayer; label: string }[] = [
    { id: "floor", label: "Floor" },
    { id: "walls", label: "Walls" },
    { id: "objects", label: "Objects" },
  ];

  const tools: { id: EditorTool; label: string; icon: string }[] = [
    { id: "paint", label: "Paint", icon: "✏️" },
    { id: "erase", label: "Erase", icon: "🧹" },
    { id: "fill", label: "Fill", icon: "▪️" },
    { id: "spawn", label: "Spawn", icon: "📍" },
  ];

  return (
    <div className="w-56 bg-surface border-r border-border flex flex-col p-3 gap-4 overflow-y-auto">
      {/* Layer Tabs */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">Layer</div>
        <div className="flex gap-1">
          {layers.map((l) => (
            <button
              key={l.id}
              onClick={() => handleLayerChange(l.id)}
              className={`flex-1 px-2 py-1.5 rounded text-xs font-semibold transition ${
                currentLayer === l.id
                  ? "bg-primary text-white"
                  : "bg-surface-raised text-text-muted hover:text-text"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tile/Object Palette */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">
          {currentLayer === "objects" ? "Objects" : "Tiles"}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {currentLayer === "objects"
            ? OBJECT_TYPE_LIST.map((obj) => (
                <button
                  key={obj.id}
                  onClick={() => handleObjectSelect(obj.id)}
                  className={`px-2 py-2 rounded text-xs text-left transition ${
                    selectedObjectType === obj.id
                      ? "bg-primary-muted border border-primary-light text-primary-light"
                      : "bg-surface-raised border border-border text-text-muted hover:text-text"
                  }`}
                >
                  {obj.name}
                </button>
              ))
            : palette.map((tile) => (
                <button
                  key={tile.id}
                  onClick={() => handleTileSelect(tile.id)}
                  className={`flex items-center gap-2 px-2 py-2 rounded text-xs transition ${
                    selectedTileId === tile.id
                      ? "bg-primary-muted border border-primary-light text-primary-light"
                      : "bg-surface-raised border border-border text-text-muted hover:text-text"
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded border border-border inline-block flex-shrink-0"
                    style={{ backgroundColor: tile.color }}
                  />
                  {tile.name}
                </button>
              ))}
        </div>
      </div>

      {/* Tools */}
      <div>
        <div className="text-xs font-semibold text-text-muted mb-2 uppercase">Tools</div>
        <div className="grid grid-cols-2 gap-1">
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => handleToolChange(t.id)}
              className={`flex items-center gap-1.5 px-2 py-2 rounded text-xs transition ${
                currentTool === t.id
                  ? "bg-primary-muted border border-primary-light text-primary-light"
                  : "bg-surface-raised border border-border text-text-muted hover:text-text"
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tips */}
      <div className="mt-auto text-[10px] text-text-dim space-y-1">
        <p>LMB: paint / RMB: erase</p>
        <p>MMB drag: pan camera</p>
        <p>Scroll: zoom</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create MapEditorToolbar component**

Create `src/components/MapEditorToolbar.tsx`:

```typescript
"use client";

interface MapEditorToolbarProps {
  name: string;
  cols: number;
  rows: number;
  spawnCol: number;
  spawnRow: number;
  hoverCol: number;
  hoverRow: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export default function MapEditorToolbar({
  name,
  cols,
  rows,
  spawnCol,
  spawnRow,
  hoverCol,
  hoverRow,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: MapEditorToolbarProps) {
  return (
    <div className="h-10 bg-surface border-t border-border flex items-center px-4 gap-6 text-xs text-text-muted">
      <span className="font-semibold text-text">{name}</span>
      <span>Size: {cols} x {rows}</span>
      <span>Spawn: ({spawnCol}, {spawnRow})</span>
      {hoverCol >= 0 && <span>Cursor: ({hoverCol}, {hoverRow})</span>}
      <div className="ml-auto flex gap-2">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="px-2 py-1 rounded bg-surface-raised border border-border disabled:opacity-30 hover:bg-surface"
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="px-2 py-1 rounded bg-surface-raised border border-border disabled:opacity-30 hover:bg-surface"
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/MapEditorPhaser.tsx src/components/MapEditorPalette.tsx src/components/MapEditorToolbar.tsx
git commit -m "feat: add React map editor components (palette, toolbar, Phaser wrapper)"
```

---

## Task 7: Map Editor Pages

**Files:**
- Create: `src/app/map-editor/page.tsx`
- Create: `src/app/map-editor/[id]/page.tsx`
- Create: `src/app/map-editor/new/page.tsx`

- [ ] **Step 1: Create template list page**

Create `src/app/map-editor/page.tsx`:

```typescript
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Edit, Trash2, Copy } from "lucide-react";

interface TemplateSummary {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  cols: number;
  rows: number;
  createdAt: string;
}

export default function MapEditorListPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then((data) => setTemplates(data.templates || []))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/map-templates/${id}`, { method: "DELETE" });
    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    }
  };

  const handleDuplicate = async (id: string) => {
    const res = await fetch(`/api/map-templates/${id}`);
    if (!res.ok) return;
    const { template } = await res.json();

    const createRes = await fetch("/api/map-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${template.name} (copy)`,
        icon: template.icon,
        description: template.description,
        cols: template.cols,
        rows: template.rows,
        layers: template.layers,
        objects: template.objects,
        spawnCol: template.spawnCol,
        spawnRow: template.spawnRow,
      }),
    });

    if (createRes.ok) {
      const { template: newTemplate } = await createRes.json();
      setTemplates((prev) => [newTemplate, ...prev]);
    }
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Map Templates</h1>
          <Link
            href="/map-editor/new"
            className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold text-sm"
          >
            <Plus className="w-4 h-4" />
            New Map
          </Link>
        </div>

        {loading ? (
          <div className="text-text-muted">Loading...</div>
        ) : templates.length === 0 ? (
          <div className="text-text-muted text-center py-12">
            No map templates yet. Create your first one!
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((t) => (
              <div
                key={t.id}
                className="bg-surface border border-border rounded-lg p-4 hover:border-primary-light transition"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <span className="text-xl mr-2">{t.icon}</span>
                    <span className="font-semibold">{t.name}</span>
                  </div>
                  <span className="text-xs text-text-dim">{t.cols}x{t.rows}</span>
                </div>
                {t.description && (
                  <p className="text-sm text-text-muted mb-3">{t.description}</p>
                )}
                <div className="flex gap-2 mt-auto">
                  <button
                    onClick={() => router.push(`/map-editor/${t.id}`)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light"
                  >
                    <Edit className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={() => handleDuplicate(t.id)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                  <button
                    onClick={() => handleDelete(t.id, t.name)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-danger text-danger"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create editor page for existing templates**

Create `src/app/map-editor/[id]/page.tsx`:

```typescript
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { EventBus } from "@/game/EventBus";
import type { MapObject } from "@/lib/object-types";
import { EditorHistory, type EditorAction } from "@/lib/map-editor-utils";
import MapEditorPalette from "@/components/MapEditorPalette";
import MapEditorToolbar from "@/components/MapEditorToolbar";
import { ArrowLeft, Save } from "lucide-react";

const MapEditorPhaser = dynamic(() => import("@/components/MapEditorPhaser"), { ssr: false });

type EditorTool = "paint" | "erase" | "fill" | "spawn";
type EditorLayer = "floor" | "walls" | "objects";

export default function MapEditorEditPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [icon, setIcon] = useState("🗺️");
  const [description, setDescription] = useState("");
  const [cols, setCols] = useState(15);
  const [rows, setRows] = useState(11);
  const [mapData, setMapData] = useState<{ layers: { floor: number[][]; walls: number[][] }; objects: MapObject[] } | null>(null);
  const [spawnCol, setSpawnCol] = useState(7);
  const [spawnRow, setSpawnRow] = useState(9);

  const [currentLayer, setCurrentLayer] = useState<EditorLayer>("floor");
  const [currentTool, setCurrentTool] = useState<EditorTool>("paint");
  const [selectedTileId, setSelectedTileId] = useState(1);
  const [selectedObjectType, setSelectedObjectType] = useState("desk");
  const [hoverCol, setHoverCol] = useState(-1);
  const [hoverRow, setHoverRow] = useState(-1);

  const historyRef = useRef(new EditorHistory());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const mapDataRef = useRef(mapData);
  mapDataRef.current = mapData;

  // Load template
  useEffect(() => {
    fetch(`/api/map-templates/${id}`)
      .then((r) => r.json())
      .then((data) => {
        const t = data.template;
        setTemplateName(t.name);
        setIcon(t.icon);
        setDescription(t.description || "");
        setCols(t.cols);
        setRows(t.rows);
        setSpawnCol(t.spawnCol);
        setSpawnRow(t.spawnRow);

        const layers = typeof t.layers === "string" ? JSON.parse(t.layers) : t.layers;
        const objects = typeof t.objects === "string" ? JSON.parse(t.objects) : t.objects;
        setMapData({ layers, objects });
      })
      .finally(() => setLoading(false));
  }, [id]);

  // History tracking
  const pushHistory = useCallback((action: EditorAction) => {
    historyRef.current.push(action);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
  }, []);

  const handleTileChanged = useCallback((data: { layer: string; col: number; row: number; prev: number; next: number }) => {
    pushHistory({ type: "tile", layer: data.layer as "floor" | "walls", col: data.col, row: data.row, prev: data.prev, next: data.next });
  }, [pushHistory]);

  const handleObjectsChanged = useCallback((data: { prev: MapObject[]; next: MapObject[] }) => {
    pushHistory({ type: "objects", prev: data.prev, next: data.next });
    setMapData((prev) => prev ? { ...prev, objects: data.next } : null);
  }, [pushHistory]);

  const handleSpawnChanged = useCallback((data: { col: number; row: number; prevCol: number; prevRow: number }) => {
    pushHistory({ type: "spawn", prev: { col: data.prevCol, row: data.prevRow }, next: { col: data.col, row: data.row } });
    setSpawnCol(data.col);
    setSpawnRow(data.row);
  }, [pushHistory]);

  const handleUndo = useCallback(() => {
    const action = historyRef.current.undo();
    if (!action) return;
    if (action.type === "tile") {
      EventBus.emit("editor:update-tile", { layer: action.layer, col: action.col, row: action.row, value: action.prev });
    } else if (action.type === "objects") {
      EventBus.emit("editor:update-objects", { objects: action.prev });
      setMapData((prev) => prev ? { ...prev, objects: action.prev } : null);
    } else if (action.type === "spawn") {
      EventBus.emit("editor:set-spawn", action.prev);
      setSpawnCol(action.prev.col);
      setSpawnRow(action.prev.row);
    }
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
  }, []);

  const handleRedo = useCallback(() => {
    const action = historyRef.current.redo();
    if (!action) return;
    if (action.type === "tile") {
      EventBus.emit("editor:update-tile", { layer: action.layer, col: action.col, row: action.row, value: action.next });
    } else if (action.type === "objects") {
      EventBus.emit("editor:update-objects", { objects: action.next });
      setMapData((prev) => prev ? { ...prev, objects: action.next } : null);
    } else if (action.type === "spawn") {
      EventBus.emit("editor:set-spawn", action.next);
      setSpawnCol(action.next.col);
      setSpawnRow(action.next.row);
    }
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  // Hover tracking
  useEffect(() => {
    const handler = (data: { col: number; row: number }) => {
      setHoverCol(data.col);
      setHoverRow(data.row);
    };
    EventBus.on("editor:tile-hover", handler);
    return () => { EventBus.off("editor:tile-hover", handler); };
  }, []);

  // Save
  const handleSave = async () => {
    setSaving(true);
    try {
      // Read current map data from the Phaser scene via a fresh snapshot
      // The mapData state is updated via callbacks, but floor/walls may have changed via direct painting
      // We'll trust the React state + EventBus-updated objects
      const res = await fetch(`/api/map-templates/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: templateName,
          icon,
          description,
          cols,
          rows,
          layers: mapDataRef.current?.layers,
          objects: mapDataRef.current?.objects || [],
          spawnCol,
          spawnRow,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || !mapData) {
    return (
      <div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">Loading...</div>
    );
  }

  return (
    <div className="theme-web h-screen flex flex-col bg-bg text-text">
      {/* Header */}
      <div className="h-12 bg-surface border-b border-border flex items-center px-4 gap-4">
        <button onClick={() => router.push("/map-editor")} className="text-text-muted hover:text-text">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <input
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          className="bg-transparent border-b border-border text-lg font-semibold focus:outline-none focus:border-primary-light px-1"
          placeholder="Map name"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="ml-auto flex items-center gap-2 px-4 py-1.5 bg-primary hover:bg-primary-hover rounded text-sm font-semibold disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        <MapEditorPalette
          currentLayer={currentLayer}
          currentTool={currentTool}
          selectedTileId={selectedTileId}
          selectedObjectType={selectedObjectType}
          onLayerChange={setCurrentLayer}
          onToolChange={setCurrentTool}
          onTileSelect={setSelectedTileId}
          onObjectSelect={setSelectedObjectType}
        />
        <div className="flex-1">
          <MapEditorPhaser
            mapData={mapData}
            cols={cols}
            rows={rows}
            spawnCol={spawnCol}
            spawnRow={spawnRow}
            onTileChanged={handleTileChanged}
            onObjectsChanged={handleObjectsChanged}
            onSpawnChanged={handleSpawnChanged}
          />
        </div>
      </div>

      {/* Bottom Toolbar */}
      <MapEditorToolbar
        name={templateName}
        cols={cols}
        rows={rows}
        spawnCol={spawnCol}
        spawnRow={spawnRow}
        hoverCol={hoverCol}
        hoverRow={hoverRow}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create new map page**

Create `src/app/map-editor/new/page.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { generateBlankMap, MAP_SIZE_MIN_COLS, MAP_SIZE_MAX_COLS, MAP_SIZE_MIN_ROWS, MAP_SIZE_MAX_ROWS } from "@/lib/map-editor-utils";

export default function MapEditorNewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🗺️");
  const [description, setDescription] = useState("");
  const [cols, setCols] = useState(15);
  const [rows, setRows] = useState(11);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    setSubmitting(true);
    setError("");

    const { mapData, spawnCol, spawnRow } = generateBlankMap(cols, rows);

    try {
      const res = await fetch("/api/map-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          icon,
          description: description.trim() || null,
          cols,
          rows,
          layers: mapData.layers,
          objects: mapData.objects,
          spawnCol,
          spawnRow,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Create failed");
        setSubmitting(false);
        return;
      }

      // Redirect to editor for the new template
      router.push(`/map-editor/${data.template.id}`);
    } catch {
      setError("Failed to create template");
      setSubmitting(false);
    }
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-md mx-auto">
        <h1 className="text-3xl font-bold mb-6">New Map Template</h1>

        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              placeholder="My Office Map"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1">Icon</label>
            <input
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={10}
              className="w-20 px-3 py-2 bg-surface border border-border rounded text-text text-center text-xl focus:outline-none focus:ring-2 focus:ring-primary-light"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light resize-none"
              placeholder="A description of the map"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-semibold mb-1">Width (cols)</label>
              <input
                type="number"
                value={cols}
                onChange={(e) => setCols(Math.max(MAP_SIZE_MIN_COLS, Math.min(MAP_SIZE_MAX_COLS, Number(e.target.value))))}
                min={MAP_SIZE_MIN_COLS}
                max={MAP_SIZE_MAX_COLS}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              />
              <span className="text-xs text-text-dim">{MAP_SIZE_MIN_COLS}–{MAP_SIZE_MAX_COLS}</span>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-semibold mb-1">Height (rows)</label>
              <input
                type="number"
                value={rows}
                onChange={(e) => setRows(Math.max(MAP_SIZE_MIN_ROWS, Math.min(MAP_SIZE_MAX_ROWS, Number(e.target.value))))}
                min={MAP_SIZE_MIN_ROWS}
                max={MAP_SIZE_MAX_ROWS}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              />
              <span className="text-xs text-text-dim">{MAP_SIZE_MIN_ROWS}–{MAP_SIZE_MAX_ROWS}</span>
            </div>
          </div>

          {error && <p className="text-danger text-sm">{error}</p>}

          <div className="flex items-center gap-4 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2 bg-primary hover:bg-primary-hover rounded font-semibold disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create & Edit"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/map-editor")}
              className="text-text-muted hover:text-text text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify pages render**

Start dev server and navigate to `http://localhost:3001/map-editor`. Verify:
- Template list loads with 3 seeded templates
- "New Map" button navigates to `/map-editor/new`
- Creating a new map redirects to `/map-editor/[id]` with Phaser canvas

- [ ] **Step 5: Commit**

```bash
git add src/app/map-editor/page.tsx src/app/map-editor/\[id\]/page.tsx src/app/map-editor/new/page.tsx
git commit -m "feat: add map editor pages (list, create, edit)"
```

---

## Task 8: Update Channel Creation to Use DB Templates

**Files:**
- Modify: `src/app/channels/create/page.tsx`
- Modify: `src/app/api/channels/route.ts`

- [ ] **Step 1: Update channel creation API**

In `src/app/api/channels/route.ts`:

Replace the import:
```typescript
// REMOVE: import { getMapTemplate } from "@/lib/map-templates";
```

Add import:
```typescript
import { mapTemplates } from "@/db";
import { eq } from "drizzle-orm";
```

Note: `eq` is already imported from `drizzle-orm` in this file, so just add `mapTemplates` to the `@/db` import.

Replace the template lookup in POST handler. Change:
```typescript
    const { name, description, isPublic, mapTemplate, password, gatewayConfig, defaultNpc } = body;
    ...
    const template = getMapTemplate(mapTemplate);
    if (!template) {
      return NextResponse.json({ error: "Invalid map template. Choose: office, cafe, classroom" }, { status: 400 });
    }
```

To:
```typescript
    const { name, description, isPublic, mapTemplateId, password, gatewayConfig, defaultNpc } = body;
    ...
    if (!mapTemplateId) {
      return NextResponse.json({ error: "mapTemplateId is required" }, { status: 400 });
    }

    const [template] = await db
      .select()
      .from(mapTemplates)
      .where(eq(mapTemplates.id, mapTemplateId))
      .limit(1);

    if (!template) {
      return NextResponse.json({ error: "Map template not found" }, { status: 404 });
    }

    // Parse layers/objects if stored as JSON string (SQLite)
    const templateLayers = typeof template.layers === "string" ? JSON.parse(template.layers) : template.layers;
    const templateObjects = typeof template.objects === "string" ? JSON.parse(template.objects) : template.objects;
```

Update the `db.insert(channels).values(...)` call to use the DB template fields:
```typescript
        mapData: jsonForDb({ layers: templateLayers, objects: templateObjects }),
        mapConfig: jsonForDb({ cols: template.cols, rows: template.rows, spawnCol: template.spawnCol, spawnRow: template.spawnRow }),
```

Update NPC position to use DB template:
```typescript
        const npcPositionX = template.spawnCol + 2;
        const npcPositionY = template.spawnRow;
```

- [ ] **Step 2: Update channel creation page**

In `src/app/channels/create/page.tsx`:

Replace the hardcoded template state and UI. Change:
```typescript
  const [mapTemplate, setMapTemplate] = useState("office");
```
To:
```typescript
  const [mapTemplateId, setMapTemplateId] = useState("");
  const [templateList, setTemplateList] = useState<{ id: string; name: string; icon: string; description: string | null; cols: number; rows: number }[]>([]);
```

Add useEffect to load templates:
```typescript
  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then((data) => {
        const templates = data.templates || [];
        setTemplateList(templates);
        if (templates.length > 0 && !mapTemplateId) {
          setMapTemplateId(templates[0].id);
        }
      });
  }, []);
```

Replace the template selection UI (the `{/* Map Template */}` section) with:
```typescript
          {/* Map Template */}
          <div>
            <label className="block text-sm font-semibold mb-2">{t("channels.create.mapTemplate")} *</label>
            <div className="grid grid-cols-3 gap-3">
              {templateList.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setMapTemplateId(tpl.id)}
                  className={`p-3 rounded-lg border text-center transition flex flex-col items-center ${
                    mapTemplateId === tpl.id
                      ? "border-primary-light bg-primary-muted text-primary-light"
                      : "border-border bg-surface hover:border-border text-text-muted"
                  }`}
                >
                  <div className="mb-1 text-xl">{tpl.icon}</div>
                  <div className="font-semibold text-sm text-white">{tpl.name}</div>
                  <div className="text-xs text-text-muted mt-1">{tpl.cols}x{tpl.rows}</div>
                </button>
              ))}
            </div>
          </div>
```

Remove the lucide-react icon imports `Building2, Coffee, GraduationCap` if no longer used elsewhere (keep `ChevronRight`).

In the `handleSubmit` payload, replace `mapTemplate` with `mapTemplateId`:
```typescript
        mapTemplateId,
```

- [ ] **Step 3: Verify channel creation works with DB templates**

Start dev server. Create a new channel. Verify it uses a template from the DB.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/channels/route.ts src/app/channels/create/page.tsx
git commit -m "feat: channel creation uses DB-backed map templates"
```

---

## Task 9: Cleanup — Remove Hardcoded Templates

**Files:**
- Remove: `src/lib/map-templates.ts` (after verifying all references are gone)
- Modify: `scripts/seed-map-templates.ts` (make self-contained)

- [ ] **Step 1: Check for remaining references to map-templates.ts**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && grep -r "map-templates" src/ --include="*.ts" --include="*.tsx" -l`

If only `scripts/seed-map-templates.ts` references it, proceed. If other files still import it, update them first.

- [ ] **Step 2: Make seed script self-contained**

The seed script currently imports from `src/lib/map-templates.ts`. Inline the template data into the seed script, or keep the import since the seed only runs once during setup. For simplicity, keep the file around as a data source for the seed only. Rename it:

```bash
mv src/lib/map-templates.ts scripts/map-template-data.ts
```

Update the seed script import:
```typescript
// In scripts/seed-map-templates.ts, change:
import { MAP_TEMPLATES } from "../src/lib/map-templates";
// To:
import { MAP_TEMPLATES } from "./map-template-data";
```

- [ ] **Step 3: Remove the import from channels API (already done in Task 8)**

Verify `src/app/api/channels/route.ts` no longer imports from `@/lib/map-templates`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: move hardcoded template data to scripts/ (seed-only)"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Full flow test**

1. `npm run setup:lite` — verify schema push + seed works
2. `npm run dev` — start dev server
3. Navigate to `/map-editor` — verify 3 templates listed
4. Click "New Map" → create a 20x15 map → verify editor opens
5. Paint floor, walls, place objects → save
6. Go back to list → verify new template appears
7. Edit, duplicate, delete templates
8. Navigate to `/channels/create` → verify templates loaded from DB
9. Create a channel with a template → verify map loads in game

- [ ] **Step 2: Commit any final fixes**

```bash
git add -A
git commit -m "feat: map editor complete — template CRUD, Phaser editor, DB migration"
```
