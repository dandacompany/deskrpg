# Selection Transform Handles — Design Spec

**Date:** 2026-03-30
**Feature:** Pixel Editor Selection Transform (Free Transform without rotation)
**File:** `src/components/map-editor/PixelEditorModal.tsx`

## Overview

Add Photoshop-style Free Transform to the pixel editor's `rect-select` tool. After selecting an area, users can move and scale the selected pixels using 8 handles (4 corner + 4 edge) and interior drag. This uses a **Floating Layer** architecture — selected pixels are extracted into a separate offscreen canvas, transformed independently, then composited back.

## Requirements

- **Move**: Drag inside selection to reposition selected pixels
- **Scale (corner)**: Drag corner handles to scale with aspect ratio preserved; Shift key for free ratio
- **Scale (edge)**: Drag edge handles to scale on a single axis
- **Interpolation**: Toggle between nearest-neighbor (default) and smooth (bilinear) via toolbar checkbox
- **Commit**: Enter key or click outside selection → apply transform
- **Cancel**: Esc key → restore original state via undo
- **Auto-commit**: Switching tools while transform is active commits automatically
- **Minimum size**: 1x1 pixel
- **Canvas boundary**: Transform can extend beyond canvas; clipped on commit

## Architecture: Floating Layer

### Approach

When transform begins, push an undo snapshot, extract the selected pixels into a new offscreen canvas ("floating layer"), and clear the original area to transparent. All transform operations modify position/dimensions of this floating layer. On commit, draw the (possibly scaled) floating layer onto the main `editCanvasRef`. On cancel, pop the undo stack.

### Why This Approach

- Clean separation — transform state is isolated from main canvas
- Live preview is cheap (just `drawImage` with position/size)
- Undo integration is simple (snapshot taken once at entry)
- Matches the existing codebase patterns (`editCanvasRef`, `applyShift`, copy/paste `ImageData`)

## Data Structures

### TransformState

```typescript
interface TransformState {
  floatingCanvas: HTMLCanvasElement;  // extracted pixels
  originX: number;   // original extraction position
  originY: number;
  x: number;         // current position (pixels)
  y: number;
  width: number;     // current display size (pixels)
  height: number;
  smooth: boolean;   // interpolation: false = nearest-neighbor
}
```

Stored as `useRef<TransformState | null>` — updated during drag without triggering re-renders.

### UI Toggle

```typescript
const [transformActive, setTransformActive] = useState(false);
```

Controls handle visibility and toolbar interpolation checkbox display.

### Handle Types

```typescript
type HandleType =
  | 'nw' | 'n' | 'ne'
  | 'w'  |       'e'
  | 'sw' | 's' | 'se'
  | 'move';
```

### Drag Tracking (refs)

```typescript
const transformDragRef = useRef<{
  handle: HandleType;
  startMx: number;  // mouse start (pixel coords)
  startMy: number;
  startX: number;   // transform state at drag start
  startY: number;
  startW: number;
  startH: number;
} | null>(null);
```

## Interaction Flow

### 1. Selection → Transform Entry

1. User completes rect-select drag (mouseUp)
2. `pushUndo()` — save full canvas snapshot
3. Create floating canvas from selection:
   ```
   floatingCanvas = new Canvas(selection.width, selection.height)
   floatingCtx.putImageData(editCtx.getImageData(sel.x, sel.y, sel.w, sel.h), 0, 0)
   ```
4. Clear original area: `editCtx.clearRect(sel.x, sel.y, sel.w, sel.h)`
5. Initialize `TransformState` with origin = selection position, size = selection size
6. Set `transformActive = true`

### 2. Mouse Handling in Transform Mode

**mouseDown:**
1. Convert to pixel coordinates
2. Hit-test against 8 handle positions (10px hit area in screen space)
3. If handle hit → start handle drag
4. If inside floating bounds → start move drag
5. If outside all → **commit transform** (click outside = confirm)

**mouseMove (during drag):**
- `move`: update `x += dx`, `y += dy`
- Corner handles: compute new bounds from anchor (opposite corner)
  - Default: maintain aspect ratio (scale from dominant axis delta)
  - Shift held: free ratio
