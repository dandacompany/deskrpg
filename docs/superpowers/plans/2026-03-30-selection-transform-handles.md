# Selection Transform Handles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Photoshop-style Free Transform (move + 8-handle scale) to the pixel editor's rect-select tool.

**Architecture:** Floating Layer — extract selected pixels into an offscreen canvas, transform independently, composite back on commit. All transform state managed via refs for performance, with a single `transformActive` boolean state for UI toggling.

**Tech Stack:** React (hooks), HTML5 Canvas API, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-30-selection-transform-handles-design.md`

---

## File Structure

All changes are in a single file:
- **Modify:** `src/components/map-editor/PixelEditorModal.tsx`

No new files needed — this is a feature addition within the existing pixel editor component.

---

### Task 1: Add Transform State & Types

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:17-24` (types section)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:100-120` (state/refs section)

- [ ] **Step 1: Add TransformState interface and HandleType type after existing types**

After the `PixelSelection` interface (line 23), add:

```typescript
interface TransformState {
  floatingCanvas: HTMLCanvasElement;
  originX: number;
  originY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  smooth: boolean;
}

type HandleType = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se' | 'move';
```

- [ ] **Step 2: Add transform state variables and refs**

After the existing `rectSelectStartRef` (line 104), add:

```typescript
const [transformActive, setTransformActive] = useState(false);
const transformRef = useRef<TransformState | null>(null);
const transformDragRef = useRef<{
  handle: HandleType;
  startMx: number;
  startMy: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
} | null>(null);
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds (new state is unused but valid)

- [ ] **Step 4: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add transform state types and refs"
```

---

### Task 2: Implement Transform Entry (Extract Floating Layer)

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:864-868` (handleMouseUp, rect-select section)

- [ ] **Step 1: Create enterTransform helper function**

Add before the `handleMouseDown` callback (around line 653):

```typescript
const enterTransform = useCallback(() => {
  const ec = editCanvasRef.current;
  const sel = pixelSelection;
  if (!ec || !sel || sel.width < 1 || sel.height < 1) return;

  pushUndo();

  // Extract selected pixels into floating canvas
  const srcCtx = ec.getContext('2d')!;
  const imageData = srcCtx.getImageData(sel.x, sel.y, sel.width, sel.height);

  const floating = document.createElement('canvas');
  floating.width = sel.width;
  floating.height = sel.height;
  floating.getContext('2d')!.putImageData(imageData, 0, 0);

  // Clear original area
  srcCtx.clearRect(sel.x, sel.y, sel.width, sel.height);

  // Initialize transform state
  transformRef.current = {
    floatingCanvas: floating,
    originX: sel.x,
    originY: sel.y,
    x: sel.x,
    y: sel.y,
    width: sel.width,
    height: sel.height,
    smooth: false,
  };
  setTransformActive(true);
  renderCanvas();
}, [pixelSelection, pushUndo, renderCanvas]);
```

- [ ] **Step 2: Call enterTransform on selection complete**

In `handleMouseUp` (line 864-868), replace the rect-select block:

```typescript
// Before:
if (isRectSelectingRef.current) {
  isRectSelectingRef.current = false;
  rectSelectStartRef.current = null;
  return;
}

// After:
if (isRectSelectingRef.current) {
  isRectSelectingRef.current = false;
  rectSelectStartRef.current = null;
  // Enter transform mode if we have a valid selection
  // Use setTimeout to let pixelSelection state settle
  setTimeout(() => enterTransform(), 0);
  return;
}
```

Update the `handleMouseUp` dependency array to include `enterTransform`.

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): extract floating layer on selection complete"
```

---

### Task 3: Render Floating Layer & Handles

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:307-445` (renderCanvas function)

- [ ] **Step 1: Add handle position calculator**

Add before `renderCanvas` (around line 305):

