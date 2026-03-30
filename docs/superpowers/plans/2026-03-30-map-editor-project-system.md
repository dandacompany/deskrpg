# Map Editor Project System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a "Project" concept to the map editor so that maps, tilesets, and stamps persist across sessions via DB storage, replacing the current session-only + ZIP-based approach.

**Architecture:** New `projects` table stores map JSON and metadata. Junction tables `project_tilesets` and `project_stamps` link projects to globally shared assets. A ProjectBrowser component gates entry to the editor. All file-system dependencies removed; everything stored in DB as base64/JSON.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM (PG + SQLite dual schema), React, lucide-react icons, existing i18n system (`useT()`).

**Spec:** `docs/superpowers/specs/2026-03-30-map-editor-project-system-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/schema.ts` (modify) | Add `projects`, `projectTilesets`, `projectStamps` tables; add `builtIn`/`tags` to existing tables |
| `src/db/schema-sqlite.ts` (modify) | Same for SQLite dialect |
| `src/db/index.ts` (modify) | Export new tables |
| `src/app/api/projects/route.ts` | GET (list) + POST (create) |
| `src/app/api/projects/[id]/route.ts` | GET (detail) + PUT (save) + DELETE |
| `src/app/api/projects/[id]/duplicate/route.ts` | POST (duplicate project) |
| `src/app/api/projects/[id]/tilesets/route.ts` | POST (link tileset) |
| `src/app/api/projects/[id]/tilesets/[tilesetId]/route.ts` | DELETE (unlink tileset) |
| `src/app/api/projects/[id]/stamps/route.ts` | POST (link stamp) |
| `src/app/api/projects/[id]/stamps/[stampId]/route.ts` | DELETE (unlink stamp) |
| `src/components/map-editor/ProjectBrowser.tsx` | Project list, search, sort, card grid, create/duplicate/delete |
| `src/components/map-editor/NewProjectModal.tsx` | New project modal (name, map size, tile size) |
| `src/components/map-editor/hooks/useProjectManager.ts` | loadProject, saveProject, createProject hooks |

### Modified Files

| File | Changes |
|------|---------|
| `src/components/map-editor/MapEditorLayout.tsx` | Replace loadTemplate/handleSaveToDeskRPG with useProjectManager; show ProjectBrowser when no project loaded |
| `src/components/map-editor/Toolbar.tsx` | File menu: New Project, Open Project, Save, Save As |
| `src/components/map-editor/hooks/useMapEditor.ts` | Add `projectId` to EditorState and SET_MAP action |
| `src/components/map-editor/ImportTilesetModal.tsx` | Add 3-tab structure (Upload / My Tilesets / Built-in) |
| `src/components/map-editor/StampPanel.tsx` | Add 3-tab structure (Project / My Stamps / Built-in) |
| `src/app/api/tilesets/route.ts` | Add `builtIn` query filter |
| `src/app/api/stamps/route.ts` | Add `builtIn` query filter |
| `src/lib/i18n/locales/en.ts` | New i18n keys |
| `src/lib/i18n/locales/ko.ts` | New i18n keys |
| `src/lib/i18n/locales/ja.ts` | New i18n keys |
| `src/lib/i18n/locales/zh.ts` | New i18n keys |

---

## Task 1: DB Schema — New Tables + Column Additions

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/schema-sqlite.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Add projects table to PG schema**

In `src/db/schema.ts`, add after the `tilesetImages` table definition:

```typescript
// ── Projects ──────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  thumbnail: text("thumbnail"),
  tiledJson: jsonb("tiled_json"),
  settings: jsonb("settings"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const projectTilesets = pgTable("project_tilesets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tilesetId: uuid("tileset_id").notNull().references(() => tilesetImages.id, { onDelete: "cascade" }),
  firstgid: integer("firstgid").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("uq_project_tileset").on(t.projectId, t.tilesetId),
]);

export const projectStamps = pgTable("project_stamps", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stampId: uuid("stamp_id").notNull().references(() => stamps.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("uq_project_stamp").on(t.projectId, t.stampId),
]);
```

Also add `builtIn` and `tags` columns to `tilesetImages` and `stamps`:

```typescript
// In tilesetImages table, add after 'image':
builtIn: boolean("built_in").default(false).notNull(),
tags: text("tags"),

// In stamps table, add after 'createdBy':
builtIn: boolean("built_in").default(false).notNull(),
tags: text("tags"),
```

- [ ] **Step 2: Add projects table to SQLite schema**

In `src/db/schema-sqlite.ts`, add the same tables using SQLite types:

```typescript
// ── Projects ──────────────────────────────────────────────
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  thumbnail: text("thumbnail"),
  tiledJson: text("tiled_json"),
  settings: text("settings"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()).notNull(),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()).notNull(),
});

export const projectTilesets = sqliteTable("project_tilesets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tilesetId: text("tileset_id").notNull().references(() => tilesetImages.id, { onDelete: "cascade" }),
  firstgid: integer("firstgid").notNull(),
  addedAt: text("added_at").$defaultFn(() => new Date().toISOString()).notNull(),
}, (t) => [
  unique("uq_project_tileset").on(t.projectId, t.tilesetId),
]);

export const projectStamps = sqliteTable("project_stamps", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stampId: text("stamp_id").notNull().references(() => stamps.id, { onDelete: "cascade" }),
  addedAt: text("added_at").$defaultFn(() => new Date().toISOString()).notNull(),
}, (t) => [
  unique("uq_project_stamp").on(t.projectId, t.stampId),
]);
```

Also add `builtIn` and `tags` to `tilesetImages` and `stamps`:

```typescript
// In tilesetImages table:
builtIn: integer("built_in", { mode: "boolean" }).default(false).notNull(),
tags: text("tags"),

// In stamps table:
builtIn: integer("built_in", { mode: "boolean" }).default(false).notNull(),
tags: text("tags"),
```

- [ ] **Step 3: Export new tables from db/index.ts**

In `src/db/index.ts`, add after existing exports:

```typescript
export const projects = activeSchema.projects;
export const projectTilesets = activeSchema.projectTilesets;
export const projectStamps = activeSchema.projectStamps;
```

- [ ] **Step 4: Create SQLite tables manually**

Run the following SQL against the SQLite database:

```bash
cd /Users/dante/workspace/dante-code/projects/deskrpg
sqlite3 data/deskrpg.db <<'SQL'
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  thumbnail TEXT,
  tiled_json TEXT,
  settings TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_tilesets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tileset_id TEXT NOT NULL REFERENCES tileset_images(id) ON DELETE CASCADE,
  firstgid INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, tileset_id)
);

CREATE TABLE IF NOT EXISTS project_stamps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stamp_id TEXT NOT NULL REFERENCES stamps(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, stamp_id)
);

ALTER TABLE tileset_images ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tileset_images ADD COLUMN tags TEXT;
ALTER TABLE stamps ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stamps ADD COLUMN tags TEXT;
SQL
```

