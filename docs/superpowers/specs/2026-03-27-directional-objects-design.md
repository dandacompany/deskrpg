# 4-Directional Object Rotation — Design Spec

**Date:** 2026-03-27
**Status:** Approved

## Overview

모든 오브젝트(가구) 에셋에 4방향(up/down/left/right) 회전을 지원하여 맵 에디터에서 방향을 지정하고, 게임에서 방향별로 렌더링한다. 기존 코드 생성 에셋은 자동 변환(flip/rotate)으로 4방향을 생성하고, 외부 PNG 에셋은 방향별 개별 파일을 로딩한다.

## Decisions

| 항목 | 결정 |
|------|------|
| 적용 범위 | 전체 오브젝트 (기존 11개 + 향후 추가) |
| 기존 에셋 회전 | 자동 변환: down(기본) → flip/rotate로 3방향 생성 |
| 외부 PNG 에셋 | 방향별 개별 파일 로딩 ({type}-{direction}.png) |
| 에디터 조작 | R키 회전 순환 + 팔레트 방향 표시 |

## 1. MapObject Interface Extension

```typescript
export interface MapObject {
  id: string;
  type: string;
  col: number;
  row: number;
  variant?: string;
  direction?: "down" | "left" | "right" | "up";  // default: "down"
}
```

Backward compatible: undefined direction treated as "down".

## 2. ObjectTypeDef Extension

```typescript
export interface ObjectTypeDef {
  id: string;
  name: string;
  width: number;
  height: number;
  collision: boolean;
  renderType: "graphic" | "png";
  depthMode: "y-sort" | "fixed";
  fixedDepth?: number;
  directional: boolean;  // NEW: supports 4 directions
}
```

All 11 existing objects get `directional: true`.

## 3. Texture Generation

### Code-generated (existing objects)

Each object gets 4 textures: `obj-{type}-down`, `obj-{type}-left`, `obj-{type}-right`, `obj-{type}-up`

- `down`: current drawing (default/front-facing)
- `right`: horizontal flip of down
- `left`: same as down (or mirror, depending on object)
- `up`: back-facing variation (simplified back view)

Implementation: In `object-textures.ts`, after drawing the "down" texture to a canvas, use canvas transforms to generate the other 3:
- `right`: `ctx.scale(-1, 1)` (horizontal flip)
- `left`: keep as-is (most objects are symmetrical from front)
- `up`: draw a simplified back view or use 180 rotation

For truly symmetrical objects (plant, water_cooler), all 4 directions can be identical.

### External PNG assets

Files at `public/assets/built-in/objects/{type}-{direction}.png`:
- If 4 direction files exist → use them
- If only `{type}.png` exists → use for all directions
- If no file exists → fallback to code-generated texture

Legacy `obj-{type}` (without direction) kept as alias for `obj-{type}-down` for backward compatibility.

## 4. Asset Directory Structure

```
public/assets/
├── built-in/
│   ├── CREDITS.md          ← attribution for CC0/CC-BY assets
│   ├── objects/            ← processed 32x32 PNGs (4-direction)
│   │   ├── sofa-down.png
│   │   ├── sofa-left.png
│   │   ├── sofa-right.png
│   │   ├── sofa-up.png
│   │   └── ...
│   └── downloads/          ← raw downloads (gitignored)
├── external/               ← user's paid assets (.gitignored)
└── generated/              ← runtime fallback (code-drawn)
```

## 5. Rendering Changes

GameScene and EditorScene:

```typescript
// Current:
const texKey = `obj-${obj.type}`;

// New:
const dir = obj.direction || "down";
let texKey = `obj-${obj.type}-${dir}`;
// Fallback: if directional texture doesn't exist, try base
if (!this.textures.exists(texKey)) {
  texKey = `obj-${obj.type}`;
}
```

### Width/Height swap for rotated objects

Objects with `width !== height` (e.g., meeting_table 2x2 is fine, but reception_desk 2x1) need width/height swapped when facing up/down vs left/right:
- `down`/`up`: original width × height
- `left`/`right`: height × width

This affects collision calculation and rendering position.

## 6. Editor UI Changes

### R key rotation
- When objects layer is active, R key cycles: down → right → up → left → down
- Current direction shown in palette
- Shift+R for reverse cycle

### Palette direction indicator
- Small direction arrows (↓→↑←) displayed next to "Objects" section header
- Current direction highlighted

### Hover preview
- Object placement preview shows the correct directional sprite
- Collision footprint reflects rotated width/height

### Existing object rotation
- Click on placed object while in object mode → R to rotate in place
- Emits objects-changed event for undo tracking

## 7. File Changes

### Modified
- `src/lib/object-types.ts` — direction field on MapObject, directional flag on ObjectTypeDef, width/height getter considering direction
- `src/lib/object-textures.ts` — generate 4 directional textures per object
- `src/game/scenes/BootScene.ts` — load external PNGs, generate directional textures
- `src/game/scenes/EditorBootScene.ts` — same as BootScene
- `src/game/scenes/GameScene.ts` — use directional texture key in renderObjects
- `src/game/scenes/EditorScene.ts` — R key handler, directional placement, hover preview
- `src/components/MapEditorPalette.tsx` — direction indicator UI

### New
- `public/assets/built-in/objects/` — processed CC0 PNG assets
- `public/assets/built-in/CREDITS.md` — attribution file
