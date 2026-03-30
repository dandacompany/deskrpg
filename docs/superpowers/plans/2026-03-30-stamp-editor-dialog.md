# Stamp Editor Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stamp editor dialog that allows per-layer viewing and pixel editing of existing stamps.

**Architecture:** New `StampEditorModal` component with layer panel + canvas preview. StampPanel gets an edit button. API gets PUT endpoint. Pixel editing reuses existing PixelEditorModal in direct image mode.

**Tech Stack:** React, Canvas 2D, existing Modal/Button UI components, existing PixelEditorModal

**Spec:** `docs/superpowers/specs/2026-03-30-stamp-editor-dialog-design.md`

---

### Task 1: Add PUT /api/stamps/[id] endpoint

**Files:**
- Modify: `src/app/api/stamps/[id]/route.ts`

- [ ] **Step 1: Add PUT handler**

Add after the DELETE handler in `src/app/api/stamps/[id]/route.ts`:

```typescript
// PUT /api/stamps/:id — update stamp
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { name, layers, tilesets, thumbnail } = body;

  await db
    .update(stamps)
    .set({
      ...(name !== undefined && { name }),
      ...(layers !== undefined && { layers: jsonForDb(layers) }),
      ...(tilesets !== undefined && { tilesets: jsonForDb(tilesets) }),
      ...(thumbnail !== undefined && { thumbnail }),
    })
    .where(eq(stamps.id, id));

  const [updated] = await db.select().from(stamps).where(eq(stamps.id, id));
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}
```

Also add `jsonForDb` to the import: `import { db, jsonForDb } from "@/db";`

- [ ] **Step 2: Verify build**

Run: `npx next build`

- [ ] **Step 3: Commit**

```
git add src/app/api/stamps/[id]/route.ts
git commit -m "feat(api): add PUT /api/stamps/[id] for stamp editing"
```

---

### Task 2: Add edit button to StampPanel

**Files:**
- Modify: `src/components/map-editor/StampPanel.tsx`

- [ ] **Step 1: Add onEditStamp prop and Pencil import**

Update the imports and props interface:

```typescript
import { X, Pencil } from 'lucide-react';
```

Add to `StampPanelProps`:
```typescript
  onEditStamp?: (id: string) => void;
```

Add to destructuring:
```typescript
  onEditStamp,
```

- [ ] **Step 2: Add edit button next to delete button**

Before the delete `<Tooltip>` button (line ~88), add:

```tsx
{onEditStamp && (
  <Tooltip label={t('mapEditor.stamps.editStamp')}>
    <button
      onClick={(e) => {
        e.stopPropagation();
        onEditStamp(stamp.id);
      }}
      className="text-text-dim hover:text-primary-light opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
    >
      <Pencil className="w-3.5 h-3.5" />
    </button>
  </Tooltip>
)}
```

- [ ] **Step 3: Add i18n keys**

Add to all 4 locale files after `mapEditor.stamps.deleteStamp`:

- en.ts: `"mapEditor.stamps.editStamp": "Edit Stamp",`
- ko.ts: `"mapEditor.stamps.editStamp": "스탬프 편집",`
- ja.ts: `"mapEditor.stamps.editStamp": "スタンプを編集",`
- zh.ts: `"mapEditor.stamps.editStamp": "编辑图章",`

- [ ] **Step 4: Verify build and commit**

```
git add src/components/map-editor/StampPanel.tsx src/lib/i18n/locales/
git commit -m "feat(stamp-panel): add edit button per stamp"
```

---

### Task 3: Create StampEditorModal component

**Files:**
- Create: `src/components/map-editor/StampEditorModal.tsx`

- [ ] **Step 1: Create the component file**

