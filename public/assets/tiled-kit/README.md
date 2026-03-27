# DeskRPG Tiled Starter Kit

Everything you need to create and edit DeskRPG maps with the [Tiled](https://www.mapeditor.org/) map editor.

## Contents

| File | Description |
|------|-------------|
| `deskrpg-tileset.png` | 512x32 tileset image (16 tiles, 32x32 each) |
| `deskrpg-tileset.tsx` | Tiled tileset definition (references the PNG) |
| `sample-office.tmj` | Sample Office map in Tiled JSON format |
| `sample-cafe.tmj` | Sample Cafe map in Tiled JSON format |
| `sample-classroom.tmj` | Sample Classroom map in Tiled JSON format |
| `objects/` | Individual 32x32 object PNGs (desk, chair, plant, etc.) |

## Tile Index Reference

| Index | Name | Collision |
|-------|------|-----------|
| 0 | empty | - |
| 1 | floor | no |
| 2 | wall | yes |
| 3 | desk | yes |
| 4 | chair | no |
| 5 | computer | no |
| 6 | plant | yes |
| 7 | door | no |
| 8 | meeting_table | yes |
| 9 | coffee | yes |
| 10 | water_cooler | yes |
| 11 | bookshelf | yes |
| 12 | carpet | no |
| 13 | whiteboard | yes |
| 14 | reception_desk | yes |
| 15 | cubicle_wall | yes |

## Quick Start

1. Install [Tiled](https://www.mapeditor.org/) (v1.10+)
2. Open one of the `.tmj` sample maps (e.g., `sample-office.tmj`)
3. The tileset should load automatically via the `.tsx` reference

## Creating a New Map

1. In Tiled: **File > New > New Map**
2. Set tile size to **32x32**, orientation to **Orthogonal**
3. Add the tileset: **Map > Add External Tileset** and select `deskrpg-tileset.tsx`
4. Create three layers:
   - `floor` (Tile Layer) -- floor tiles (index 1) and carpet (index 12)
   - `walls` (Tile Layer) -- wall tiles (index 2) and doors (index 7)
   - `objects` (Object Layer) -- furniture and spawn points
5. Paint tiles and place objects
6. Save as `.tmj` (Tiled JSON format)

## Layer Conventions

- **floor**: Use tile 1 (floor) for walkable areas, tile 12 (carpet) for meeting rooms. Tile 0 (empty) under walls.
- **walls**: Use tile 2 (wall) for boundaries, tile 7 (door) for entrances. Tile 0 (empty) for open space.
- **objects**: Place point objects for spawn locations (type=`spawn`), rectangle objects for furniture (type=object name, e.g., `desk`).

## GID Mapping

Tiled uses Global IDs (GIDs) with an offset. Since `firstgid=1`:

- GID 0 = empty (no tile)
- GID = tileIndex + 1
- Example: floor (index 1) = GID 2, wall (index 2) = GID 3, door (index 7) = GID 8

## Regenerating Assets

```bash
# Regenerate tileset PNG and object PNGs
npx tsx scripts/export-tileset.ts

# Re-convert templates to Tiled JSON
npx tsx scripts/convert-templates-to-tiled.ts
```