```typescript
const HANDLE_SIZE = 10; // pixels on screen
const HANDLE_HIT = 12; // hit-test area (slightly larger)

const getHandlePositions = useCallback((t: TransformState, z: number) => {
  const x = t.x * z;
  const y = t.y * z;
  const w = t.width * z;
  const h = t.height * z;
  const hw = w / 2;
  const hh = h / 2;
  return {
    nw: { x, y },
    n:  { x: x + hw, y },
    ne: { x: x + w, y },
    w:  { x, y: y + hh },
    e:  { x: x + w, y: y + hh },
    sw: { x, y: y + h },
    s:  { x: x + hw, y: y + h },
    se: { x: x + w, y: y + h },
  };
}, []);
```

- [ ] **Step 2: Add floating layer and handles rendering in renderCanvas**

Inside `renderCanvas`, after the paste preview block (around line 442, before `ctx.restore()`), add:

```typescript
// Transform mode: floating layer + handles
if (transformActive && transformRef.current) {
  const t = transformRef.current;

  // Draw floating layer
  ctx.imageSmoothingEnabled = t.smooth;
  ctx.drawImage(t.floatingCanvas, t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
  ctx.imageSmoothingEnabled = false;

  // Marching ants border
  ctx.save();
  const dashOffset = (Date.now() / 80) % 12;
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
  ctx.lineDashOffset = -dashOffset + 4;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.strokeRect(t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
  ctx.restore();

  // 8 handles
  const handles = getHandlePositions(t, zoom);
  const hs = HANDLE_SIZE / 2;
  const cornerKeys: HandleType[] = ['nw', 'ne', 'sw', 'se'];
  const edgeKeys: HandleType[] = ['n', 's', 'w', 'e'];

  for (const key of cornerKeys) {
    const p = handles[key as keyof typeof handles];
    ctx.fillStyle = '#3b82f6';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.fillRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
  }
  for (const key of edgeKeys) {
    const p = handles[key as keyof typeof handles];
    ctx.fillStyle = '#60a5fa';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.fillRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
  }
}
```

- [ ] **Step 3: Update renderCanvas dependency array**

Add `transformActive` to the dependency array of `renderCanvas` (line 445):

```typescript
}, [pan, zoom, tilesetInfo, tool, brushSize, color, pixelSelection, isPixelPasteMode, pixelClipboard, transformActive]);
```

- [ ] **Step 4: Add marching ants animation for transform mode**

Find the existing marching ants animation effect (around line 451-461). Update the condition to also animate during transform:

```typescript
// Before:
if (!isPixelPasteMode || !open) return;

// After:
if ((!isPixelPasteMode && !transformActive) || !open) return;
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): render floating layer with handles and marching ants"
```

---

### Task 4: Handle Hit-Testing & Cursor Changes

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:1213-1215` (cursor style)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:714` (handleMouseMove)

- [ ] **Step 1: Add hit-test function**

Add after `getHandlePositions`:

```typescript
const hitTestHandle = useCallback((e: React.MouseEvent): HandleType | null => {
  if (!transformRef.current) return null;
  const canvas = canvasRef.current;
  if (!canvas) return null;

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left - pan.x;
  const my = e.clientY - rect.top - pan.y;

  const t = transformRef.current;
  const handles = getHandlePositions(t, zoom);
  const hh = HANDLE_HIT / 2;

  // Check handles first (they have priority over interior)
  const handleEntries = Object.entries(handles) as [HandleType, { x: number; y: number }][];
  for (const [key, p] of handleEntries) {
    if (mx >= p.x - hh && mx <= p.x + hh && my >= p.y - hh && my <= p.y + hh) {
      return key;
    }
  }

  // Check interior (move)
  const tx = t.x * zoom;
  const ty = t.y * zoom;
  const tw = t.width * zoom;
  const th = t.height * zoom;
  if (mx >= tx && mx <= tx + tw && my >= ty && my <= ty + th) {
    return 'move';
  }

  return null;
}, [pan, zoom, getHandlePositions]);
```

- [ ] **Step 2: Add cursor map helper**

Add after `hitTestHandle`:

```typescript
const getHandleCursor = (handle: HandleType | null): string => {
  switch (handle) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'w': case 'e': return 'ew-resize';
    case 'move': return 'move';
    default: return 'default';
  }
};
```

- [ ] **Step 3: Add transform hover cursor state**

Add to the state section (near other state variables):

```typescript
const [transformCursor, setTransformCursor] = useState('default');
```

