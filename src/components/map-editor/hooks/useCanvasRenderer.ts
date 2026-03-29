'use client';

import { useCallback } from 'react';
import type { EditorState, TilesetImageInfo, TiledLayer } from './useMapEditor';
import { getLayerColor } from './useMapEditor';

// === Helpers ===

function getLayerDepth(layer: TiledLayer): number {
  if (!layer.properties) return 0;
  const depthProp = layer.properties.find((p) => p.name === 'depth');
  if (!depthProp) return 0;
  if (depthProp.type === 'int' || depthProp.type === 'float') {
    return Number(depthProp.value) || 0;
  }
  if (depthProp.type === 'string' && depthProp.value === 'y-sort') {
    return 5000; // between walls and foreground
  }
  return Number(depthProp.value) || 0;
}

export interface CharacterState {
  tileX: number;
  tileY: number;
  frame: number;
  direction: number; // row in spritesheet (0=down, 1=left, 2=right, 3=up)
}

type FindTilesetFn = (gid: number) => TilesetImageInfo | null;

export function useCanvasRenderer(
  state: EditorState,
  findTileset: FindTilesetFn,
) {
  const render = useCallback(
    (
      canvas: HTMLCanvasElement,
      characterSheet?: HTMLImageElement,
      characterState?: CharacterState,
      options?: {
        layerOverlayMap?: Record<number, boolean>;
        stampPreview?: {
          tileX: number;
          tileY: number;
          cols: number;
          rows: number;
          previewImage?: HTMLImageElement;
        };
      },
    ) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { mapData, zoom, panX, panY, showGrid, showCollision } = state;
      const cw = canvas.width;
      const ch = canvas.height;

      // 1. Clear canvas + background
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#0a0f1e';
      ctx.fillRect(0, 0, cw, ch);

      if (!mapData) return;

      const tw = mapData.tilewidth;
      const th = mapData.tileheight;
      const mapW = mapData.width;
      const mapH = mapData.height;
      const mapPixelW = mapW * tw;
      const mapPixelH = mapH * th;

      // 2. Save and apply transform
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);

      // 3. Map background
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, mapPixelW, mapPixelH);

      // 4. Calculate visible tile range (frustum culling)
      const invZoom = 1 / zoom;
      const viewLeft = -panX * invZoom;
      const viewTop = -panY * invZoom;
      const viewRight = viewLeft + cw * invZoom;
      const viewBottom = viewTop + ch * invZoom;

      const startCol = Math.max(0, Math.floor(viewLeft / tw));
      const startRow = Math.max(0, Math.floor(viewTop / th));
      const endCol = Math.min(mapW - 1, Math.ceil(viewRight / tw));
      const endRow = Math.min(mapH - 1, Math.ceil(viewBottom / th));

      // Sort layers by index but track depth for character insertion
      const layers = mapData.layers;
      let characterDrawn = false;

      // 5 & 6. Draw layers
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];

        // Skip collision layer if not showing
        if (
          !showCollision &&
          layer.name.toLowerCase() === 'collision'
        ) {
          continue;
        }

        // Skip invisible layers
        if (!layer.visible) continue;

        const depth = getLayerDepth(layer);

        // 6. Draw character before foreground layer (depth >= 10000)
        if (
          !characterDrawn &&
          depth >= 10000 &&
          characterSheet &&
          characterState
        ) {
          drawCharacter(ctx, characterSheet, characterState, tw, th);
          characterDrawn = true;
        }

        if (layer.type === 'tilelayer' && layer.data) {
          // Set layer opacity
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = layer.opacity;

          drawTileLayer(
            ctx,
            layer,
            mapW,
            tw,
            th,
            startCol,
            startRow,
            endCol,
            endRow,
            findTileset,
          );

          // Layer color overlay on non-empty tiles (per-layer toggle)
          if (options?.layerOverlayMap?.[li] !== false) {
            const lc = getLayerColor(layer);
            ctx.fillStyle = lc.overlay;
            for (let row = startRow; row <= endRow; row++) {
              for (let col = startCol; col <= endCol; col++) {
                if (layer.data![row * mapW + col] !== 0) {
                  ctx.fillRect(col * tw, row * th, tw, th);
                }
              }
            }
          }

          ctx.globalAlpha = prevAlpha;
        } else if (layer.type === 'objectgroup' && layer.objects) {
          // 7. Object layers
          drawObjectLayer(ctx, layer);
        }
      }

      // Draw character after all layers if no foreground layer exists
      if (!characterDrawn && characterSheet && characterState) {
        drawCharacter(ctx, characterSheet, characterState, tw, th);
      }

      // 8. Grid overlay
      if (showGrid) {
        drawGrid(ctx, mapW, mapH, tw, th, startCol, startRow, endCol, endRow);
      }

      // 8.5. Selection overlay
      if (state.selection) {
        drawSelection(ctx, state.selection, tw, th);
      }

      // Stamp preview overlay
      if (options?.stampPreview) {
        const sp = options.stampPreview;
        const sx = sp.tileX * tw;
        const sy = sp.tileY * th;
        const sw = sp.cols * tw;
        const sh = sp.rows * th;

        if (sp.previewImage) {
          ctx.globalAlpha = 0.6;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(sp.previewImage, sx, sy, sw, sh);
          ctx.globalAlpha = 1;
          ctx.imageSmoothingEnabled = true;
        }

        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.restore();
      }

      // 9. Restore
      ctx.restore();
    },
    [state, findTileset],
  );

  return { render };
}