- [ ] **Step 5: Build to verify schema compiles**

```bash
npx next build 2>&1 | head -50
```

Expected: Build succeeds (or only pre-existing warnings).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/schema-sqlite.ts src/db/index.ts
git commit -m "feat(db): add projects, project_tilesets, project_stamps tables; add builtIn/tags to tilesets and stamps"
```

---

## Task 2: Projects CRUD API

**Files:**
- Create: `src/app/api/projects/route.ts`
- Create: `src/app/api/projects/[id]/route.ts`
- Create: `src/app/api/projects/[id]/duplicate/route.ts`

- [ ] **Step 1: Create GET/POST /api/projects**

Create `src/app/api/projects/route.ts`:

```typescript
import { db, projects, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";

// GET /api/projects — list projects (without tiledJson for performance)
export async function GET() {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      thumbnail: projects.thumbnail,
      settings: projects.settings,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt));

  const parsed = rows.map((r) => ({
    ...r,
    settings: typeof r.settings === "string" ? JSON.parse(r.settings) : r.settings,
  }));

  return NextResponse.json(parsed);
}

// POST /api/projects — create new project
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, tiledJson, settings } = body;

  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const [created] = await db
    .insert(projects)
    .values({
      name,
      tiledJson: jsonForDb(tiledJson),
      settings: jsonForDb(settings ?? {}),
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 2: Create GET/PUT/DELETE /api/projects/[id]**

Create `src/app/api/projects/[id]/route.ts`:

```typescript
import { db, projects, projectTilesets, projectStamps, tilesetImages, stamps, jsonForDb, isPostgres } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/projects/[id] — project detail with tilesets and stamps
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Load linked tilesets
  const tilesetRows = await db
    .select({
      id: tilesetImages.id,
      name: tilesetImages.name,
      tilewidth: tilesetImages.tilewidth,
      tileheight: tilesetImages.tileheight,
      columns: tilesetImages.columns,
      tilecount: tilesetImages.tilecount,
      image: tilesetImages.image,
      firstgid: projectTilesets.firstgid,
    })
    .from(projectTilesets)
    .innerJoin(tilesetImages, eq(projectTilesets.tilesetId, tilesetImages.id))
    .where(eq(projectTilesets.projectId, id));

  // Load linked stamps
  const stampRows = await db
    .select({
      id: stamps.id,
      name: stamps.name,
      cols: stamps.cols,
      rows: stamps.rows,
      thumbnail: stamps.thumbnail,
      layers: stamps.layers,
    })
    .from(projectStamps)
    .innerJoin(stamps, eq(projectStamps.stampId, stamps.id))
    .where(eq(projectStamps.projectId, id));

  const parsedProject = {
    ...project,
    tiledJson: typeof project.tiledJson === "string" ? JSON.parse(project.tiledJson) : project.tiledJson,
    settings: typeof project.settings === "string" ? JSON.parse(project.settings) : project.settings,
  };

  const parsedStamps = stampRows.map((s) => ({
    ...s,
    layers: typeof s.layers === "string" ? JSON.parse(s.layers) : s.layers,
    layerNames: (typeof s.layers === "string" ? JSON.parse(s.layers) : s.layers)?.map((l: { name: string }) => l.name) ?? [],
  }));

  return NextResponse.json({ project: parsedProject, tilesets: tilesetRows, stamps: parsedStamps });
}

// PUT /api/projects/[id] — save project
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { tiledJson, thumbnail, settings, name } = body;

  const updates: Record<string, unknown> = {
    updatedAt: isPostgres ? new Date() : new Date().toISOString(),
  };
  if (tiledJson !== undefined) updates.tiledJson = jsonForDb(tiledJson);
  if (thumbnail !== undefined) updates.thumbnail = thumbnail;
  if (settings !== undefined) updates.settings = jsonForDb(settings);
  if (name !== undefined) updates.name = name;

  await db.update(projects).set(updates).where(eq(projects.id, id));

  return NextResponse.json({ ok: true });
}

// DELETE /api/projects/[id] — delete project (cascade deletes junction rows)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(projects).where(eq(projects.id, id));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create POST /api/projects/[id]/duplicate**

Create `src/app/api/projects/[id]/duplicate/route.ts`:

```typescript
import { db, projects, projectTilesets, projectStamps, jsonForDb } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [original] = await db.select().from(projects).where(eq(projects.id, id));
  if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Create copy
  const [copy] = await db.insert(projects).values({
    name: `${original.name} (copy)`,
    thumbnail: original.thumbnail,
    tiledJson: original.tiledJson, // already in DB format
    settings: original.settings,
  }).returning();

  // Copy tileset links
  const tsLinks = await db.select().from(projectTilesets).where(eq(projectTilesets.projectId, id));
  for (const link of tsLinks) {
    await db.insert(projectTilesets).values({
      projectId: copy.id,
      tilesetId: link.tilesetId,
      firstgid: link.firstgid,
    });
  }

  // Copy stamp links
  const stLinks = await db.select().from(projectStamps).where(eq(projectStamps.projectId, id));
  for (const link of stLinks) {
    await db.insert(projectStamps).values({
      projectId: copy.id,
      stampId: link.stampId,
    });
  }

  return NextResponse.json(copy, { status: 201 });
}
```

- [ ] **Step 4: Build to verify API compiles**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/
git commit -m "feat(api): add projects CRUD + duplicate endpoints"
```

---

## Task 3: Project-Asset Linking APIs

**Files:**
- Create: `src/app/api/projects/[id]/tilesets/route.ts`
- Create: `src/app/api/projects/[id]/tilesets/[tilesetId]/route.ts`
- Create: `src/app/api/projects/[id]/stamps/route.ts`
- Create: `src/app/api/projects/[id]/stamps/[stampId]/route.ts`
- Modify: `src/app/api/tilesets/route.ts`
- Modify: `src/app/api/stamps/route.ts`

- [ ] **Step 1: Create POST /api/projects/[id]/tilesets**

Create `src/app/api/projects/[id]/tilesets/route.ts`:

```typescript
import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { tilesetId, firstgid } = await req.json();

  if (!tilesetId || firstgid == null) {
    return NextResponse.json({ error: "tilesetId and firstgid required" }, { status: 400 });
  }

  const [created] = await db.insert(projectTilesets).values({
    projectId,
    tilesetId,
    firstgid,
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 2: Create DELETE /api/projects/[id]/tilesets/[tilesetId]**

Create `src/app/api/projects/[id]/tilesets/[tilesetId]/route.ts`:

```typescript
import { db, projectTilesets } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; tilesetId: string }> }) {
  const { id: projectId, tilesetId } = await params;

  await db.delete(projectTilesets).where(
    and(eq(projectTilesets.projectId, projectId), eq(projectTilesets.tilesetId, tilesetId))
  );

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create POST /api/projects/[id]/stamps**

Create `src/app/api/projects/[id]/stamps/route.ts`:

```typescript
import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const { stampId } = await req.json();

  if (!stampId) {
    return NextResponse.json({ error: "stampId required" }, { status: 400 });
  }

  const [created] = await db.insert(projectStamps).values({
    projectId,
    stampId,
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 4: Create DELETE /api/projects/[id]/stamps/[stampId]**

Create `src/app/api/projects/[id]/stamps/[stampId]/route.ts`:

```typescript
import { db, projectStamps } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; stampId: string }> }) {
  const { id: projectId, stampId } = await params;

  await db.delete(projectStamps).where(
    and(eq(projectStamps.projectId, projectId), eq(projectStamps.stampId, stampId))
  );

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Add builtIn filter to GET /api/tilesets**

In `src/app/api/tilesets/route.ts`, modify the GET handler. When `builtIn` query param is present, filter by it:

```typescript
// At the top of GET handler, after getting name param:
const builtInParam = req.nextUrl.searchParams.get("builtIn");

// In the "list all" branch (when !name):
let query = db
  .select({ id: tilesetImages.id, name: tilesetImages.name, tilewidth: tilesetImages.tilewidth, tileheight: tilesetImages.tileheight, columns: tilesetImages.columns, tilecount: tilesetImages.tilecount, image: tilesetImages.image })
  .from(tilesetImages);

if (builtInParam === "true") {
  query = query.where(eq(tilesetImages.builtIn, true));
} else if (builtInParam === "false") {
  query = query.where(eq(tilesetImages.builtIn, false));
}
// else: return all

const rows = await query;
return NextResponse.json(rows);
```

Add `import { eq } from "drizzle-orm";` at top.

- [ ] **Step 6: Add builtIn filter to GET /api/stamps**

In `src/app/api/stamps/route.ts`, same pattern — add `builtIn` query param filter to the GET handler.

- [ ] **Step 7: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 8: Commit**

```bash
git add src/app/api/projects/ src/app/api/tilesets/route.ts src/app/api/stamps/route.ts
git commit -m "feat(api): add project-asset linking APIs; add builtIn filter to tilesets/stamps"
```

---

## Task 4: useMapEditor — Add projectId to State

**Files:**
- Modify: `src/components/map-editor/hooks/useMapEditor.ts`

- [ ] **Step 1: Add projectId to EditorState**

In `src/components/map-editor/hooks/useMapEditor.ts`, add `projectId` to the `EditorState` interface:

```typescript
// In EditorState interface, add after templateId:
projectId: string | null;
```

Add to initialState:

```typescript
// In initialState, add after templateId:
projectId: null,
```

- [ ] **Step 2: Update SET_MAP action type to accept projectId**

In the action union type, update the SET_MAP variant:

```typescript
| { type: 'SET_MAP'; mapData: TiledMap; projectName?: string; templateId?: string | null; projectId?: string | null }
```

In the reducer SET_MAP case, add:

```typescript
case 'SET_MAP': {
  const sortedGids = Object.keys(state.tilesetImages).map(Number).sort((a, b) => b - a);
  return {
    ...state,
    mapData: action.mapData,
    projectName: action.projectName ?? state.projectName,
    templateId: action.templateId !== undefined ? action.templateId : state.templateId,
    projectId: action.projectId !== undefined ? action.projectId : state.projectId,
    dirty: false,
    undoStack: [],
    redoStack: [],
    activeLayerIndex: 0,
    sortedGids,
  };
}
```

- [ ] **Step 3: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 4: Commit**

```bash
git add src/components/map-editor/hooks/useMapEditor.ts
git commit -m "feat(state): add projectId to EditorState and SET_MAP action"
```

---

## Task 5: useProjectManager Hook

**Files:**
- Create: `src/components/map-editor/hooks/useProjectManager.ts`

- [ ] **Step 1: Create the hook**

Create `src/components/map-editor/hooks/useProjectManager.ts`:

```typescript
import { useCallback } from "react";
import type { TiledMap } from "@/types/tiled";
import type { TilesetImageInfo } from "./useMapEditor";
import { createDefaultMap } from "./useMapEditor";

interface ProjectData {
  project: {
    id: string;
    name: string;
    tiledJson: TiledMap;
    thumbnail: string | null;
    settings: Record<string, unknown>;
  };
  tilesets: Array<{
    id: string;
    name: string;
    tilewidth: number;
    tileheight: number;
    columns: number;
    tilecount: number;
    image: string; // base64
    firstgid: number;
  }>;
  stamps: Array<{
    id: string;
    name: string;
    cols: number;
    rows: number;
    thumbnail: string | null;
    layerNames: string[];
  }>;
}

interface UseProjectManagerOptions {
  dispatch: (action: unknown) => void;
  addBuiltinTileset: (mapData: TiledMap) => void;
}

export function useProjectManager({ dispatch, addBuiltinTileset }: UseProjectManagerOptions) {
  const loadProject = useCallback(async (projectId: string): Promise<ProjectData | null> => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) return null;
    const data: ProjectData = await res.json();

    const { project, tilesets } = data;

    // Build tilesetImages from base64
    const tilesetImageMap: Record<number, TilesetImageInfo> = {};
    for (const ts of tilesets) {
      const img = new Image();
      img.src = ts.image;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load tileset: ${ts.name}`));
      });
      tilesetImageMap[ts.firstgid] = {
        img,
        firstgid: ts.firstgid,
        columns: ts.columns,
        tilewidth: ts.tilewidth,
        tileheight: ts.tileheight,
        tilecount: ts.tilecount,
        name: ts.name,
      };
    }

    // Set map data
    dispatch({ type: "SET_MAP", mapData: project.tiledJson, projectName: project.name, projectId: project.id, templateId: null });

    // Add tilesets
    for (const ts of tilesets) {
      dispatch({
        type: "ADD_TILESET",
        tileset: {
          firstgid: ts.firstgid,
          name: ts.name,
          tilewidth: ts.tilewidth,
          tileheight: ts.tileheight,
          tilecount: ts.tilecount,
          columns: ts.columns,
          image: ts.image,
          imagewidth: ts.columns * ts.tilewidth,
          imageheight: Math.ceil(ts.tilecount / ts.columns) * ts.tileheight,
        },
        imageInfo: tilesetImageMap[ts.firstgid],
      });
    }

    return data;
  }, [dispatch]);

  const saveProject = useCallback(async (
    projectId: string,
    mapData: TiledMap,
    thumbnail: string | null,
    settings?: Record<string, unknown>,
    name?: string,
  ) => {
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiledJson: mapData, thumbnail, settings, name }),
    });
    if (!res.ok) throw new Error("Save failed");
    dispatch({ type: "MARK_CLEAN" });
    return true;
  }, [dispatch]);

  const createProject = useCallback(async (
    name: string,
    cols: number,
    rows: number,
    tileWidth: number,
    tileHeight: number,
  ): Promise<string> => {
    const mapData = createDefaultMap(name, cols, rows, tileWidth);
    const settings = { cols, rows, tileWidth, tileHeight };

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, tiledJson: mapData, settings }),
    });
    if (!res.ok) throw new Error("Create failed");
    const created = await res.json();

    dispatch({ type: "SET_MAP", mapData, projectName: name, projectId: created.id, templateId: null });
    addBuiltinTileset(mapData);

    return created.id;
  }, [dispatch, addBuiltinTileset]);

  const linkTileset = useCallback(async (projectId: string, tilesetId: string, firstgid: number) => {
    await fetch(`/api/projects/${projectId}/tilesets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tilesetId, firstgid }),
    });
  }, []);

  const unlinkTileset = useCallback(async (projectId: string, tilesetId: string) => {
    await fetch(`/api/projects/${projectId}/tilesets/${tilesetId}`, { method: "DELETE" });
  }, []);

  const linkStamp = useCallback(async (projectId: string, stampId: string) => {
    await fetch(`/api/projects/${projectId}/stamps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stampId }),
    });
  }, []);

  const unlinkStamp = useCallback(async (projectId: string, stampId: string) => {
    await fetch(`/api/projects/${projectId}/stamps/${stampId}`, { method: "DELETE" });
  }, []);

  return { loadProject, saveProject, createProject, linkTileset, unlinkTileset, linkStamp, unlinkStamp };
}
```

- [ ] **Step 2: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/hooks/useProjectManager.ts
git commit -m "feat(hooks): add useProjectManager for project load/save/create"
```