- [ ] **Step 4: Update cursor style computation**

Replace the cursor style line (line 1214-1215):

```typescript
// Before:
const cursorStyle =
  tool === 'shift' ? 'move' : tool === 'rect-select' ? 'crosshair' : tool === 'eyedropper' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';

// After:
const cursorStyle = transformActive
  ? transformCursor
  : tool === 'shift' ? 'move' : tool === 'rect-select' ? 'crosshair' : tool === 'eyedropper' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';
```

- [ ] **Step 5: Update handleMouseMove to set cursor in transform mode**

At the very top of `handleMouseMove` (line 715), add before the shift-dragging check:

```typescript
// Transform mode: update cursor on hover
if (transformActive && !transformDragRef.current) {
  const handle = hitTestHandle(e);
  setTransformCursor(getHandleCursor(handle));
}
```

- [ ] **Step 6: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add handle hit-testing and dynamic cursor changes"
```

---

### Task 5: Implement Move Drag

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:653-712` (handleMouseDown)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:714-861` (handleMouseMove)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:864-877` (handleMouseUp)

- [ ] **Step 1: Add commitTransform and cancelTransform helpers**

Add after `enterTransform`:

```typescript
const commitTransform = useCallback(() => {
  const t = transformRef.current;
  const ec = editCanvasRef.current;
  if (!t || !ec) return;

  const ctx = ec.getContext('2d')!;
  ctx.imageSmoothingEnabled = t.smooth;
  ctx.drawImage(t.floatingCanvas, t.x, t.y, t.width, t.height);
  ctx.imageSmoothingEnabled = false;

  transformRef.current = null;
  transformDragRef.current = null;
  setTransformActive(false);
  setPixelSelection(null);
  setTransformCursor('default');
  renderCanvas();
}, [renderCanvas]);

const cancelTransform = useCallback(() => {
  if (!transformRef.current) return;
  undo();
  transformRef.current = null;
  transformDragRef.current = null;
  setTransformActive(false);
  setPixelSelection(null);
  setTransformCursor('default');
  renderCanvas();
}, [undo, renderCanvas]);
```

- [ ] **Step 2: Add transform mouseDown handling in handleMouseDown**

At the top of `handleMouseDown` (after the middle-click pan check, before `if (e.button !== 0) return;` at line 665), add:

```typescript
// Transform mode: handle clicks
if (transformActive && e.button === 0) {
  const handle = hitTestHandle(e);
  if (handle) {
    // Start dragging a handle or moving
    const t = transformRef.current!;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - pan.x) / zoom;
    const my = (e.clientY - rect.top - pan.y) / zoom;
    transformDragRef.current = {
      handle,
      startMx: mx,
      startMy: my,
      startX: t.x,
      startY: t.y,
      startW: t.width,
      startH: t.height,
    };
    return;
  } else {
    // Click outside → commit
    commitTransform();
    return;
  }
}
```

Update `handleMouseDown` dependency array to include `transformActive`, `hitTestHandle`, `commitTransform`.

- [ ] **Step 3: Add transform drag handling in handleMouseMove**

After the transform cursor update block (added in Task 4 Step 5), add:

```typescript
// Transform mode: drag in progress
if (transformActive && transformDragRef.current) {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - pan.x) / zoom;
  const my = (e.clientY - rect.top - pan.y) / zoom;
  const drag = transformDragRef.current;
  const t = transformRef.current!;
  const dx = mx - drag.startMx;
  const dy = my - drag.startMy;

  if (drag.handle === 'move') {
    t.x = Math.round(drag.startX + dx);
    t.y = Math.round(drag.startY + dy);
  }

  renderCanvas();
  return;
}
```

- [ ] **Step 4: Add transform drag end in handleMouseUp**

At the top of `handleMouseUp`, before the rect-select check:

```typescript
if (transformDragRef.current) {
  transformDragRef.current = null;
  return;
}
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): implement move drag and commit/cancel for transform"
```

---

