# Pixel Editor: Edge Hover Add/Delete UX

## Problem
The pixel editor has 8 toolbar buttons for adding/deleting rows and columns (←|, |→, ↑, ↓, ←, →, ↑, ↓). These are not intuitive — the user must mentally map abstract arrows to canvas edges. There's no visual feedback about which row/column will be affected.

## Solution
Replace the 8 toolbar buttons with contextual hover interactions directly on the canvas edge tiles. When the user hovers over a tile in the outermost row or column, the entire row/column highlights and +/- buttons appear outside the canvas on that edge.

## Interaction Design

### Hover Detection
- **Top edge tiles** (row 0): hovering any tile in the first row triggers top-edge UI
- **Bottom edge tiles** (last row): hovering any tile in the last row triggers bottom-edge UI
- **Left edge tiles** (col 0): hovering any tile in the first column triggers left-edge UI
- **Right edge tiles** (last col): hovering any tile in the last column triggers right-edge UI
- **Corner tiles**: show buttons for both edges (e.g., top-left shows top + left)

### Detection Logic
Convert mouse position to tile coordinates using existing `screenToTile`-like math (accounting for zoom and pan). Compare tile coords against grid bounds:
- `tileY === 0` → top edge
- `tileY === expandedRows - 1` → bottom edge
- `tileX === 0` → left edge
- `tileX === expandedCols - 1` → right edge

### Visual Feedback
1. **Row/column highlight**: Draw a semi-transparent blue overlay (`rgba(100, 180, 255, 0.12)`) over the entire hovered row and/or column during `renderCanvas()`.
2. **+/- buttons**: HTML elements absolutely positioned outside the canvas image area on the corresponding edge. Positioned relative to the hovered tile's screen coordinates.

### Button Behavior
- **- (delete)**: positioned closer to the canvas edge. Calls `deleteEdge('top'|'bottom'|'left'|'right')`.
- **+ (add)**: positioned farther from the canvas edge. Calls `addEdge('top'|'bottom'|'left'|'right')`.
- Buttons are small (20-22px) rounded squares with red (-) and green (+) backgrounds.
- Buttons should not interfere with canvas mouse events when not hovered.

### Toolbar Cleanup
Remove the 8 add/delete edge buttons from the toolbar (the `deleteEdge`/`addEdge` button group). The `addEdge` and `deleteEdge` callback functions remain unchanged.

## Implementation

### State
```typescript
const [hoveredEdge, setHoveredEdge] = useState<{
  top: boolean; bottom: boolean; left: boolean; right: boolean;
  tileX: number; tileY: number;  // for button positioning
} | null>(null);
```

### Mouse Move Handler
In the existing `handleMouseMove`, after computing tile coordinates:
1. Determine which edges (if any) the tile is on
2. Update `hoveredEdge` state (or set null if not on an edge)
3. Only update when the edge state actually changes to avoid re-renders

### Canvas Rendering
In `renderCanvas()`, after drawing the image and grid lines, if `hoveredEdge` is set:
- Draw blue overlay rectangles for the highlighted row(s) and/or column(s)
- Use the same zoom/pan transform as existing grid drawing

### Button Overlay
React elements rendered inside the canvas container (`position: relative`), positioned using:
- Tile position × zoom + pan offset
- Placed just outside the canvas image boundary on the corresponding edge
- `pointer-events: auto` on buttons, `pointer-events: none` on the wrapper

### Files to Modify
- `src/components/map-editor/PixelEditorModal.tsx` — all changes in this single file

## Edge Cases
- **1×1 grid**: all four edges active on hover, show all 4 button pairs
- **1-row or 1-col grid**: delete button should be disabled (already handled by `deleteEdge` which checks minimum dimensions)
- **Mouse leaves canvas**: clear `hoveredEdge` state
- **During drag operations** (painting, erasing, shifting): suppress edge hover UI
- **Zoom changes**: buttons reposition automatically since they're calculated from tile coords × zoom + pan
