# Stamp Editor Dialog

## Problem
Stamps contain multi-layer tile data (Floor, Walls, Foreground, etc.), but there's no way to edit individual layers of an existing stamp. Users must delete and recreate stamps to make changes.

## Solution
A `StampEditorModal` dialog that opens from the stamp panel's edit button. It shows the stamp's tile grid with a layer panel, allowing per-layer pixel editing and tile management.

## UI Layout

### Modal Structure
- **Size**: `lg` (large modal)
- **Title**: "{stamp name} — Stamp Editor"

### Left Panel (180px, fixed)
- Layer list: each stamp layer as a row with color chip + name + tile count
- Click to select active layer
- Active layer highlighted with color border
- Layer colors match existing `LAYER_COLORS` from StampPanel

### Center Area (flex-1)
- Mini toolbar: shows active layer name, stamp dimensions
- Canvas: renders all layers composited, with active layer opaque and others at 50% opacity
- Tile grid lines drawn (green, same as pixel editor)
- Active layer tiles get a subtle color overlay matching the layer color

### Footer
- Cancel button
- "Edit Pixels" button — opens PixelEditorModal for the active layer's tile image
- Save button — PUT /api/stamps/[id]

## Data Flow

### Opening the Editor
1. User clicks edit button on a stamp in StampPanel
2. `onEditStamp(id)` callback fires
3. MapEditorLayout fetches full stamp data via `GET /api/stamps/{id}`
4. Opens StampEditorModal with full StampData

### Canvas Rendering
- Load each tileset image from `stamp.tilesets[].image` (base64 data URLs)
- For each layer, draw tiles using GID → tileset lookup
- Active layer at full opacity, inactive layers at 50%
- Active layer gets a subtle color overlay (rgba matching layer color, 0.1 alpha)

### Pixel Editing a Layer
1. User clicks "Edit Pixels"
2. Build a composite image of the active layer's tiles (arranged in stamp grid)
3. Open PixelEditorModal in direct image mode (`initialImageDataUrl`)
4. On save: update the stamp's tileset image and layer GIDs
5. Re-render the stamp canvas

### Saving
1. Regenerate thumbnail from canvas (all layers composited)
2. `PUT /api/stamps/{id}` with updated `{ name, layers, tilesets, thumbnail }`

## API Changes

### PUT /api/stamps/[id]
Currently only supports DELETE. Add PUT handler:
```typescript
export async function PUT(req, { params }) {
  const body = await req.json();
  const { name, layers, tilesets, thumbnail } = body;
  await db.update(stamps)
    .set({ name, layers: jsonForDb(layers), tilesets: jsonForDb(tilesets), thumbnail })
    .where(eq(stamps.id, params.id));
  return NextResponse.json({ ok: true });
}
```

## Components

### New File: `src/components/map-editor/StampEditorModal.tsx`
- Props: `{ open, onClose, stamp: StampData, onSave: (stamp: StampData) => void }`
- Internal state: `activeLayerIndex`, loaded tileset images, canvas rendering
- ~300-400 lines estimated

### Modified Files
- `StampPanel.tsx` — add edit button per stamp
- `MapEditorLayout.tsx` — add StampEditorModal instance, edit handler, PUT save handler
- `src/app/api/stamps/[id]/route.ts` — add PUT handler

## Edge Cases
- Stamp with single layer: layer panel still shown (no switching needed, but consistent UI)
- Empty layer (all zeros): show as "(empty)" in layer list
- Tileset image loading failure: show placeholder
- Saving while pixel editor is open: disabled
