# Pixel Editor Edge Hover Add/Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 8 toolbar buttons for adding/deleting rows/columns with contextual hover buttons that appear when the mouse is over edge tiles, with row/column highlight overlay.

**Architecture:** Add `hoveredEdge` state tracking which edges are active. In `handleMouseMove`, compute tile coordinates and detect edge tiles. In `renderCanvas`, draw blue highlight overlays for hovered rows/columns. Render HTML button overlays positioned relative to the canvas. Remove the 8 toolbar buttons.

**Tech Stack:** React state + canvas drawing + absolute-positioned HTML overlays

**Spec:** `docs/superpowers/specs/2026-03-30-pixel-editor-edge-hover-design.md`

---

### Task 1: Add hoveredEdge state and detection logic

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:82-83` (state declarations)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:677-712` (handleMouseMove)

- [ ] **Step 1: Add hoveredEdge state**

After the existing `expandedRows` state declaration (line ~83), add:

```typescript
const [hoveredEdge, setHoveredEdge] = useState<{
  top: boolean; bottom: boolean; left: boolean; right: boolean;
  screenX: number; screenY: number; // screen position of hovered tile for button placement
} | null>(null);
```

- [ ] **Step 2: Create getTileCoord helper**

After `getPixelCoord` (line ~513), add a helper that converts mouse position to tile coordinates:

```typescript
const getTileCoord = useCallback(
  (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const ec = editCanvasRef.current;
    if (!canvas || !ec) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - pan.x;
    const my = e.clientY - rect.top - pan.y;
    const tw = effectiveTileWidth * zoom;
    const th = effectiveTileHeight * zoom;
    const cols = Math.round(ec.width / effectiveTileWidth);
    const rows = Math.round(ec.height / effectiveTileHeight);
    const tileX = Math.floor(mx / tw);
    const tileY = Math.floor(my / th);
    if (tileX < 0 || tileY < 0 || tileX >= cols || tileY >= rows) return null;
    return { tileX, tileY, cols, rows };
  },
  [pan, zoom, effectiveTileWidth, effectiveTileHeight],
);
```

- [ ] **Step 3: Update handleMouseMove to detect edge tiles**

In `handleMouseMove`, after the line `hoverPixelRef.current = hoverCoord;` (line ~706) and before the drawing check, add edge detection:

```typescript
// Edge hover detection
const tileCoord = getTileCoord(e);
if (tileCoord && !isDrawingRef.current && !isShiftDraggingRef.current && !isRectSelectingRef.current) {
  const { tileX, tileY, cols, rows } = tileCoord;
  const top = tileY === 0;
  const bottom = tileY === rows - 1;
  const left = tileX === 0;
  const right = tileX === cols - 1;
  if (top || bottom || left || right) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const tw = effectiveTileWidth * zoom;
    const th = effectiveTileHeight * zoom;
    setHoveredEdge({
      top, bottom, left, right,
      screenX: rect.left + pan.x + tileX * tw + tw / 2,
      screenY: rect.top + pan.y + tileY * th + th / 2,
    });
  } else {
    setHoveredEdge(null);
  }
} else if (!tileCoord) {
  setHoveredEdge(null);
}
```

- [ ] **Step 4: Clear hoveredEdge on mouse leave**

Update the existing `onMouseLeave` handler on the canvas (line ~1294) to also clear hoveredEdge:

```typescript
onMouseLeave={() => { hoverPixelRef.current = null; setHoveredEdge(null); renderCanvas(); }}
```

- [ ] **Step 5: Add getTileCoord to handleMouseMove dependencies**

Add `getTileCoord` and `effectiveTileWidth`, `effectiveTileHeight` to the `handleMouseMove` dependency array.

- [ ] **Step 6: Verify build**

Run: `npx next build`
Expected: Build succeeds (state is added but not yet used in render)

- [ ] **Step 7: Commit**

```
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add hoveredEdge state and edge tile detection"
```

---

