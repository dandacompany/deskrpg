# Tiled Integration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** Replace custom Phaser map editor with Tiled Map Editor workflow — upload .tmj files, load via Phaser's built-in Tiled loader.

**Spec:** `docs/superpowers/specs/2026-03-27-tiled-integration-design.md`

---

## Task 1: Generate Tileset PNGs from Code

Create `scripts/export-tileset.ts` that renders the existing BootScene tiles and object textures to PNG files using node-canvas.

**Output:**
- `public/assets/tiled-kit/deskrpg-tileset.png` (512×32, 16 tiles)
- `public/assets/tiled-kit/deskrpg-objects.png` (individual object PNGs)

## Task 2: Create Tiled TSX + Sample TMJ Maps

- Create `deskrpg-tileset.tsx` (Tiled tileset definition with collision properties)
- Convert existing 3 templates (office/cafe/classroom) to Tiled JSON format as sample maps
- Create `README.md` with usage instructions
- Package as downloadable starter kit

## Task 3: DB Schema — Add tiledJson Column

- Add `tiledJson` (jsonb/text) to map_templates in both PG and SQLite schemas
- Make `layers` and `objects` nullable (backward compat)
- Push schema, update seed to use Tiled JSON format

## Task 4: Upload API

- `POST /api/map-templates/upload` — multipart form with .tmj + optional .png files
- Parse Tiled JSON, extract cols/rows/spawn
- Save custom tilesets to `public/assets/uploads/{id}/`
- `GET /api/map-templates/:id/download` — return .tmj file

## Task 5: GameScene — Tiled JSON Loading

- Modify GameScene to detect tiledJson vs legacy mapData
- Load Tiled JSON via Phaser's tilemap cache
- Load tileset images dynamically
- Create layers from Tiled layer names
- Spawn objects from Tiled object layer
- Extract spawn point from "spawn" object
- Keep legacy fallback for existing channels

## Task 6: Remove Custom Editor + Update UI

- Delete EditorScene, EditorBootScene, editor-main, MapEditorPhaser, MapEditorPalette, MapEditorToolbar
- Delete /map-editor/[id] and /map-editor/new pages
- Rewrite /map-editor/page.tsx as upload/management dashboard
- Add starter kit download button
- Update channel creation to handle tiledJson templates

## Task 7: Cleanup + Migration

- Update seed script for Tiled JSON format
- Update setup-lite.js
- Remove unused imports/dependencies
- Final build verification