### Task 6: Implement Scale Drag (Corner & Edge Handles)

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx` (handleMouseMove transform drag section)

- [ ] **Step 1: Replace the move-only transform drag block with full scale logic**

In `handleMouseMove`, replace the transform drag block (from Task 5 Step 3) with complete scale handling:

```typescript
// Transform mode: drag in progress
if (transformActive && transformDragRef.current) {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - pan.x) / zoom;
  const my = (e.clientY - rect.top - pan.y) / zoom;
  const drag = transformDragRef.current;
  const t = transformRef.current!;
  const dx = mx - drag.startMx;
  const dy = my - drag.startMy;
  const h = drag.handle;

  if (h === 'move') {
    t.x = Math.round(drag.startX + dx);
    t.y = Math.round(drag.startY + dy);
  } else {
    // Scale logic: each handle scales from the opposite anchor
    let newX = drag.startX;
    let newY = drag.startY;
    let newW = drag.startW;
    let newH = drag.startH;

    const isCorner = h === 'nw' || h === 'ne' || h === 'sw' || h === 'se';
    const isEdge = !isCorner;

    // Apply deltas based on handle
    if (h === 'se' || h === 'e' || h === 'ne') newW = drag.startW + dx;
    if (h === 'nw' || h === 'w' || h === 'sw') { newX = drag.startX + dx; newW = drag.startW - dx; }
    if (h === 'se' || h === 's' || h === 'sw') newH = drag.startH + dy;
    if (h === 'nw' || h === 'n' || h === 'ne') { newY = drag.startY + dy; newH = drag.startH - dy; }

    // Corner handles: aspect ratio lock (unless Shift held)
    if (isCorner && !e.shiftKey) {
      const ratio = drag.startW / drag.startH;
      const absDx = Math.abs(newW - drag.startW);
      const absDy = Math.abs(newH - drag.startH);

      if (absDx >= absDy) {
        // Width is dominant — compute height from width
        const targetH = Math.round(newW / ratio);
        if (h === 'nw' || h === 'ne') {
          newY = drag.startY + drag.startH - targetH;
        }
        newH = targetH;
      } else {
        // Height is dominant — compute width from height
        const targetW = Math.round(newH * ratio);
        if (h === 'nw' || h === 'sw') {
          newX = drag.startX + drag.startW - targetW;
        }
        newW = targetW;
      }
    }

    // Handle negative dimensions (flip)
    if (newW < 0) { newX += newW; newW = -newW; }
    if (newH < 0) { newY += newH; newH = -newH; }

    // Enforce minimum 1x1
    if (newW < 1) newW = 1;
    if (newH < 1) newH = 1;

    t.x = Math.round(newX);
    t.y = Math.round(newY);
    t.width = Math.round(newW);
    t.height = Math.round(newH);
  }

  renderCanvas();
  return;
}
```

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): implement corner and edge handle scaling with aspect ratio lock"
```

---

### Task 7: Keyboard Shortcuts (Enter, Esc) & Auto-Commit on Tool Switch

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:926-978` (keyboard shortcuts)
- Modify: `src/components/map-editor/PixelEditorModal.tsx:1228-1251` (tool buttons)

- [ ] **Step 1: Update Escape and add Enter handling in keyboard shortcuts**

In the keyboard handler (line 954), update the Escape block and add Enter:

```typescript
if (e.key === 'Escape') {
  e.preventDefault();
  if (transformActive) {
    cancelTransform();
  } else if (isPixelPasteMode) {
    setIsPixelPasteMode(false);
    setPixelClipboard(null);
  } else {
    setPixelSelection(null);
  }
}
else if (e.key === 'Enter') {
  e.preventDefault();
  if (transformActive) {
    commitTransform();
  }
}
```

Update the keyboard effect dependency array to include `transformActive`, `commitTransform`, `cancelTransform`.

- [ ] **Step 2: Add auto-commit on tool switch**

Create a wrapper function for tool switching. Add before the return statement (around line 1219):

```typescript
const switchTool = useCallback((newTool: Tool) => {
  if (transformActive) commitTransform();
  setTool(newTool);
  setIsPixelPasteMode(false);
  setTileEditMode(false);
  setHoveredEdge(null);
}, [transformActive, commitTransform]);
```

Update all tool button `onClick` handlers and keyboard shortcuts to use `switchTool`:

Toolbar buttons:
```typescript
// Pen
onClick={() => switchTool('pen')}
// Eraser
onClick={() => switchTool('eraser')}
// Eyedropper
onClick={() => switchTool('eyedropper')}
// Shift
onClick={() => switchTool('shift')}
// Rect-select (also clears paste mode)
onClick={() => { if (transformActive) commitTransform(); setTool('rect-select'); setIsPixelPasteMode(false); setTileEditMode(false); setHoveredEdge(null); }}
```

Keyboard shortcuts (lines 965-969):
```typescript
else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); switchTool('eraser'); }
else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); switchTool('pen'); }
else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); switchTool('eyedropper'); }
else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); switchTool('shift'); }
else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); switchTool('rect-select'); }
```

- [ ] **Step 3: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add Enter/Esc shortcuts and auto-commit on tool switch"
```