---

## Task 6: i18n Keys for Project System

**Files:**
- Modify: `src/lib/i18n/locales/en.ts`
- Modify: `src/lib/i18n/locales/ko.ts`
- Modify: `src/lib/i18n/locales/ja.ts`
- Modify: `src/lib/i18n/locales/zh.ts`

- [ ] **Step 1: Add English keys**

Add to `src/lib/i18n/locales/en.ts` before the closing `};`:

```typescript
// Map Editor - Project System
"mapEditor.project.browserTitle": "My Projects",
"mapEditor.project.newProject": "New Project",
"mapEditor.project.openProject": "Open Project",
"mapEditor.project.saveAs": "Save As...",
"mapEditor.project.search": "Search projects...",
"mapEditor.project.sortName": "Name",
"mapEditor.project.sortRecent": "Recently Modified",
"mapEditor.project.sortCreated": "Created Date",
"mapEditor.project.noProjects": "No projects yet",
"mapEditor.project.noProjectsHint": "Create your first project to get started",
"mapEditor.project.duplicate": "Duplicate",
"mapEditor.project.confirmDelete": "Are you sure you want to delete this project?",
"mapEditor.project.modified": "Modified",
"mapEditor.project.projectName": "Project Name",
"mapEditor.project.mapSize": "Map Size",
"mapEditor.project.tileSize": "Tile Size",
"mapEditor.project.createProject": "Create Project",

// Map Editor - Asset Library Tabs
"mapEditor.assets.tabUpload": "Upload",
"mapEditor.assets.tabMyTilesets": "My Tilesets",
"mapEditor.assets.tabBuiltIn": "Built-in",
"mapEditor.assets.tabProject": "Project",
"mapEditor.assets.tabMyStamps": "My Stamps",
"mapEditor.assets.addToProject": "Add to Project",
"mapEditor.assets.removeFromProject": "Remove from Project",
"mapEditor.assets.noTilesets": "No tilesets available",
"mapEditor.assets.noStamps": "No stamps available",
```