```typescript
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { LAYER_COLORS } from './hooks/useMapEditor';
import type { StampData, StampLayerData, StampTilesetData } from '@/lib/stamp-utils';

interface StampEditorModalProps {
  open: boolean;
  onClose: () => void;
  stamp: StampData;
  onSave: (updated: { layers: StampLayerData[]; tilesets: StampTilesetData[]; thumbnail: string | null }) => void;
  onOpenPixelEditor: (imageDataUrl: string, cols: number, rows: number, tileWidth: number, tileHeight: number, onResult: (dataUrl: string) => void) => void;
}

function getLayerColorByName(name: string) {
  const key = name.toLowerCase() as keyof typeof LAYER_COLORS;
  return LAYER_COLORS[key] ?? { solid: '#6b7280', overlay: 'rgba(107, 114, 128, 0.12)' };
}

export default function StampEditorModal({
  open,
  onClose,
  stamp,
  onSave,
  onOpenPixelEditor,
}: StampEditorModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [layers, setLayers] = useState<StampLayerData[]>(stamp.layers);
  const [tilesets, setTilesets] = useState<StampTilesetData[]>(stamp.tilesets);
  const [tilesetImages, setTilesetImages] = useState<Map<number, HTMLImageElement>>(new Map());
  const [dirty, setDirty] = useState(false);

  // Reset state when stamp changes
  useEffect(() => {
    setLayers(stamp.layers);
    setTilesets(stamp.tilesets);
    setActiveLayerIndex(0);
    setDirty(false);
  }, [stamp.id]);

  // Load tileset images from base64 data URLs
  useEffect(() => {
    const map = new Map<number, HTMLImageElement>();
    let loaded = 0;
    for (const ts of tilesets) {
      const img = new Image();
      img.onload = () => {
        map.set(ts.firstgid, img);
        loaded++;
        if (loaded === tilesets.length) setTilesetImages(new Map(map));
      };
      img.src = ts.image;
    }
    if (tilesets.length === 0) setTilesetImages(new Map());
  }, [tilesets]);

  // Find tileset for a GID
  const findTileset = useCallback((gid: number) => {
    if (gid === 0) return null;
    let best: StampTilesetData | null = null;
    for (const ts of tilesets) {
      if (gid >= ts.firstgid && (!best || ts.firstgid > best.firstgid)) best = ts;
    }
    return best;
  }, [tilesets]);

  // Render canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tilesetImages.size === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    canvas.width = stamp.cols * tw;
    canvas.height = stamp.rows * th;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw each layer
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const isActive = li === activeLayerIndex;
      ctx.globalAlpha = isActive ? 1.0 : 0.4;

      for (let i = 0; i < layer.data.length; i++) {
        const gid = layer.data[i];
        if (gid === 0) continue;
        const ts = findTileset(gid);
        if (!ts) continue;
        const img = tilesetImages.get(ts.firstgid);
        if (!img) continue;

        const localId = gid - ts.firstgid;
        const srcCol = localId % ts.columns;
        const srcRow = Math.floor(localId / ts.columns);
        const dstCol = i % stamp.cols;
        const dstRow = Math.floor(i / stamp.cols);

        ctx.drawImage(
          img,
          srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight,
          dstCol * tw, dstRow * th, tw, th,
        );
      }

      // Active layer color overlay
      if (isActive) {
        const lc = getLayerColorByName(layer.name);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lc.overlay;
        for (let i = 0; i < layer.data.length; i++) {
          if (layer.data[i] !== 0) {
            const col = i % stamp.cols;
            const row = Math.floor(i / stamp.cols);
            ctx.fillRect(col * tw, row * th, tw, th);
          }
        }
      }
    }

    ctx.globalAlpha = 1;
    // Tile grid lines
    ctx.strokeStyle = 'rgba(0,255,100,0.4)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= stamp.cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * tw, 0); ctx.lineTo(x * tw, stamp.rows * th); ctx.stroke();
    }
    for (let y = 0; y <= stamp.rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * th); ctx.lineTo(stamp.cols * tw, y * th); ctx.stroke();
    }
  }, [layers, activeLayerIndex, tilesetImages, stamp, findTileset]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // Generate thumbnail from canvas
  const generateThumbnail = useCallback((): string | null => {
    return canvasRef.current?.toDataURL('image/png') ?? null;
  }, []);

  // Build layer image for pixel editor
  const buildLayerImage = useCallback((layerIndex: number): string | null => {
    const layer = layers[layerIndex];
    if (!layer) return null;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width = stamp.cols * tw;
    offscreen.height = stamp.rows * th;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    for (let i = 0; i < layer.data.length; i++) {
      const gid = layer.data[i];
      if (gid === 0) continue;
      const ts = findTileset(gid);
      if (!ts) continue;
      const img = tilesetImages.get(ts.firstgid);
      if (!img) continue;
      const localId = gid - ts.firstgid;
      const srcCol = localId % ts.columns;
      const srcRow = Math.floor(localId / ts.columns);
      const dstCol = i % stamp.cols;
      const dstRow = Math.floor(i / stamp.cols);
      ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * tw, dstRow * th, tw, th);
    }
    return offscreen.toDataURL('image/png');
  }, [layers, tilesetImages, stamp, findTileset]);

  const handleEditPixels = useCallback(() => {
    const imageDataUrl = buildLayerImage(activeLayerIndex);
    if (!imageDataUrl) return;
    onOpenPixelEditor(
      imageDataUrl,
      stamp.cols,
      stamp.rows,
      stamp.tileWidth,
      stamp.tileHeight,
      (resultDataUrl: string) => {
        // Result is the edited image — create a new tileset from it
        const layer = layers[activeLayerIndex];
        const tileCount = stamp.cols * stamp.rows;
        const newFirstgid = tilesets.reduce((max, ts) => Math.max(max, ts.firstgid + ts.tilecount), 1);
        const newTileset: StampTilesetData = {
          name: `${layer.name}-edited`,
          firstgid: newFirstgid,
          tilewidth: stamp.tileWidth,
          tileheight: stamp.tileHeight,
          columns: stamp.cols,
          tilecount: tileCount,
          image: resultDataUrl,
        };
        // Update layer GIDs to point to new tileset
        const newData = layer.data.map((gid, i) => gid !== 0 ? newFirstgid + i : 0);
        const newLayers = [...layers];
        newLayers[activeLayerIndex] = { ...layer, data: newData };
        setLayers(newLayers);
        setTilesets([...tilesets, newTileset]);
        setDirty(true);
      },
    );
  }, [activeLayerIndex, layers, tilesets, stamp, buildLayerImage, onOpenPixelEditor]);

  const handleSave = useCallback(() => {
    // Set active to 0 temporarily to render all layers at full opacity for thumbnail
    const prevActive = activeLayerIndex;
    const thumbnail = generateThumbnail();
    onSave({ layers, tilesets, thumbnail });
  }, [layers, tilesets, activeLayerIndex, generateThumbnail, onSave]);

  const activeLayer = layers[activeLayerIndex];
  const activeTileCount = activeLayer?.data.filter((g) => g !== 0).length ?? 0;

  return (
    <Modal open={open} onClose={onClose} title={`${stamp.name} — ${t('mapEditor.stamps.stampEditor')}`} size="lg">
      <div className="flex" style={{ height: '60vh' }}>
        {/* Layer Panel */}
        <div className="w-44 border-r border-border p-2 flex flex-col gap-1 flex-shrink-0 overflow-y-auto">
          <div className="text-micro text-text-dim uppercase tracking-wider mb-1">{t('mapEditor.stamps.layers')}</div>
          {layers.map((layer, idx) => {
            const isActive = idx === activeLayerIndex;
            const lc = getLayerColorByName(layer.name);
            const count = layer.data.filter((g) => g !== 0).length;
            return (
              <button
                key={idx}
                onClick={() => setActiveLayerIndex(idx)}
                className={`w-full text-left rounded-md px-2 py-1.5 transition-colors flex items-center gap-2 ${
                  isActive ? 'border' : 'border border-transparent hover:bg-surface-raised'
                }`}
                style={isActive ? { backgroundColor: `${lc.solid}15`, borderColor: `${lc.solid}40` } : {}}
              >
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: lc.solid }} />
                <span className={`text-caption truncate ${isActive ? 'text-text' : 'text-text-secondary'}`}>{layer.name}</span>
                <span className="text-micro text-text-dim ml-auto">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Canvas Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Mini toolbar */}
          <div className="h-9 border-b border-border flex items-center px-3 gap-2 flex-shrink-0">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: getLayerColorByName(activeLayer?.name ?? '').solid }} />
            <span className="text-caption text-text">{activeLayer?.name}</span>
            <span className="text-micro text-text-dim ml-auto">{stamp.cols} x {stamp.rows}</span>
          </div>

          {/* Canvas */}
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-bg-deep p-4">
            <canvas
              ref={canvasRef}
              style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }}
            />
          </div>
        </div>
      </div>

      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={handleEditPixels}>
          {t('mapEditor.stamps.editPixels')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty}>
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
```