### Task 2: Draw highlight overlay in renderCanvas

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:295-362` (renderCanvas)

- [ ] **Step 1: Pass hoveredEdge to renderCanvas**

The `renderCanvas` function currently accesses `hoverPixelRef` via ref. Since `hoveredEdge` is state, we need to use a ref to make it available inside `renderCanvas` without adding it as a dependency. Add a ref after the state declaration:

```typescript
const hoveredEdgeRef = useRef(hoveredEdge);
hoveredEdgeRef.current = hoveredEdge;
```

- [ ] **Step 2: Add highlight drawing after tile grid lines**

After the tile boundary grid lines block (after line ~361, the closing `}` of the tile grid section), add:

```typescript
// Edge hover highlight overlay
{
  const he = hoveredEdgeRef.current;
  if (he) {
    const w = ec.width * zoom;
    const h = ec.height * zoom;
    const tw = effectiveTileWidth * zoom;
    const th = effectiveTileHeight * zoom;
    const cols = Math.round(ec.width / effectiveTileWidth);
    const rows = Math.round(ec.height / effectiveTileHeight);
    ctx.fillStyle = 'rgba(100, 180, 255, 0.12)';
    // Highlight top row
    if (he.top) ctx.fillRect(0, 0, w, th);
    // Highlight bottom row
    if (he.bottom) ctx.fillRect(0, (rows - 1) * th, w, th);
    // Highlight left column
    if (he.left) ctx.fillRect(0, 0, tw, h);
    // Highlight right column
    if (he.right) ctx.fillRect((cols - 1) * tw, 0, tw, h);
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npx next build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): draw blue highlight overlay on hovered edge row/column"
```

---

### Task 3: Add HTML button overlays

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:1282-1297` (canvas area JSX)

- [ ] **Step 1: Add EdgeHoverButtons component inside the canvas container**

After the `<canvas>` element (line ~1297), but still inside the `containerRef` div, add the button overlay. This is inside the same component, not a separate file:

```tsx
{/* Edge hover buttons */}
{hoveredEdge && (() => {
  const ec = editCanvasRef.current;
  if (!ec) return null;
  const tw = effectiveTileWidth * zoom;
  const th = effectiveTileHeight * zoom;
  const imgW = ec.width * zoom;
  const imgH = ec.height * zoom;
  const btnSize = 20;
  const btnGap = 3;
  const btnOffset = 4; // distance from canvas edge

  const buttons: React.ReactNode[] = [];

  // Top edge buttons: centered horizontally above the canvas image
  if (hoveredEdge.top) {
    const topY = pan.y - btnSize - btnOffset;
    const topX = pan.x + imgW / 2;
    buttons.push(
      <div key="top" className="absolute flex gap-0.5" style={{ left: topX, top: topY, transform: 'translateX(-50%)' }}>
        <button onClick={() => deleteEdge('top')} className="w-5 h-5 rounded bg-red-500/90 hover:bg-red-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.deleteTopRowTooltip')}>-</button>
        <button onClick={() => addEdge('top')} className="w-5 h-5 rounded bg-green-500/90 hover:bg-green-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.addTopRowTooltip')}>+</button>
      </div>
    );
  }

  // Bottom edge buttons: centered horizontally below the canvas image
  if (hoveredEdge.bottom) {
    const botY = pan.y + imgH + btnOffset;
    const botX = pan.x + imgW / 2;
    buttons.push(
      <div key="bottom" className="absolute flex gap-0.5" style={{ left: botX, top: botY, transform: 'translateX(-50%)' }}>
        <button onClick={() => addEdge('bottom')} className="w-5 h-5 rounded bg-green-500/90 hover:bg-green-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.addBottomRowTooltip')}>+</button>
        <button onClick={() => deleteEdge('bottom')} className="w-5 h-5 rounded bg-red-500/90 hover:bg-red-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.deleteBottomRowTooltip')}>-</button>
      </div>
    );
  }

  // Left edge buttons: centered vertically to the left of the canvas image
  if (hoveredEdge.left) {
    const leftX = pan.x - btnSize - btnOffset;
    const leftY = pan.y + imgH / 2;
    buttons.push(
      <div key="left" className="absolute flex flex-col gap-0.5" style={{ left: leftX, top: leftY, transform: 'translateY(-50%)' }}>
        <button onClick={() => deleteEdge('left')} className="w-5 h-5 rounded bg-red-500/90 hover:bg-red-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.deleteLeftColTooltip')}>-</button>
        <button onClick={() => addEdge('left')} className="w-5 h-5 rounded bg-green-500/90 hover:bg-green-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.addLeftColTooltip')}>+</button>
      </div>
    );
  }

  // Right edge buttons: centered vertically to the right of the canvas image
  if (hoveredEdge.right) {
    const rightX = pan.x + imgW + btnOffset;
    const rightY = pan.y + imgH / 2;
    buttons.push(
      <div key="right" className="absolute flex flex-col gap-0.5" style={{ left: rightX, top: rightY, transform: 'translateY(-50%)' }}>
        <button onClick={() => addEdge('right')} className="w-5 h-5 rounded bg-green-500/90 hover:bg-green-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.addRightColTooltip')}>+</button>
        <button onClick={() => deleteEdge('right')} className="w-5 h-5 rounded bg-red-500/90 hover:bg-red-400 text-white text-xs font-bold flex items-center justify-center shadow-md" title={t('mapEditor.pixel.deleteRightColTooltip')}>-</button>
      </div>
    );
  }

  return <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}><div className="pointer-events-auto">{buttons}</div></div>;
})()}
```

- [ ] **Step 2: Verify build**

Run: `npx next build`
Expected: Build succeeds

- [ ] **Step 3: Manual test**

Run dev server, open pixel editor, hover over edge tiles. Verify:
- Blue highlight appears on hovered row/column
- +/- buttons appear outside the canvas edge
- Corner tiles show buttons for both edges
- Clicking + adds a row/column, clicking - deletes

- [ ] **Step 4: Commit**

```
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add hover +/- buttons on canvas edge tiles"
```

---

### Task 4: Remove toolbar add/delete buttons

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:1153-1198` (toolbar JSX)

- [ ] **Step 1: Remove the 8 add/delete buttons from toolbar**

Remove the entire block from the `<div className="w-px h-4 bg-border mx-0.5" />` separator (line ~1153) through the closing `</Tooltip>` of the last addEdge button (line ~1197). This removes:
- The separator
- 4 deleteEdge buttons (left, right, top, bottom)
- Another separator
- 4 addEdge buttons (left, right, top, bottom)

The surrounding `<div>` that contains BG Remove and Trim should remain, just the edge buttons and their separators are removed.

- [ ] **Step 2: Clean up unused lucide imports**

Remove these imports that are no longer used (only if no other usage exists):
- `ArrowLeftFromLine`, `ArrowRightFromLine`, `ArrowUpFromLine`, `ArrowDownFromLine`
- `ArrowLeftToLine`, `ArrowRightToLine`, `ArrowUpToLine`, `ArrowDownToLine`

- [ ] **Step 3: Verify build**

Run: `npx next build`
Expected: Build succeeds with no unused import warnings

- [ ] **Step 4: Commit**

```
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "refactor(pixel-editor): remove toolbar add/delete edge buttons (replaced by hover UX)"
```

---

### Task 5: Edge cases and polish

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx`

- [ ] **Step 1: Suppress hover during drag operations**

In the handleMouseMove edge detection block (added in Task 1), the condition already checks `!isDrawingRef.current && !isShiftDraggingRef.current && !isRectSelectingRef.current`. Also clear hoveredEdge when a drag starts. In `handleMouseDown`, after setting any `isDragging` ref to true, add:

```typescript
setHoveredEdge(null);
```

- [ ] **Step 2: Clear hoveredEdge after addEdge/deleteEdge**

After each `addEdge` and `deleteEdge` call in the button overlays, the grid dimensions change so the hover state becomes stale. Add `setHoveredEdge(null)` inside each button's onClick:

```tsx
onClick={() => { deleteEdge('top'); setHoveredEdge(null); }}
```

Apply this pattern to all 8 buttons in the overlay.

- [ ] **Step 3: Verify build**

Run: `npx next build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "fix(pixel-editor): clear hover state during drags and after edge operations"
```