---

### Task 8: Smooth Scaling Toggle in Toolbar

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx:1224` (toolbar area)

- [ ] **Step 1: Add smooth scaling checkbox to toolbar**

After the existing tool buttons section (after the BoxSelect button's closing `</Tooltip>`, around line 1251), inside the toolbar `div`, add a conditional section:

```typescript
{/* Transform mode options */}
{transformActive && (
  <div className="flex items-center gap-1 px-2 border-l border-border">
    <label className="flex items-center gap-1 text-xs text-secondary cursor-pointer select-none">
      <input
        type="checkbox"
        checked={transformRef.current?.smooth ?? false}
        onChange={(e) => {
          if (transformRef.current) {
            transformRef.current.smooth = e.target.checked;
            renderCanvas();
          }
        }}
        className="w-3 h-3"
      />
      Smooth
    </label>
  </div>
)}
```

- [ ] **Step 2: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): add smooth scaling toggle in toolbar during transform"
```

---

### Task 9: Guard Existing Features During Transform Mode

**Files:**
- Modify: `src/components/map-editor/PixelEditorModal.tsx` (multiple sections)

- [ ] **Step 1: Prevent drawing/pasting while transform is active**

In `handleMouseDown`, after the new transform block (added in Task 5), add a guard before the paste mode and drawing sections:

```typescript
// Block other interactions while transforming
if (transformActive) return;
```

This goes right after the transform mode block's closing brace, before the `if (e.button !== 0) return;` line.

- [ ] **Step 2: Prevent new rect-select while transform is active**

The guard from Step 1 already covers this since it returns before reaching the rect-select block.

- [ ] **Step 3: Prevent copy (Cmd+C) during transform**

In the keyboard handler, wrap the copy block with a transform guard:

```typescript
} else if (mod && (e.key === 'c' || e.key === 'C')) {
  e.preventDefault();
  if (transformActive) return; // Don't copy during transform
  const ec = editCanvasRef.current;
  // ... rest of copy logic
```

- [ ] **Step 4: Clean up transform on modal close**

In the `onClose` handler or add a cleanup effect. Add near other effects:

```typescript
useEffect(() => {
  if (!open) {
    // Clean up transform state on modal close
    transformRef.current = null;
    transformDragRef.current = null;
    setTransformActive(false);
  }
}, [open]);
```

- [ ] **Step 5: Verify build compiles**

Run: `cd /Users/dante/workspace/dante-code/projects/deskrpg && npx next build --no-lint 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Manual test checklist**

Run the dev server: `npx tsx dev-server.ts`

Test the following scenarios:
1. Select area with rect-select → 8 handles appear, pixels extracted
2. Drag inside selection → pixels move, original area is transparent
3. Drag corner handle → proportional scale
4. Drag corner handle + Shift → free ratio scale
5. Drag edge handle → single-axis scale
6. Press Enter → transform committed to canvas
7. Press Esc → original pixels restored
8. Click outside selection → transform committed
9. Switch tool during transform → auto-commits
10. Toggle smooth checkbox → rendering changes between pixelated and smooth
11. Undo after commit → restores pre-transform state
12. Close modal during transform → no crashes

- [ ] **Step 7: Commit**

```bash
git add src/components/map-editor/PixelEditorModal.tsx
git commit -m "feat(pixel-editor): guard existing features during transform mode"
```