- [ ] **Step 2: Add Korean keys**

Add to `src/lib/i18n/locales/ko.ts`:

```typescript
// Map Editor - Project System
"mapEditor.project.browserTitle": "내 프로젝트",
"mapEditor.project.newProject": "새 프로젝트",
"mapEditor.project.openProject": "프로젝트 열기",
"mapEditor.project.saveAs": "다른 이름으로 저장...",
"mapEditor.project.search": "프로젝트 검색...",
"mapEditor.project.sortName": "이름순",
"mapEditor.project.sortRecent": "최근 수정순",
"mapEditor.project.sortCreated": "생성일순",
"mapEditor.project.noProjects": "프로젝트가 없습니다",
"mapEditor.project.noProjectsHint": "새 프로젝트를 만들어보세요",
"mapEditor.project.duplicate": "복제",
"mapEditor.project.confirmDelete": "이 프로젝트를 삭제하시겠습니까?",
"mapEditor.project.modified": "수정일",
"mapEditor.project.projectName": "프로젝트 이름",
"mapEditor.project.mapSize": "맵 크기",
"mapEditor.project.tileSize": "타일 크기",
"mapEditor.project.createProject": "프로젝트 생성",

// Map Editor - Asset Library Tabs
"mapEditor.assets.tabUpload": "업로드",
"mapEditor.assets.tabMyTilesets": "내 타일셋",
"mapEditor.assets.tabBuiltIn": "빌트인",
"mapEditor.assets.tabProject": "프로젝트",
"mapEditor.assets.tabMyStamps": "내 스탬프",
"mapEditor.assets.addToProject": "프로젝트에 추가",
"mapEditor.assets.removeFromProject": "프로젝트에서 제거",
"mapEditor.assets.noTilesets": "타일셋이 없습니다",
"mapEditor.assets.noStamps": "스탬프가 없습니다",
```

- [ ] **Step 3: Add Japanese keys**

Add to `src/lib/i18n/locales/ja.ts`:

```typescript
// Map Editor - Project System
"mapEditor.project.browserTitle": "マイプロジェクト",
"mapEditor.project.newProject": "新規プロジェクト",
"mapEditor.project.openProject": "プロジェクトを開く",
"mapEditor.project.saveAs": "名前を付けて保存...",
"mapEditor.project.search": "プロジェクトを検索...",
"mapEditor.project.sortName": "名前順",
"mapEditor.project.sortRecent": "最近の変更順",
"mapEditor.project.sortCreated": "作成日順",
"mapEditor.project.noProjects": "プロジェクトがありません",
"mapEditor.project.noProjectsHint": "最初のプロジェクトを作成しましょう",
"mapEditor.project.duplicate": "複製",
"mapEditor.project.confirmDelete": "このプロジェクトを削除しますか？",
"mapEditor.project.modified": "変更日",
"mapEditor.project.projectName": "プロジェクト名",
"mapEditor.project.mapSize": "マップサイズ",
"mapEditor.project.tileSize": "タイルサイズ",
"mapEditor.project.createProject": "プロジェクト作成",

// Map Editor - Asset Library Tabs
"mapEditor.assets.tabUpload": "アップロード",
"mapEditor.assets.tabMyTilesets": "マイタイルセット",
"mapEditor.assets.tabBuiltIn": "ビルトイン",
"mapEditor.assets.tabProject": "プロジェクト",
"mapEditor.assets.tabMyStamps": "マイスタンプ",
"mapEditor.assets.addToProject": "プロジェクトに追加",
"mapEditor.assets.removeFromProject": "プロジェクトから削除",
"mapEditor.assets.noTilesets": "タイルセットがありません",
"mapEditor.assets.noStamps": "スタンプがありません",
```

- [ ] **Step 4: Add Chinese keys**

Add to `src/lib/i18n/locales/zh.ts`:

```typescript
// Map Editor - Project System
"mapEditor.project.browserTitle": "我的项目",
"mapEditor.project.newProject": "新建项目",
"mapEditor.project.openProject": "打开项目",
"mapEditor.project.saveAs": "另存为...",
"mapEditor.project.search": "搜索项目...",
"mapEditor.project.sortName": "按名称",
"mapEditor.project.sortRecent": "最近修改",
"mapEditor.project.sortCreated": "创建日期",
"mapEditor.project.noProjects": "暂无项目",
"mapEditor.project.noProjectsHint": "创建您的第一个项目",
"mapEditor.project.duplicate": "复制",
"mapEditor.project.confirmDelete": "确定要删除此项目吗？",
"mapEditor.project.modified": "修改时间",
"mapEditor.project.projectName": "项目名称",
"mapEditor.project.mapSize": "地图大小",
"mapEditor.project.tileSize": "图块大小",
"mapEditor.project.createProject": "创建项目",

// Map Editor - Asset Library Tabs
"mapEditor.assets.tabUpload": "上传",
"mapEditor.assets.tabMyTilesets": "我的图块集",
"mapEditor.assets.tabBuiltIn": "内置",
"mapEditor.assets.tabProject": "项目",
"mapEditor.assets.tabMyStamps": "我的图章",
"mapEditor.assets.addToProject": "添加到项目",
"mapEditor.assets.removeFromProject": "从项目移除",
"mapEditor.assets.noTilesets": "没有可用的图块集",
"mapEditor.assets.noStamps": "没有可用的图章",
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/locales/
git commit -m "feat(i18n): add project system and asset library tab translations (en/ko/ja/zh)"
```

---

## Task 7: NewProjectModal Component

**Files:**
- Create: `src/components/map-editor/NewProjectModal.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/map-editor/NewProjectModal.tsx`:

```typescript
"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import Modal from "@/components/ui/Modal";

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => void;
}

const TEMPLATES = [
  { label: "Small", cols: 20, rows: 15, desc: "640×480 px" },
  { label: "Medium", cols: 30, rows: 22, desc: "960×704 px" },
  { label: "Large", cols: 40, rows: 30, desc: "1280×960 px" },
];

export default function NewProjectModal({ open, onClose, onSubmit }: NewProjectModalProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [cols, setCols] = useState(20);
  const [rows, setRows] = useState(15);
  const [tileSize, setTileSize] = useState(32);

  const handleCreate = () => {
    if (!name.trim()) return;
    onSubmit(name.trim(), cols, rows, tileSize, tileSize);
    setName("");
    setCols(20);
    setRows(15);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={t("mapEditor.project.newProject")}>
      <div className="space-y-4 p-4">
        {/* Project Name */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.projectName")}
          </label>
          <input
            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("mapEditor.newMap.namePlaceholder")}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>

        {/* Template Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.mapSize")}
          </label>
          <div className="flex gap-2">
            {TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.label}
                className={`flex-1 px-3 py-2 rounded text-xs border ${
                  cols === tmpl.cols && rows === tmpl.rows
                    ? "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-gray-600 bg-gray-800 text-gray-400 hover:border-gray-500"
                }`}
                onClick={() => { setCols(tmpl.cols); setRows(tmpl.rows); }}
              >
                <div className="font-medium">{tmpl.label}</div>
                <div className="text-gray-500">{tmpl.desc}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-4 mt-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t("mapEditor.newMap.width")}:</span>
              <input
                type="number"
                className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs"
                value={cols}
                onChange={(e) => setCols(Math.max(1, parseInt(e.target.value) || 1))}
                min={1}
                max={200}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t("mapEditor.newMap.height")}:</span>
              <input
                type="number"
                className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs"
                value={rows}
                onChange={(e) => setRows(Math.max(1, parseInt(e.target.value) || 1))}
                min={1}
                max={200}
              />
            </div>
          </div>
        </div>

        {/* Tile Size */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.tileSize")}
          </label>
          <div className="flex gap-2">
            {[16, 32, 48, 64].map((size) => (
              <button
                key={size}
                className={`px-3 py-1 rounded text-xs border ${
                  tileSize === size
                    ? "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-gray-600 bg-gray-800 text-gray-400 hover:border-gray-500"
                }`}
                onClick={() => setTileSize(size)}
              >
                {size}×{size}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            className="px-4 py-2 text-sm text-gray-400 hover:text-white"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
            onClick={handleCreate}
            disabled={!name.trim()}
          >
            {t("mapEditor.project.createProject")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/NewProjectModal.tsx
git commit -m "feat(ui): add NewProjectModal component"
```

---

## Task 8: ProjectBrowser Component

**Files:**
- Create: `src/components/map-editor/ProjectBrowser.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/map-editor/ProjectBrowser.tsx`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { Plus, Copy, Trash2, Search } from "lucide-react";
import NewProjectModal from "./NewProjectModal";

interface ProjectItem {
  id: string;
  name: string;
  thumbnail: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type SortKey = "name" | "updatedAt" | "createdAt";

interface ProjectBrowserProps {
  onOpenProject: (projectId: string) => void;
  onCreateProject: (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => void;
}

export default function ProjectBrowser({ onOpenProject, onCreateProject }: ProjectBrowserProps) {
  const t = useT();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("updatedAt");
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      if (res.ok) setProjects(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const filtered = projects
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "updatedAt") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const handleDuplicate = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await fetch(`/api/projects/${id}/duplicate`, { method: "POST" });
    fetchProjects();
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm(t("mapEditor.project.confirmDelete"))) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    fetchProjects();
  };