- Edge handles: single-axis resize
- Enforce minimum 1x1 pixel
- Call `renderCanvas()` each frame

**mouseUp:**
- Clear drag state

### 3. Scale Logic Per Handle

Each handle scales from the opposite corner/edge as anchor:

| Handle | Anchor | Updates |
|--------|--------|---------|
| `se` | (x, y) | w += dx, h += dy |
| `nw` | (x+w, y+h) | x += dx, y += dy, w -= dx, h -= dy |
| `ne` | (x, y+h) | y += dy, w += dx, h -= dy |
| `sw` | (x+w, y) | x += dx, w -= dx, h += dy |
| `e` | x fixed | w += dx |
| `w` | x+w fixed | x += dx, w -= dx |
| `s` | y fixed | h += dy |
| `n` | y+h fixed | y += dy, h -= dy |

**Aspect ratio (corner handles, no Shift):**
```
ratio = originalW / originalH
if (|dx| > |dy|) h = w / ratio
else              w = h * ratio
```

### 4. Commit

1. Set `imageSmoothingEnabled` based on `smooth` flag
2. `editCtx.drawImage(floatingCanvas, x, y, width, height)`
3. Clear transform state, set `transformActive = false`
4. Clear `pixelSelection`

### 5. Cancel (Esc)

1. Call `undo()` — restores canvas from snapshot
2. Clear transform state, set `transformActive = false`
3. Clear `pixelSelection`

### 6. Auto-commit on Tool Switch

When user changes tool while `transformActive`, commit first then switch.

## Rendering

In `renderCanvas()`, when `transformActive` and `transformStateRef.current` exists:

1. Checkerboard background
2. `editCanvas` (has transparent hole where pixels were extracted)
3. Grid lines
4. **Floating layer**: `ctx.drawImage(floating, x*zoom, y*zoom, w*zoom, h*zoom)` with `ctx.imageSmoothingEnabled = transform.smooth`
5. **Marching ants**: animated dashed rect around floating bounds (reuse existing dash animation pattern)
6. **8 handles**: 10x10px squares at screen coordinates
   - Corner handles: `#3b82f6` fill + white 1px border
   - Edge handles: `#60a5fa` fill + white 1px border

### Handle Positions (screen coords)

```
nw: (x*zoom + panX, y*zoom + panY)
n:  ((x + w/2)*zoom + panX, y*zoom + panY)
ne: ((x+w)*zoom + panX, y*zoom + panY)
w:  (x*zoom + panX, (y + h/2)*zoom + panY)
e:  ((x+w)*zoom + panX, (y + h/2)*zoom + panY)
sw: (x*zoom + panX, (y+h)*zoom + panY)
s:  ((x + w/2)*zoom + panX, (y+h)*zoom + panY)
se: ((x+w)*zoom + panX, (y+h)*zoom + panY)
```

### Cursor Changes

| Region | Cursor |
|--------|--------|
| nw, se | `nwse-resize` |
| ne, sw | `nesw-resize` |
| n, s | `ns-resize` |
| w, e | `ew-resize` |
| interior | `move` |
| outside | default |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Commit transform |
| Escape | Cancel transform (undo) |
| Shift (held) | Free ratio on corner drag |

## Toolbar Addition

When `transformActive`, show a small checkbox in the tool options area:

```
☐ Smooth scaling
```

Default unchecked (nearest-neighbor). Toggling updates `transformStateRef.current.smooth` and triggers `renderCanvas()`.

## Undo Integration

- Transform entry: `pushUndo()` once
- Commit: no additional push needed (snapshot already saved)
- Cancel: `undo()` to restore
- After commit, next modification will push its own undo as usual

## Edge Cases

- **Zero-size selection**: Ignore selections smaller than 1x1
- **Negative dimensions during scale**: Flip the axis (allow mirroring by swapping anchor)
- **Very large scale**: No hard limit, but canvas clipping on commit prevents memory issues
- **Zoom/pan during transform**: Handle positions must account for current zoom and pan offset
- **Paste mode conflict**: If `isPixelPasteMode` is active, transform mode should not activate