// === Drawing Functions ===

function drawTileLayer(
  ctx: CanvasRenderingContext2D,
  layer: TiledLayer,
  mapW: number,
  tw: number,
  th: number,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  findTileset: FindTilesetFn,
) {
  const data = layer.data!;

  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const idx = row * mapW + col;
      const gid = data[idx];
      if (gid === 0) continue;

      const tsInfo = findTileset(gid);
      if (!tsInfo || !tsInfo.img.complete) continue;

      const localId = gid - tsInfo.firstgid;
      const srcCol = localId % tsInfo.columns;
      const srcRow = Math.floor(localId / tsInfo.columns);

      ctx.drawImage(
        tsInfo.img,
        srcCol * tsInfo.tilewidth,
        srcRow * tsInfo.tileheight,
        tsInfo.tilewidth,
        tsInfo.tileheight,
        col * tw,
        row * th,
        tw,
        th,
      );
    }
  }
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  charState: CharacterState,
  tw: number,
  th: number,
) {
  const frameSize = 64; // character spritesheet frame size
  const drawSize = 48; // drawn size on map

  const sx = charState.frame * frameSize;
  const sy = charState.direction * frameSize;

  // Center character on tile
  const dx = charState.tileX * tw + (tw - drawSize) / 2;
  const dy = charState.tileY * th + (th - drawSize) / 2;

  // Shadow ellipse beneath character
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(
    dx + drawSize / 2,
    dy + drawSize - 4,
    drawSize * 0.35,
    drawSize * 0.12,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();

  // Draw character sprite
  ctx.drawImage(
    sheet,
    sx,
    sy,
    frameSize,
    frameSize,
    dx,
    dy,
    drawSize,
    drawSize,
  );
}

function drawObjectLayer(
  ctx: CanvasRenderingContext2D,
  layer: TiledLayer,
) {
  if (!layer.objects) return;

  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = 0.6;

  for (const obj of layer.objects) {
    if (!obj.visible) continue;

    const isSpawn =
      obj.type === 'spawn' ||
      obj.name.toLowerCase() === 'spawn';

    if (isSpawn) {
      // Green diamond for spawn points
      ctx.fillStyle = '#22c55e';
      const cx = obj.x + obj.width / 2;
      const cy = obj.y + obj.height / 2;
      const rx = obj.width / 2;
      const ry = obj.height / 2;

      ctx.beginPath();
      ctx.moveTo(cx, cy - ry);
      ctx.lineTo(cx + rx, cy);
      ctx.lineTo(cx, cy + ry);
      ctx.lineTo(cx - rx, cy);
      ctx.closePath();
      ctx.fill();

      // Label
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('S', cx, cy + 4);
    } else {
      // Purple rectangle for other objects
      ctx.fillStyle = 'rgba(168, 85, 247, 0.4)';
      ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 1;
      ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);

      // Label
      if (obj.name || obj.type) {
        ctx.fillStyle = '#e9d5ff';
        ctx.font = '9px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(
          obj.name || obj.type,
          obj.x + 2,
          obj.y + 10,
        );
      }
    }
  }

  ctx.globalAlpha = prevAlpha;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  mapW: number,
  mapH: number,
  tw: number,
  th: number,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
) {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 0.5;

  ctx.beginPath();

  // Vertical lines
  for (let col = startCol; col <= endCol + 1; col++) {
    const x = col * tw;
    ctx.moveTo(x, startRow * th);
    ctx.lineTo(x, (endRow + 1) * th);
  }

  // Horizontal lines
  for (let row = startRow; row <= endRow + 1; row++) {
    const y = row * th;
    ctx.moveTo(startCol * tw, y);
    ctx.lineTo((endCol + 1) * tw, y);
  }

  ctx.stroke();
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  selection: { x: number; y: number; width: number; height: number },
  tw: number,
  th: number,
) {
  const sx = selection.x * tw;
  const sy = selection.y * th;
  const sw = selection.width * tw;
  const sh = selection.height * th;

  // Semi-transparent fill
  ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
  ctx.fillRect(sx, sy, sw, sh);

  // Dashed border
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.restore();
}