- [ ] **Step 2: Add i18n keys**

Add to all 4 locale files:

en.ts:
```
"mapEditor.stamps.stampEditor": "Stamp Editor",
"mapEditor.stamps.layers": "Layers",
"mapEditor.stamps.editPixels": "Edit Pixels",
```

ko.ts:
```
"mapEditor.stamps.stampEditor": "스탬프 편집기",
"mapEditor.stamps.layers": "레이어",
"mapEditor.stamps.editPixels": "픽셀 편집",
```

ja.ts:
```
"mapEditor.stamps.stampEditor": "スタンプエディタ",
"mapEditor.stamps.layers": "レイヤー",
"mapEditor.stamps.editPixels": "ピクセル編集",
```

zh.ts:
```
"mapEditor.stamps.stampEditor": "图章编辑器",
"mapEditor.stamps.layers": "图层",
"mapEditor.stamps.editPixels": "像素编辑",
```

- [ ] **Step 3: Verify build and commit**

```
git add src/components/map-editor/StampEditorModal.tsx src/lib/i18n/locales/
git commit -m "feat(stamp-editor): create StampEditorModal with layer panel and canvas preview"
```

---

### Task 4: Wire StampEditorModal into MapEditorLayout

**Files:**
- Modify: `src/components/map-editor/MapEditorLayout.tsx`

- [ ] **Step 1: Import and add state**

Add import:
```typescript
import StampEditorModal from './StampEditorModal';
```

