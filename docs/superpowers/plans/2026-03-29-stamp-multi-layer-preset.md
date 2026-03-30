# Stamp (Multi-Layer Preset) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 맵 에디터에서 여러 레이어에 걸친 타일 배치를 Stamp로 저장하고 원클릭으로 재사용할 수 있는 풀스택 시스템 구현.

**Architecture:** PostgreSQL stamps 테이블 → Next.js CRUD API → 좌측 패널 Stamps 섹션 UI. Stamp는 타일셋 이미지를 포함한 자기 완결적 구조로, GID 리매핑을 통해 어떤 맵에서든 배치 가능.

**Tech Stack:** PostgreSQL + Drizzle ORM, Next.js API Routes, React 18, TypeScript, Tailwind CSS, Lucide Icons

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/components/map-editor/StampPanel.tsx` | Stamps 패널 UI (목록, 선택, 삭제) |
| `src/components/map-editor/SaveStampModal.tsx` | Stamp 저장 다이얼로그 (이름 입력) |
| `src/app/api/stamps/route.ts` | GET list + POST create API |
| `src/app/api/stamps/[id]/route.ts` | GET detail + DELETE API |
| `src/lib/stamp-utils.ts` | GID 리매핑, 타일셋 매칭, 레이어 매칭 순수 함수 |

### Modified Files
| File | Changes |
|------|---------|
| `src/db/schema.ts` | stamps 테이블 정의 추가 |
| `src/components/map-editor/hooks/useMapEditor.ts` | StampData 타입, PLACE_STAMP action, IMPORT_TILESET_FOR_STAMP action 추가 |
| `src/components/map-editor/MapEditorLayout.tsx` | Stamps 섹션을 sectionOrder에 추가, stamp API 호출, activeStamp/saveStamp 상태 |
| `src/components/map-editor/MapCanvas.tsx` | 컨텍스트 메뉴에 "Save as Stamp" 추가, stamp 미리보기 렌더링, stamp 배치 클릭 처리 |
| `src/components/map-editor/hooks/useCanvasRenderer.ts` | stamp 미리보기 반투명 오버레이 렌더링 |

---

### Task 1: DB Schema — stamps 테이블

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add stamps table to schema**

`src/db/schema.ts` 파일 끝에 추가:

```typescript
export const stamps = pgTable("stamps", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  tileWidth: integer("tile_width").notNull().default(32),
  tileHeight: integer("tile_height").notNull().default(32),
  layers: jsonb("layers").notNull(),
  tilesets: jsonb("tilesets").notNull(),
  thumbnail: text("thumbnail"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
```

- [ ] **Step 2: Push schema to database**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npm run db:push`
Expected: Schema changes applied successfully

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(stamp): add stamps table to database schema"
```

---

### Task 2: CRUD API — /api/stamps

**Files:**
- Create: `src/app/api/stamps/route.ts`
- Create: `src/app/api/stamps/[id]/route.ts`

- [ ] **Step 1: Create GET list + POST create route**

Create `src/app/api/stamps/route.ts`:

```typescript
import { db } from "@/db";
import { stamps } from "@/db/schema";
import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

// GET /api/stamps — list all stamps (lightweight: no tilesets)
export async function GET() {
  const rows = await db
    .select({
      id: stamps.id,
      name: stamps.name,
      cols: stamps.cols,
      rows: stamps.rows,
      thumbnail: stamps.thumbnail,
      layers: stamps.layers,
      createdAt: stamps.createdAt,
    })
    .from(stamps)
    .orderBy(desc(stamps.createdAt));

  const result = rows.map((r) => ({
    id: r.id,
    name: r.name,
    cols: r.cols,
    rows: r.rows,
    thumbnail: r.thumbnail,
    layerNames: Array.isArray(r.layers)
      ? (r.layers as Array<{ name: string }>).map((l) => l.name)
      : [],
    createdAt: r.createdAt,
  }));

  return NextResponse.json(result);
}

// POST /api/stamps — create new stamp
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, cols, rows: stampRows, tileWidth, tileHeight, layers, tilesets, thumbnail } = body;

  if (!name || !cols || !stampRows || !layers || !tilesets) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const userId = getUserId(req);

  const [created] = await db
    .insert(stamps)
    .values({
      name,
      cols,
      rows: stampRows,
      tileWidth: tileWidth ?? 32,
      tileHeight: tileHeight ?? 32,
      layers,
      tilesets,
      thumbnail: thumbnail ?? null,
      createdBy: userId ?? null,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 2: Create GET detail + DELETE route**

Create `src/app/api/stamps/[id]/route.ts`:

```typescript
import { db } from "@/db";
import { stamps } from "@/db/schema";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

// GET /api/stamps/:id — full stamp data (including tilesets)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [stamp] = await db.select().from(stamps).where(eq(stamps.id, id));
  if (!stamp) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(stamp);
}

// DELETE /api/stamps/:id
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(stamps).where(eq(stamps.id, id));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Verify API works**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/stamps/
git commit -m "feat(stamp): add CRUD API endpoints for stamps"
```

---

### Task 3: Stamp Utility Functions — GID 리매핑 + 레이어 매칭

**Files:**
- Create: `src/lib/stamp-utils.ts`

- [ ] **Step 1: Create stamp-utils.ts with types and pure functions**

Create `src/lib/stamp-utils.ts`:

```typescript
// Types for stamp data from API
export interface StampLayerData {
  name: string;
  type: string;
  depth: number;
  data: number[];
}

export interface StampTilesetData {
  name: string;
  firstgid: number;
  tilewidth: number;
  tileheight: number;
  columns: number;
  tilecount: number;
  image: string; // base64 data URL
}

export interface StampData {
  id: string;
  name: string;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  layers: StampLayerData[];
  tilesets: StampTilesetData[];
  thumbnail: string | null;
}

// Lightweight version for list display
export interface StampListItem {
  id: string;
  name: string;
  cols: number;
  rows: number;
  thumbnail: string | null;
  layerNames: string[];
}

/**
 * Build GID remap table: stamp GID → map GID
 * @param stampTilesets - tilesets bundled in the stamp
 * @param mapTilesetFirstgids - map of tileset name → firstgid in the target map
 * @returns Map<stampGid, mapGid>
 */
export function buildGidRemapTable(
  stampTilesets: StampTilesetData[],
  mapTilesetFirstgids: Record<string, number>,
): Map<number, number> {
  const remap = new Map<number, number>();

  for (const st of stampTilesets) {
    const mapFirstgid = mapTilesetFirstgids[st.name];
    if (mapFirstgid === undefined) continue; // should not happen if tilesets are pre-imported

    const offset = mapFirstgid - st.firstgid;
    for (let i = 0; i < st.tilecount; i++) {
      const stampGid = st.firstgid + i;
      remap.set(stampGid, stampGid + offset);
    }
  }

  return remap;
}

/**
 * Find matching layer index in map by name (case-insensitive)
 */
export function findLayerByName(
  mapLayers: Array<{ name: string }>,
  targetName: string,
): number {
  const lower = targetName.toLowerCase();
  return mapLayers.findIndex((l) => l.name.toLowerCase() === lower);
}

/**
 * Collect all unique GIDs used in stamp layers
 */
export function collectUsedGids(layers: StampLayerData[]): Set<number> {
  const gids = new Set<number>();
  for (const layer of layers) {
    for (const gid of layer.data) {
      if (gid !== 0) gids.add(gid);
    }
  }
  return gids;
}

/**
 * Find which stamp tilesets are actually used (have non-zero GIDs referencing them)
 */
export function findUsedTilesets(
  tilesets: StampTilesetData[],
  usedGids: Set<number>,
): StampTilesetData[] {
  return tilesets.filter((ts) => {
    const maxGid = ts.firstgid + ts.tilecount - 1;
    for (const gid of usedGids) {
      if (gid >= ts.firstgid && gid <= maxGid) return true;
    }
    return false;
  });
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/stamp-utils.ts
git commit -m "feat(stamp): add GID remap and layer matching utility functions"
```

---

### Task 4: useMapEditor — PLACE_STAMP Action

**Files:**
- Modify: `src/components/map-editor/hooks/useMapEditor.ts`

- [ ] **Step 1: Add PLACE_STAMP to EditorAction type union**

In `useMapEditor.ts`, add to the `EditorAction` type union (after the `REMOVE_UNUSED_TILESETS` line):

```typescript
  | { type: 'PLACE_STAMP'; stampLayers: Array<{ layerIndex: number; changes: Array<{ index: number; oldGid: number; newGid: number }> }> }
```

- [ ] **Step 2: Add PLACE_STAMP reducer case**

Add new case in the reducer switch, after the `REMOVE_UNUSED_TILESETS` case:

```typescript
    case 'PLACE_STAMP': {
      if (!state.mapData) return state;
      const newLayers = state.mapData.layers.map((l) => ({
        ...l,
        data: l.data ? [...l.data] : l.data,
      }));

      // Apply changes across multiple layers
      for (const sl of action.stampLayers) {
        const layer = newLayers[sl.layerIndex];
        if (!layer || !layer.data) continue;
        for (const c of sl.changes) {
          layer.data[c.index] = c.newGid;
        }
      }

      // Build undo entry: combine all layer changes into one action
      const undoEntry = {
        type: 'PLACE_STAMP' as const,
        stampLayers: action.stampLayers,
      };
      const undoStack = [...state.undoStack, undoEntry];
      if (undoStack.length > 100) undoStack.shift();

      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack,
        redoStack: [],
        dirty: true,
      };
    }
```

- [ ] **Step 3: Update UNDO case to handle PLACE_STAMP undo entries**

In the existing UNDO case, add handling for the multi-layer undo entry. Find the UNDO case and add before the final `return`:

The existing UNDO case processes `undoStack` entries that have `{ layerIndex, changes }`. For PLACE_STAMP entries that have `{ type: 'PLACE_STAMP', stampLayers }`, add a branch:

```typescript
    // Inside UNDO case, after popping the last undo entry:
    // Check if it's a PLACE_STAMP undo entry
    if ('stampLayers' in lastAction) {
      const newLayers = state.mapData.layers.map((l) => ({
        ...l,
        data: l.data ? [...l.data] : l.data,
      }));
      for (const sl of (lastAction as any).stampLayers) {
        const layer = newLayers[sl.layerIndex];
        if (!layer || !layer.data) continue;
        for (const c of sl.changes) {
          layer.data[c.index] = c.oldGid;
        }
      }
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack: undoStack.slice(0, -1),
        redoStack: [...state.redoStack, lastAction],
        dirty: true,
      };
    }
```

Similarly update the REDO case with the inverse logic (apply newGid instead of oldGid).

- [ ] **Step 4: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/components/map-editor/hooks/useMapEditor.ts
git commit -m "feat(stamp): add PLACE_STAMP action with multi-layer undo/redo"
```

---

### Task 5: SaveStampModal — 이름 입력 다이얼로그

**Files:**
- Create: `src/components/map-editor/SaveStampModal.tsx`

- [ ] **Step 1: Create SaveStampModal component**

Create `src/components/map-editor/SaveStampModal.tsx`:

```typescript
'use client';

import { useState, useRef, useEffect } from 'react';
import { Button, Modal } from '@/components/ui';

interface SaveStampModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  saving?: boolean;
}

export default function SaveStampModal({ open, onClose, onSave, saving }: SaveStampModalProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <Modal open={open} onClose={onClose} title="Save as Stamp">
      <Modal.Body>
        <div className="space-y-3">
          <p className="text-caption text-text-secondary">
            Save the selected region across all layers as a reusable Stamp.
          </p>
          <div>
            <label className="block text-caption text-text-secondary mb-1">Stamp Name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="e.g. Chair (front), Desk set..."
              className="w-full bg-surface text-caption text-text px-3 py-2 rounded border border-border outline-none focus:border-primary-light"
              maxLength={200}
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={!name.trim() || saving}
        >
          {saving ? 'Saving...' : 'Save Stamp'}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/SaveStampModal.tsx
git commit -m "feat(stamp): add SaveStampModal dialog component"
```

---

### Task 6: StampPanel — 좌측 패널 Stamps 섹션

**Files:**
- Create: `src/components/map-editor/StampPanel.tsx`

- [ ] **Step 1: Create StampPanel component**

Create `src/components/map-editor/StampPanel.tsx`:

```typescript
'use client';

import { useState, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import Tooltip from './Tooltip';
import type { StampListItem } from '@/lib/stamp-utils';
import { LAYER_COLORS } from './hooks/useMapEditor';

const LAYER_BADGE_COLORS: Record<string, string> = {
  floor: LAYER_COLORS.floor.solid,
  walls: LAYER_COLORS.walls.solid,
  foreground: LAYER_COLORS.foreground.solid,
  collision: LAYER_COLORS.collision.solid,
  objects: LAYER_COLORS.objects.solid,
};

function getBadgeColor(layerName: string): string {
  return LAYER_BADGE_COLORS[layerName.toLowerCase()] ?? '#6b7280';
}

export interface StampPanelProps {
  stamps: StampListItem[];
  activeStampId: string | null;
  onSelectStamp: (id: string) => void;
  onDeleteStamp: (id: string) => void;
  hideHeader?: boolean;
}

export default function StampPanel({
  stamps,
  activeStampId,
  onSelectStamp,
  onDeleteStamp,
  hideHeader,
}: StampPanelProps) {
  if (stamps.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <p className="text-caption text-text-dim">No stamps yet</p>
        <p className="text-micro text-text-dim mt-1">
          Select a region on the map and right-click → Save as Stamp
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-1.5 py-1.5 space-y-0.5">
        {stamps.map((stamp) => {
          const isActive = stamp.id === activeStampId;
          return (
            <div
              key={stamp.id}
              className={`
                group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors
                ${isActive ? 'bg-primary-light/10 border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'}
              `.trim().replace(/\s+/g, ' ')}
              onClick={() => onSelectStamp(stamp.id)}
            >
              {/* Thumbnail */}
              <div className="w-10 h-10 bg-surface-raised rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
                {stamp.thumbnail ? (
                  <img
                    src={stamp.thumbnail}
                    alt={stamp.name}
                    className="w-full h-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                ) : (
                  <span className="text-micro text-text-dim">
                    {stamp.cols}×{stamp.rows}
                  </span>
                )}
              </div>

              {/* Name + layer badges */}
              <div className="flex-1 min-w-0">
                <div className="text-caption text-text truncate">{stamp.name}</div>
                <div className="flex gap-1 mt-0.5 flex-wrap">
                  {stamp.layerNames.map((ln) => (
                    <span
                      key={ln}
                      className="text-micro px-1 py-0.5 rounded text-white leading-none"
                      style={{ backgroundColor: getBadgeColor(ln), fontSize: '9px' }}
                    >
                      {ln}
                    </span>
                  ))}
                </div>
              </div>

              {/* Delete button */}
              <Tooltip label="Delete stamp">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteStamp(stamp.id);
                  }}
                  className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/StampPanel.tsx
git commit -m "feat(stamp): add StampPanel component for left panel"
```

---

### Task 7: MapEditorLayout — Stamps 섹션 통합 + 상태 관리

**Files:**
- Modify: `src/components/map-editor/MapEditorLayout.tsx`

- [ ] **Step 1: Add imports and state**

Add imports at top:

```typescript
import StampPanel from './StampPanel';
import SaveStampModal from './SaveStampModal';
import type { StampListItem, StampData } from '@/lib/stamp-utils';
```

Add state declarations (near existing modal state):

```typescript
  const [stamps, setStamps] = useState<StampListItem[]>([]);
  const [activeStamp, setActiveStamp] = useState<StampData | null>(null);
  const [showSaveStamp, setShowSaveStamp] = useState(false);
  const [savingStamp, setSavingStamp] = useState(false);
```

- [ ] **Step 2: Add stamp API functions**

Add after existing handler functions:

```typescript
  // === Stamps ===

  const fetchStamps = useCallback(async () => {
    try {
      const res = await fetch('/api/stamps');
      if (res.ok) setStamps(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStamps(); }, [fetchStamps]);

  const handleSaveStamp = useCallback(async (name: string) => {
    if (!state.mapData || !state.selection) return;
    setSavingStamp(true);
    try {
      const sel = state.selection;
      const tw = state.mapData.tilewidth;
      const th = state.mapData.tileheight;
      const mapW = state.mapData.width;

      // Collect layers data
      const stampLayers: Array<{ name: string; type: string; depth: number; data: number[] }> = [];
      const usedGids = new Set<number>();

      for (const layer of state.mapData.layers) {
        if (layer.type !== 'tilelayer' || !layer.data || !layer.visible) continue;
        if (layer.name.toLowerCase() === 'collision' && !state.showCollision) continue;

        const data: number[] = [];
        const depth = layer.properties?.find((p: any) => p.name === 'depth');
        const depthVal = depth ? Number(depth.value) || 0 : 0;

        for (let row = 0; row < sel.height; row++) {
          for (let col = 0; col < sel.width; col++) {
            const mapCol = sel.x + col;
            const mapRow = sel.y + row;
            const gid = (mapCol >= 0 && mapCol < state.mapData!.width && mapRow >= 0 && mapRow < state.mapData!.height)
              ? layer.data[mapRow * mapW + mapCol]
              : 0;
            data.push(gid);
            if (gid !== 0) usedGids.add(gid);
          }
        }

        // Only include layers that have non-zero tiles
        if (data.some((g) => g !== 0)) {
          stampLayers.push({ name: layer.name, type: layer.type, depth: depthVal, data });
        }
      }

      if (stampLayers.length === 0) {
        setSavingStamp(false);
        setShowSaveStamp(false);
        return;
      }

      // Collect used tilesets with images
      const stampTilesets: Array<{ name: string; firstgid: number; tilewidth: number; tileheight: number; columns: number; tilecount: number; image: string }> = [];
      for (const ts of state.mapData.tilesets) {
        const maxGid = ts.firstgid + ts.tilecount - 1;
        let used = false;
        for (const gid of usedGids) {
          if (gid >= ts.firstgid && gid <= maxGid) { used = true; break; }
        }
        if (!used) continue;

        const imgInfo = state.tilesetImages[ts.firstgid];
        if (!imgInfo) continue;

        // Convert image to data URL
        const canvas = document.createElement('canvas');
        canvas.width = imgInfo.img.naturalWidth || imgInfo.img.width;
        canvas.height = imgInfo.img.naturalHeight || imgInfo.img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(imgInfo.img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');

        stampTilesets.push({
          name: ts.name,
          firstgid: ts.firstgid,
          tilewidth: ts.tilewidth,
          tileheight: ts.tileheight,
          columns: ts.columns,
          tilecount: ts.tilecount,
          image: dataUrl,
        });
      }

      // Generate thumbnail (reuse existing renderSelectionToDataUrl pattern)
      // We pass it from MapCanvas via the onSaveAsStamp callback
      const thumbnail = (window as any).__stampThumbnail ?? null;

      const body = {
        name,
        cols: sel.width,
        rows: sel.height,
        tileWidth: tw,
        tileHeight: th,
        layers: stampLayers,
        tilesets: stampTilesets,
        thumbnail,
      };

      const res = await fetch('/api/stamps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        await fetchStamps();
      }
    } finally {
      setSavingStamp(false);
      setShowSaveStamp(false);
      (window as any).__stampThumbnail = null;
    }
  }, [state.mapData, state.selection, state.tilesetImages, state.showCollision, fetchStamps]);

  const handleSelectStamp = useCallback(async (id: string) => {
    if (activeStamp?.id === id) {
      setActiveStamp(null);
      return;
    }
    try {
      const res = await fetch(`/api/stamps/${id}`);
      if (res.ok) {
        const data = await res.json();
        setActiveStamp(data);
        dispatch({ type: 'SET_TOOL', tool: 'select' });
      }
    } catch { /* ignore */ }
  }, [activeStamp, dispatch]);

  const handleDeleteStamp = useCallback(async (id: string) => {
    await fetch(`/api/stamps/${id}`, { method: 'DELETE' });
    if (activeStamp?.id === id) setActiveStamp(null);
    fetchStamps();
  }, [activeStamp, fetchStamps]);
```

- [ ] **Step 3: Add 'stamps' to sectionOrder defaults**

Change the default sectionOrder from `['layers', 'tilesets', 'minimap']` to `['layers', 'tilesets', 'stamps', 'minimap']` in the useState initializer. Also update the sectionVisibility default to include `stamps: true`.

- [ ] **Step 4: Add Stamps section rendering**

In the `sectionOrder.filter(...).map(...)` block, add a new condition after the `tilesets` case:

```typescript
            if (sectionId === 'stamps') {
              return (
                <div key={sectionId}>
                  {header}
                  {!isCollapsed && (
                    <StampPanel
                      stamps={stamps}
                      activeStampId={activeStamp?.id ?? null}
                      onSelectStamp={handleSelectStamp}
                      onDeleteStamp={handleDeleteStamp}
                      hideHeader
                    />
                  )}
                </div>
              );
            }
```

Update the `sectionLabel` variable to handle 'stamps':

```typescript
const sectionLabel = sectionId === 'layers' ? 'Layers' : sectionId === 'minimap' ? 'Minimap' : sectionId === 'stamps' ? 'Stamps' : 'Tilesets';
```

- [ ] **Step 5: Pass stamp callbacks to MapCanvas**

Add to the `<MapCanvas>` component props:

```typescript
              onSaveAsStamp={() => setShowSaveStamp(true)}
              activeStamp={activeStamp}
              onPlaceStamp={handlePlaceStamp}
```

Where `handlePlaceStamp` is defined (add before the return):

```typescript
  const handlePlaceStamp = useCallback(async (targetX: number, targetY: number) => {
    if (!activeStamp || !state.mapData) return;

    const { buildGidRemapTable, findLayerByName } = await import('@/lib/stamp-utils');

    // Step 1: Tileset matching + import
    const mapTilesetFirstgids: Record<string, number> = {};
    let mapData = state.mapData;

    for (const st of activeStamp.tilesets) {
      const existing = mapData.tilesets.find((t) => t.name === st.name);
      if (existing) {
        mapTilesetFirstgids[st.name] = existing.firstgid;
      } else {
        // Auto-import tileset
        let newFirstgid = 1;
        for (const ts of mapData.tilesets) {
          const end = ts.firstgid + ts.tilecount;
          if (end > newFirstgid) newFirstgid = end;
        }
        mapTilesetFirstgids[st.name] = newFirstgid;

        const img = new Image();
        await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = st.image; });

        dispatch({
          type: 'ADD_TILESET',
          tileset: {
            firstgid: newFirstgid,
            name: st.name,
            tilewidth: st.tilewidth,
            tileheight: st.tileheight,
            tilecount: st.tilecount,
            columns: st.columns,
            image: st.image,
            imagewidth: st.columns * st.tilewidth,
            imageheight: Math.ceil(st.tilecount / st.columns) * st.tileheight,
          },
          imageInfo: {
            img,
            firstgid: newFirstgid,
            columns: st.columns,
            tilewidth: st.tilewidth,
            tileheight: st.tileheight,
            tilecount: st.tilecount,
            name: st.name,
          },
        });
      }
    }

    // Step 2: Build GID remap table
    const remap = buildGidRemapTable(activeStamp.tilesets, mapTilesetFirstgids);

    // Step 3 & 4: Layer matching + tile placement
    const stampLayerChanges: Array<{ layerIndex: number; changes: Array<{ index: number; oldGid: number; newGid: number }> }> = [];
    const mapW = state.mapData.width;
    const mapH = state.mapData.height;

    for (const sl of activeStamp.layers) {
      let layerIdx = findLayerByName(state.mapData.layers, sl.name);

      // Auto-create layer if missing
      if (layerIdx === -1) {
        const newLayer = {
          id: state.mapData.nextlayerid,
          name: sl.name,
          type: sl.type as 'tilelayer',
          data: new Array(mapW * mapH).fill(0),
          width: mapW,
          height: mapH,
          opacity: sl.name.toLowerCase() === 'collision' ? 0.5 : 1,
          visible: sl.name.toLowerCase() !== 'collision',
          x: 0,
          y: 0,
          properties: sl.depth !== 0 ? [{ name: 'depth', type: 'int', value: sl.depth }] : undefined,
        };
        dispatch({ type: 'ADD_LAYER', layer: newLayer as any });
        layerIdx = state.mapData.layers.length; // will be the last layer after ADD_LAYER
      }

      const layer = state.mapData.layers[layerIdx];
      if (!layer || !layer.data) continue;

      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];
      for (let row = 0; row < activeStamp.rows; row++) {
        for (let col = 0; col < activeStamp.cols; col++) {
          const stampGid = sl.data[row * activeStamp.cols + col];
          if (stampGid === 0) continue; // skip empty cells

          const mapCol = targetX + col;
          const mapRow = targetY + row;
          if (mapCol < 0 || mapCol >= mapW || mapRow < 0 || mapRow >= mapH) continue;

          const mapIdx = mapRow * mapW + mapCol;
          const oldGid = layer.data[mapIdx];
          const newGid = remap.get(stampGid) ?? stampGid;

          if (oldGid !== newGid) {
            changes.push({ index: mapIdx, oldGid, newGid });
          }
        }
      }

      if (changes.length > 0) {
        stampLayerChanges.push({ layerIndex: layerIdx, changes });
      }
    }

    // Step 5: Dispatch single PLACE_STAMP action for undo
    if (stampLayerChanges.length > 0) {
      dispatch({ type: 'PLACE_STAMP', stampLayers: stampLayerChanges });
    }
  }, [activeStamp, state.mapData, dispatch]);
```

- [ ] **Step 6: Add SaveStampModal to JSX**

Add before the closing `</div>` of the component return, near other modals:

```typescript
      <SaveStampModal
        open={showSaveStamp}
        onClose={() => setShowSaveStamp(false)}
        onSave={handleSaveStamp}
        saving={savingStamp}
      />
```

- [ ] **Step 7: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors (may need to fix type issues iteratively)

- [ ] **Step 8: Commit**

```bash
git add src/components/map-editor/MapEditorLayout.tsx
git commit -m "feat(stamp): integrate Stamps section, API calls, and placement logic"
```

---

### Task 8: MapCanvas — Context Menu + Stamp Preview + Placement

**Files:**
- Modify: `src/components/map-editor/MapCanvas.tsx`

- [ ] **Step 1: Add stamp props to MapCanvasProps**

Add to the `MapCanvasProps` interface:

```typescript
  onSaveAsStamp?: () => void;
  activeStamp?: import('@/lib/stamp-utils').StampData | null;
  onPlaceStamp?: (targetX: number, targetY: number) => void;
```

Destructure in the component function parameters.

- [ ] **Step 2: Add "Save as Stamp" to context menu**

In the context menu JSX (after the "Delete" button, before the closing `</div>`), add a separator and stamp button:

```typescript
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
            onClick={() => {
              // Store thumbnail for SaveStampModal
              const dataUrl = renderSelectionToDataUrl();
              if (dataUrl) (window as any).__stampThumbnail = dataUrl;
              onSaveAsStamp?.();
              setContextMenu(null);
            }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
            Save as Stamp
          </button>
```

- [ ] **Step 3: Add stamp placement click handler**

In `handleMouseDown`, add a stamp mode check before the select tool check:

```typescript
      // Stamp placement mode
      if (activeStamp && e.button === 0) {
        const tile = screenToTile(mx, my);
        onPlaceStamp?.(tile.x, tile.y);
        return;
      }
```

- [ ] **Step 4: Add stamp hover position tracking**

Add state for stamp cursor position:

```typescript
  const [stampCursorTile, setStampCursorTile] = useState<{ x: number; y: number } | null>(null);
```

In `handleMouseMove`, add stamp cursor tracking (before the status bar update):

```typescript
      // Stamp cursor tracking
      if (activeStamp) {
        const tile = screenToTile(mx, my);
        setStampCursorTile(tile);
        return;
      }
```

- [ ] **Step 5: Clear stamp cursor on Escape**

In the Escape key effect, also clear active stamp:

```typescript
      if (e.key === 'Escape' && activeStamp) {
        // Handled by MapEditorLayout — just clear local cursor
        setStampCursorTile(null);
      }
```

- [ ] **Step 6: Verify types compile**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/map-editor/MapCanvas.tsx
git commit -m "feat(stamp): add Save as Stamp context menu and stamp placement click handling"
```

---

### Task 9: Canvas Renderer — Stamp Preview Overlay

**Files:**
- Modify: `src/components/map-editor/hooks/useCanvasRenderer.ts`

- [ ] **Step 1: Add stamp preview parameter to render function**

Add to the `options` parameter type of the `render` callback:

```typescript
    options?: {
      layerOverlayMap?: Record<number, boolean>;
      stampPreview?: {
        tileX: number;
        tileY: number;
        cols: number;
        rows: number;
        thumbnail: string | null;
        previewImage?: HTMLImageElement;
      };
    },
```

- [ ] **Step 2: Render stamp preview overlay**

After the selection overlay rendering (after `drawSelection`), add stamp preview rendering:

```typescript
      // 8.6. Stamp preview overlay
      if (options?.stampPreview) {
        const sp = options.stampPreview;
        const sx = sp.tileX * tw;
        const sy = sp.tileY * th;
        const sw = sp.cols * tw;
        const sh = sp.rows * th;

        // Semi-transparent preview image
        if (sp.previewImage) {
          ctx.globalAlpha = 0.6;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sp.previewImage, sx, sy, sw, sh);
          ctx.globalAlpha = 1;
        }

        // Dashed border
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.restore();
      }
```

- [ ] **Step 3: Pass stampPreview from MapCanvas render calls**

In `MapCanvas.tsx`, update both render calls (ResizeObserver and state change effect) to pass `stampPreview` when `activeStamp` and `stampCursorTile` are set.

The render call options should include:

```typescript
{
  layerOverlayMap,
  stampPreview: activeStamp && stampCursorTile ? {
    tileX: stampCursorTile.x,
    tileY: stampCursorTile.y,
    cols: activeStamp.cols,
    rows: activeStamp.rows,
    thumbnail: activeStamp.thumbnail,
    previewImage: stampPreviewImgRef.current ?? undefined,
  } : undefined,
}
```

Add a ref to load the stamp thumbnail as an Image:

```typescript
  const stampPreviewImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (activeStamp?.thumbnail) {
      const img = new Image();
      img.onload = () => { stampPreviewImgRef.current = img; };
      img.src = activeStamp.thumbnail;
    } else {
      stampPreviewImgRef.current = null;
    }
  }, [activeStamp?.thumbnail]);
```

- [ ] **Step 4: Add stampCursorTile and activeStamp to render effect dependencies**

Update the re-render useEffect dependency array to include `stampCursorTile` and `activeStamp`.

- [ ] **Step 5: Verify types compile and build succeeds**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx tsc --noEmit && npx next build`
Expected: No errors, build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/hooks/useCanvasRenderer.ts src/components/map-editor/MapCanvas.tsx
git commit -m "feat(stamp): add stamp preview overlay on canvas"
```

---

### Task 10: Integration Testing + Polish

**Files:**
- Modify: Various files for bug fixes as needed

- [ ] **Step 1: Test full workflow — create stamp**

Manual test in browser:
1. Open map editor with a map that has tiles on multiple layers
2. Use Select tool to select a region
3. Right-click → "Save as Stamp"
4. Enter name → Save
5. Verify stamp appears in Stamps panel with thumbnail and layer badges

- [ ] **Step 2: Test full workflow — place stamp**

Manual test:
1. Click a stamp in the Stamps panel
2. Verify cursor shows purple dashed preview on hover
3. Click to place
4. Verify tiles are placed on correct layers
5. Press Escape to exit stamp mode

- [ ] **Step 3: Test edge cases**

1. Place stamp on map with missing layers → verify layers auto-created
2. Place stamp from different tileset → verify tileset auto-imported
3. Ctrl+Z → verify entire stamp placement undone
4. Delete stamp from panel → verify removed

- [ ] **Step 4: Push schema**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npm run db:push`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(stamp): complete multi-layer stamp preset system"
```