  const handleCreate = (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => {
    setShowNewProject(false);
    onCreateProject(name, cols, rows, tileWidth, tileHeight);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
        <h1 className="text-xl font-bold">{t("mapEditor.project.browserTitle")}</h1>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm"
          onClick={() => setShowNewProject(true)}
        >
          <Plus size={16} />
          {t("mapEditor.project.newProject")}
        </button>
      </div>

      {/* Search + Sort */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500"
            placeholder={t("mapEditor.project.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
        >
          <option value="updatedAt">{t("mapEditor.project.sortRecent")}</option>
          <option value="name">{t("mapEditor.project.sortName")}</option>
          <option value="createdAt">{t("mapEditor.project.sortCreated")}</option>
        </select>
      </div>

      {/* Project Grid */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500">
            <p className="text-lg">{t("mapEditor.project.noProjects")}</p>
            <p className="text-sm mt-1">{t("mapEditor.project.noProjectsHint")}</p>
            <button
              className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm"
              onClick={() => setShowNewProject(true)}
            >
              <Plus size={16} />
              {t("mapEditor.project.newProject")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map((project) => (
              <div
                key={project.id}
                className="group relative bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 cursor-pointer transition-colors overflow-hidden"
                onClick={() => onOpenProject(project.id)}
              >
                {/* Thumbnail */}
                <div className="aspect-video bg-gray-900 flex items-center justify-center">
                  {project.thumbnail ? (
                    <img src={project.thumbnail} alt={project.name} className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-gray-600 text-xs">No preview</div>
                  )}
                </div>
                {/* Info */}
                <div className="p-3">
                  <div className="text-sm font-medium truncate">{project.name}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {t("mapEditor.project.modified")}: {formatDate(project.updatedAt)}
                  </div>
                </div>
                {/* Hover Actions */}
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    className="p-1.5 bg-gray-700/80 rounded hover:bg-gray-600 text-gray-300"
                    onClick={(e) => handleDuplicate(e, project.id)}
                    title={t("mapEditor.project.duplicate")}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="p-1.5 bg-gray-700/80 rounded hover:bg-red-600 text-gray-300"
                    onClick={(e) => handleDelete(e, project.id)}
                    title={t("common.delete")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <NewProjectModal
        open={showNewProject}
        onClose={() => setShowNewProject(false)}
        onSubmit={handleCreate}
      />
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/ProjectBrowser.tsx
git commit -m "feat(ui): add ProjectBrowser component with search, sort, duplicate, delete"
```

---

## Task 9: MapEditorLayout Integration

**Files:**
- Modify: `src/components/map-editor/MapEditorLayout.tsx`

This task integrates the project system into MapEditorLayout. The key changes are:

1. Show `ProjectBrowser` when no project is loaded
2. Replace `loadTemplate` with `useProjectManager.loadProject`
3. Replace `handleSaveToDeskRPG` with `useProjectManager.saveProject`
4. Replace `handleNewMap` with project creation flow
5. Remove `buildProjectZip` import and usage

- [ ] **Step 1: Add imports and useProjectManager hook**

At top of MapEditorLayout.tsx, add imports:

```typescript
import ProjectBrowser from "./ProjectBrowser";
import NewProjectModal from "./NewProjectModal";
import { useProjectManager } from "./hooks/useProjectManager";
```

Remove imports:
```typescript
// REMOVE: import { buildProjectZip, loadProjectZip } from "@/lib/map-project";
// REMOVE: import NewMapModal from "./NewMapModal";
```

Inside the component, add the hook call after `useMapEditor`:

```typescript
const { loadProject, saveProject, createProject, linkTileset, linkStamp } = useProjectManager({
  dispatch,
  addBuiltinTileset,
});
```

- [ ] **Step 2: Add project-loaded state and ProjectBrowser rendering**

Add state:
```typescript
const [projectLoaded, setProjectLoaded] = useState(false);
const [projectStamps, setProjectStamps] = useState<StampListItem[]>([]);
```

In the render, wrap the existing editor UI:

```typescript
// If no project loaded, show ProjectBrowser
if (!projectLoaded) {
  return (
    <ProjectBrowser
      onOpenProject={async (projectId) => {
        const data = await loadProject(projectId);
        if (data) {
          setStamps(data.stamps);
          setProjectStamps(data.stamps);
          setProjectLoaded(true);
        }
      }}
      onCreateProject={async (name, cols, rows, tw, th) => {
        await createProject(name, cols, rows, tw, th);
        setProjectLoaded(true);
      }}
    />
  );
}

// ... existing editor JSX
```

- [ ] **Step 3: Replace handleSaveToDeskRPG**

Replace the existing `handleSaveToDeskRPG` callback with:

```typescript
const handleSave = useCallback(async () => {
  if (!state.mapData || !state.projectId) return;
  try {
    // Generate thumbnail from canvas
    const canvasEl = document.querySelector<HTMLCanvasElement>("#map-canvas");
    const thumbnail = canvasEl ? canvasEl.toDataURL("image/png", 0.5) : null;

    await saveProject(state.projectId, state.mapData, thumbnail, undefined, state.projectName);
  } catch (err) {
    console.error("Save failed:", err);
    alert("Failed to save. Please try again.");
  }
}, [state.mapData, state.projectId, state.projectName, saveProject]);
```

- [ ] **Step 4: Update Toolbar props**

Change Toolbar `onSaveToDeskRPG` → `onSave` (or just pass the new `handleSave`):

```typescript
<Toolbar
  // ... existing props
  onNewMap={() => { setProjectLoaded(false); }}
  onLoad={() => { setProjectLoaded(false); }}
  onSaveToDeskRPG={handleSave}
  // ... rest
/>
```

- [ ] **Step 5: Remove buildProjectZip and loadTemplate usage**

Delete the entire `loadTemplate` function body and the `buildProjectZip` import/calls. Remove the `useEffect` that calls `loadTemplate(initialTemplateId)` — the project system replaces this flow entirely.

Remove `handleFileSelected` and `handleLoad` if they depend on ZIP loading. Keep export functions (TMJ/TMX/PNG) as they are.

- [ ] **Step 6: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 7: Commit**

```bash
git add src/components/map-editor/MapEditorLayout.tsx
git commit -m "feat(editor): integrate project system — ProjectBrowser, DB save, remove ZIP"
```

---

## Task 10: Toolbar — Update File Menu

**Files:**
- Modify: `src/components/map-editor/Toolbar.tsx`

- [ ] **Step 1: Update File menu items**

In Toolbar.tsx, update the File dropdown section:

Replace:
```typescript
t('mapEditor.toolbar.newMap')   // ⌘N
t('mapEditor.toolbar.open')     // ⌘O
```

With:
```typescript
t('mapEditor.project.newProject')   // ⌘N
t('mapEditor.project.openProject')  // ⌘O
```

Add "Save As" menu item after Save:

```typescript
<button className="..." onClick={onSaveAs}>
  {t("mapEditor.project.saveAs")}
</button>
```

- [ ] **Step 2: Add onSaveAs prop**

Add to ToolbarProps:
```typescript
onSaveAs?: () => void;
```

- [ ] **Step 3: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 4: Commit**

```bash
git add src/components/map-editor/Toolbar.tsx
git commit -m "feat(toolbar): update File menu for project system (New/Open Project, Save As)"
```

---

## Task 11: ImportTilesetModal — 3-Tab Structure

**Files:**
- Modify: `src/components/map-editor/ImportTilesetModal.tsx`

- [ ] **Step 1: Add tab state and library fetch**

At the top of the component, add:

```typescript
const [activeTab, setActiveTab] = useState<"upload" | "myTilesets" | "builtIn">("upload");
const [libraryTilesets, setLibraryTilesets] = useState<Array<{
  id: string; name: string; tilewidth: number; tileheight: number;
  columns: number; tilecount: number; image: string;
}>>([]);
const [libraryLoading, setLibraryLoading] = useState(false);
```

Add fetch function:

```typescript
const fetchLibrary = useCallback(async (builtIn: boolean) => {
  setLibraryLoading(true);
  try {
    const res = await fetch(`/api/tilesets?builtIn=${builtIn}`);
    if (res.ok) setLibraryTilesets(await res.json());
  } finally {
    setLibraryLoading(false);
  }
}, []);

useEffect(() => {
  if (activeTab === "myTilesets") fetchLibrary(false);
  else if (activeTab === "builtIn") fetchLibrary(true);
}, [activeTab, fetchLibrary]);
```

- [ ] **Step 2: Add tab bar UI**

Before the existing file upload UI, add a tab bar:

```typescript
<div className="flex border-b border-gray-700 mb-4">
  {(["upload", "myTilesets", "builtIn"] as const).map((tab) => (
    <button
      key={tab}
      className={`px-4 py-2 text-sm ${
        activeTab === tab
          ? "border-b-2 border-blue-500 text-blue-400"
          : "text-gray-400 hover:text-white"
      }`}
      onClick={() => setActiveTab(tab)}
    >
      {tab === "upload" && t("mapEditor.assets.tabUpload")}
      {tab === "myTilesets" && t("mapEditor.assets.tabMyTilesets")}
      {tab === "builtIn" && t("mapEditor.assets.tabBuiltIn")}
    </button>
  ))}
</div>
```

- [ ] **Step 3: Add library tileset grid UI**

For "myTilesets" and "builtIn" tabs, show a grid of clickable tileset cards:

```typescript
{activeTab !== "upload" && (
  <div className="grid grid-cols-3 gap-3 max-h-80 overflow-auto">
    {libraryLoading ? (
      <div className="col-span-3 text-center text-gray-500 py-8">Loading...</div>
    ) : libraryTilesets.length === 0 ? (
      <div className="col-span-3 text-center text-gray-500 py-8">{t("mapEditor.assets.noTilesets")}</div>
    ) : (
      libraryTilesets.map((ts) => (
        <button
          key={ts.id}
          className="flex flex-col items-center p-2 bg-gray-800 rounded border border-gray-700 hover:border-blue-500"
          onClick={() => {
            // Import this tileset into the project
            const img = new Image();
            img.src = ts.image;
            img.onload = () => {
              const nextFirstgid = existingTilesets.reduce(
                (max, t) => Math.max(max, t.firstgid + t.tilecount), 1
              );
              onImport({
                tileset: {
                  firstgid: nextFirstgid,
                  name: ts.name,
                  tilewidth: ts.tilewidth,
                  tileheight: ts.tileheight,
                  tilecount: ts.tilecount,
                  columns: ts.columns,
                  image: ts.image,
                  imagewidth: ts.columns * ts.tilewidth,
                  imageheight: Math.ceil(ts.tilecount / ts.columns) * ts.tileheight,
                },
                imageInfo: {
                  img,
                  firstgid: nextFirstgid,
                  columns: ts.columns,
                  tilewidth: ts.tilewidth,
                  tileheight: ts.tileheight,
                  tilecount: ts.tilecount,
                  name: ts.name,
                },
                imageDataUrl: ts.image,
              });
              onClose();
            };
          }}
        >
          <img src={ts.image} alt={ts.name} className="w-16 h-16 object-contain bg-gray-900 rounded" />
          <span className="text-xs text-gray-300 mt-1 truncate w-full text-center">{ts.name}</span>
          <span className="text-xs text-gray-500">{ts.tilewidth}×{ts.tileheight}</span>
        </button>
      ))
    )}
  </div>
)}
```

Wrap the existing file upload UI with `{activeTab === "upload" && ( ... )}`.

- [ ] **Step 4: Add projectId and onLinkTileset props**

Add to ImportTilesetModalProps:

```typescript
projectId?: string | null;
tilesetDbId?: string; // returned from DB after upload
onLinkTileset?: (tilesetId: string, firstgid: number) => void;
```

After a successful file upload import, also save to DB and link to project:

```typescript
// After onImport() in handleImport:
if (projectId) {
  // Save tileset to DB
  const saveRes = await fetch("/api/tilesets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: tilesetName,
      tilewidth, tileheight, columns, tilecount,
      image: dataUrl, // base64
    }),
  });
  if (saveRes.ok) {
    const saved = await saveRes.json();
    onLinkTileset?.(saved.id ?? saved.id, nextFirstgid);
  }
}
```

- [ ] **Step 5: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/ImportTilesetModal.tsx
git commit -m "feat(tileset): add 3-tab structure (Upload/My Tilesets/Built-in) to ImportTilesetModal"
```

---

## Task 12: StampPanel — 3-Tab Structure

**Files:**
- Modify: `src/components/map-editor/StampPanel.tsx`

- [ ] **Step 1: Add tab state and library fetch**

Add to the component:

```typescript
const [activeTab, setActiveTab] = useState<"project" | "myStamps" | "builtIn">("project");
const [libraryStamps, setLibraryStamps] = useState<StampListItem[]>([]);
const [libraryLoading, setLibraryLoading] = useState(false);
```

Add props:

```typescript
interface StampPanelProps {
  // ... existing props
  projectId?: string | null;
  onAddToProject?: (stampId: string) => void;
}
```

Add fetch:

```typescript
const fetchLibrary = useCallback(async (builtIn: boolean) => {
  setLibraryLoading(true);
  try {
    const res = await fetch(`/api/stamps?builtIn=${builtIn}`);
    if (res.ok) {
      const data = await res.json();
      setLibraryStamps(data);
    }
  } finally {
    setLibraryLoading(false);
  }
}, []);

useEffect(() => {
  if (activeTab === "myStamps") fetchLibrary(false);
  else if (activeTab === "builtIn") fetchLibrary(true);
}, [activeTab, fetchLibrary]);
```

- [ ] **Step 2: Add tab bar**

```typescript
<div className="flex border-b border-gray-700 mb-2">
  {(["project", "myStamps", "builtIn"] as const).map((tab) => (
    <button
      key={tab}
      className={`flex-1 px-2 py-1.5 text-xs ${
        activeTab === tab
          ? "border-b-2 border-blue-500 text-blue-400"
          : "text-gray-400 hover:text-white"
      }`}
      onClick={() => setActiveTab(tab)}
    >
      {tab === "project" && t("mapEditor.assets.tabProject")}
      {tab === "myStamps" && t("mapEditor.assets.tabMyStamps")}
      {tab === "builtIn" && t("mapEditor.assets.tabBuiltIn")}
    </button>
  ))}
</div>
```

- [ ] **Step 3: Render stamps based on active tab**

```typescript
const displayStamps = activeTab === "project" ? stamps : libraryStamps;
const showAddButton = activeTab !== "project";
```

For "myStamps" and "builtIn" tabs, clicking a stamp calls `onAddToProject(stamp.id)` and switches to "project" tab.

Wrap the existing stamp grid/list rendering to use `displayStamps` instead of `stamps`.

- [ ] **Step 4: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 5: Commit**

```bash
git add src/components/map-editor/StampPanel.tsx
git commit -m "feat(stamps): add 3-tab structure (Project/My Stamps/Built-in) to StampPanel"
```

---

## Task 13: Wire Everything Together in MapEditorLayout

**Files:**
- Modify: `src/components/map-editor/MapEditorLayout.tsx`

This task passes the new props (projectId, onLinkTileset, onAddToProject) from MapEditorLayout to the modified ImportTilesetModal and StampPanel.

- [ ] **Step 1: Pass projectId and link handlers to ImportTilesetModal**

```typescript
<ImportTilesetModal
  open={showImportTileset}
  onClose={() => setShowImportTileset(false)}
  existingTilesets={state.mapData?.tilesets ?? []}
  onImport={handleImportTileset}
  projectId={state.projectId}
  onLinkTileset={async (tilesetId, firstgid) => {
    if (state.projectId) await linkTileset(state.projectId, tilesetId, firstgid);
  }}
/>
```

- [ ] **Step 2: Pass projectId and onAddToProject to StampPanel**

```typescript
<StampPanel
  stamps={stamps}
  activeStampId={activeStamp?.id ?? null}
  onSelectStamp={handleSelectStamp}
  onEditStamp={handleEditStamp}
  onDeleteStamp={handleDeleteStamp}
  projectId={state.projectId}
  onAddToProject={async (stampId) => {
    if (state.projectId) {
      await linkStamp(state.projectId, stampId);
      // Refresh project stamps
      const res = await fetch(`/api/projects/${state.projectId}`);
      if (res.ok) {
        const data = await res.json();
        setStamps(data.stamps);
      }
    }
  }}
/>
```

- [ ] **Step 3: Update handleSaveStamp to link to project**

After the existing stamp POST, add project linking:

```typescript
// After: const created = await stampRes.json();
if (state.projectId) {
  await linkStamp(state.projectId, created.id);
}
```

- [ ] **Step 4: Add Save As handler**

```typescript
const handleSaveAs = useCallback(async () => {
  const newName = prompt(t("mapEditor.project.projectName"), state.projectName);
  if (!newName?.trim() || !state.mapData) return;

  // Duplicate current project with new name
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: newName.trim(),
      tiledJson: state.mapData,
      settings: {},
    }),
  });
  if (!res.ok) return;
  const created = await res.json();

  // Copy tileset links
  // ... (reuse project_tilesets from current project)

  dispatch({ type: "SET_MAP", mapData: state.mapData, projectName: newName.trim(), projectId: created.id });
  dispatch({ type: "MARK_CLEAN" });
}, [state.mapData, state.projectName, state.projectId, dispatch, t]);
```

Pass `onSaveAs={handleSaveAs}` to Toolbar.

- [ ] **Step 5: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/MapEditorLayout.tsx
git commit -m "feat(editor): wire project system props to ImportTilesetModal, StampPanel, and Toolbar"
```

---

## Task 14: Cleanup — Remove Legacy Code

**Files:**
- Modify: `src/components/map-editor/MapEditorLayout.tsx`

- [ ] **Step 1: Remove buildProjectZip and loadProjectZip imports**

Remove:
```typescript
import { buildProjectZip, loadProjectZip } from "@/lib/map-project";
```

- [ ] **Step 2: Remove ZIP-related file input and handleFileSelected**

Delete the hidden `<input type="file" accept=".zip,.tmj,.json">` element and the `handleFileSelected` callback if they're no longer needed. Keep TMJ/TMX/PNG export functions intact.

- [ ] **Step 3: Remove NewMapModal import and usage**

Replace with NewProjectModal which is already imported via ProjectBrowser.

- [ ] **Step 4: Remove loadTemplate function**

Delete the `loadTemplate` function and the `useEffect` that calls it.

- [ ] **Step 5: Build to verify**

```bash
npx next build 2>&1 | head -50
```

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/MapEditorLayout.tsx
git commit -m "refactor(editor): remove legacy ZIP/loadTemplate code, replace with project system"
```

---

## Task 15: End-to-End Verification

- [ ] **Step 1: Run the build**

```bash
npx next build 2>&1 | tail -20
```

Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 2: Start dev server and test manually**

```bash
DB_TYPE=sqlite SQLITE_PATH=data/deskrpg.db npx tsx dev-server.ts
```

Open http://localhost:3000/map-editor. Verify:

1. ProjectBrowser shows on entry
2. "New Project" creates a project and enters editor
3. Editing tiles marks project as dirty
4. ⌘S saves to DB (no ZIP)
5. Going back to ProjectBrowser shows the saved project with thumbnail
6. Opening the project restores all tiles and tilesets
7. Import Tileset shows 3 tabs
8. StampPanel shows 3 tabs

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete map editor project system — DB-backed projects with asset library"
```