Add state near other stamp-related state:
```typescript
const [editingStamp, setEditingStamp] = useState<StampData | null>(null);
const [showStampEditor, setShowStampEditor] = useState(false);
```

Add the `StampData` import if not already present:
```typescript
import type { StampData } from '@/lib/stamp-utils';
```

- [ ] **Step 2: Add handleEditStamp and handleSaveStampEdit**

```typescript
const handleEditStamp = useCallback(async (id: string) => {
  try {
    const res = await fetch(`/api/stamps/${id}`);
    if (res.ok) {
      const data = await res.json();
      setEditingStamp(data);
      setShowStampEditor(true);
    }
  } catch { /* ignore */ }
}, []);

const handleSaveStampEdit = useCallback(async (updated: { layers: any[]; tilesets: any[]; thumbnail: string | null }) => {
  if (!editingStamp) return;
  try {
    const res = await fetch(`/api/stamps/${editingStamp.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    if (res.ok) {
      await fetchStamps();
      setShowStampEditor(false);
      setEditingStamp(null);
    }
  } catch { /* ignore */ }
}, [editingStamp, fetchStamps]);
```

- [ ] **Step 3: Pass onEditStamp to StampPanel**

Find the `<StampPanel` JSX and add the prop:
```tsx
onEditStamp={handleEditStamp}
```

- [ ] **Step 4: Add StampEditorModal JSX**

Before the closing `</div>` of the main return, add:

```tsx
{showStampEditor && editingStamp && (
  <StampEditorModal
    open={showStampEditor}
    onClose={() => { setShowStampEditor(false); setEditingStamp(null); }}
    stamp={editingStamp}
    onSave={handleSaveStampEdit}
    onOpenPixelEditor={(imageDataUrl, cols, rows, tileWidth, tileHeight, onResult) => {
      // Store callback for when pixel editor saves
      pixelEditorStampCallbackRef.current = onResult;
      setSelectionPixelData({ dataUrl: imageDataUrl, tileWidth, tileHeight, cols, rows });
      setShowPixelEditor(true);
    }}
  />
)}
```

Also add a ref to store the pixel editor callback:
```typescript
const pixelEditorStampCallbackRef = useRef<((dataUrl: string) => void) | null>(null);
```

And in the PixelEditorModal's `onSaveAsNew` handler (or add a new one), check if the stamp callback exists:

In the existing `handlePixelSaveAsNew`, at the top add:
```typescript
// If this was triggered from stamp editor, call stamp callback instead
if (pixelEditorStampCallbackRef.current) {
  const ec = document.createElement('canvas');
  // ... reconstruct full image from saved tileset
  // Actually simpler: pass the pixel editor's canvas dataUrl directly
}
```

The simpler approach: add a separate `onClose` for pixel editor that checks the stamp callback. Override `onSaveAsNew` to detect stamp editing mode.

Actually, the cleanest approach is to intercept PixelEditorModal's save. The `onSaveAsNew` callback receives `(dataUrl, name, columns, tileWidth, tileHeight, tileCount)`. The `dataUrl` is the re-laid-out tileset image. For stamp editing, we need the raw canvas image (not re-laid-out). The PixelEditorModal already has `onSaveAsStamp` which provides the raw canvas.

So use `onSaveAsStamp` on the PixelEditorModal:

Update the PixelEditorModal's `onSaveAsStamp` prop handler to check for stamp editor callback:

```tsx
onSaveAsStamp={async (thumbnail, cols, rows, tileWidth, tileHeight) => {
  // Check if opened from stamp editor
  if (pixelEditorStampCallbackRef.current) {
    pixelEditorStampCallbackRef.current(thumbnail);
    pixelEditorStampCallbackRef.current = null;
    setShowPixelEditor(false);
    setSelectionPixelData(null);
    return;
  }
  // Normal stamp save logic (existing code)
  // ...
}}
```

- [ ] **Step 5: Verify build and commit**

```
git add src/components/map-editor/MapEditorLayout.tsx
git commit -m "feat(stamp-editor): wire StampEditorModal into MapEditorLayout"
```

---

### Task 5: Test end-to-end and polish

- [ ] **Step 1: Verify build**

Run: `npx next build`

- [ ] **Step 2: Manual test flow**

1. Open map editor with a map that has stamps
2. In stamp panel, hover over a stamp → edit button (pencil) appears
3. Click edit → StampEditorModal opens
4. Layer list shows all stamp layers with correct colors
5. Click different layers → canvas updates opacity
6. Click "Edit Pixels" → PixelEditorModal opens with active layer image
7. Make a change, click "Save as Stamp" or close
8. Back in StampEditorModal, click Save
9. Stamp list refreshes with updated thumbnail

- [ ] **Step 3: Commit final**

```
git add -A
git commit -m "feat(stamp-editor): complete stamp editor dialog with per-layer editing"
```
