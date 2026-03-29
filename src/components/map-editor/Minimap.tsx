'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { EditorState, TilesetImageInfo } from './hooks/useMapEditor';

interface MinimapProps {
  state: EditorState;
  findTileset: (gid: number) => TilesetImageInfo | null;
  /** Canvas area dimensions in pixels */
  viewportWidth: number;
  viewportHeight: number;
  onPanTo: (panX: number, panY: number) => void;
}

export default function Minimap({
  state,
  findTileset,
  viewportWidth,
  viewportHeight,
  onPanTo,
}: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !state.mapData) return;

    const mapData = state.mapData;
    const tw = mapData.tilewidth;
    const th = mapData.tileheight;
    const mapPxW = mapData.width * tw;
    const mapPxH = mapData.height * th;

    // Fit minimap to container width
    const containerW = container.clientWidth;
    const scale = containerW / mapPxW;
    const minimapH = Math.ceil(mapPxH * scale);

    canvas.width = containerW;
    canvas.height = minimapH;

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, containerW, minimapH);

    // Dark background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, containerW, minimapH);

    ctx.save();
    ctx.scale(scale, scale);

    // Draw tile layers
    for (const layer of mapData.layers) {
      if (layer.type !== 'tilelayer' || !layer.data) continue;
      if (!layer.visible) continue;

      for (let y = 0; y < mapData.height; y++) {
        for (let x = 0; x < mapData.width; x++) {
          const gid = layer.data[y * mapData.width + x];
          if (gid === 0) continue;

          const tsInfo = findTileset(gid);
          if (!tsInfo) continue;

          const localId = gid - tsInfo.firstgid;
          const sx = (localId % tsInfo.columns) * tsInfo.tilewidth;
          const sy = Math.floor(localId / tsInfo.columns) * tsInfo.tileheight;

          ctx.drawImage(
            tsInfo.img,
            sx, sy, tsInfo.tilewidth, tsInfo.tileheight,
            x * tw, y * th, tw, th,
          );
        }
      }
    }

    ctx.restore();

    // Draw viewport rectangle
    const zoom = state.zoom;
    const vpX = (-state.panX / zoom) * scale;
    const vpY = (-state.panY / zoom) * scale;
    const vpW = (viewportWidth / zoom) * scale;
    const vpH = (viewportHeight / zoom) * scale;

    ctx.strokeStyle = 'rgba(16, 185, 129, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(vpX, vpY, vpW, vpH);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
    ctx.fillRect(vpX, vpY, vpW, vpH);
  }, [state.mapData, state.zoom, state.panX, state.panY, viewportWidth, viewportHeight, findTileset]);

  useEffect(() => {
    render();
  }, [render]);

  // Click on minimap → pan to that position
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !state.mapData) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const mapPxW = state.mapData.width * state.mapData.tilewidth;
      const scale = canvas.width / mapPxW;

      // Convert minimap coords to world coords
      const worldX = mx / scale;
      const worldY = my / scale;

      // Center viewport on clicked position
      const panX = -(worldX * state.zoom - viewportWidth / 2);
      const panY = -(worldY * state.zoom - viewportHeight / 2);
      onPanTo(panX, panY);
    },
    [state.mapData, state.zoom, viewportWidth, viewportHeight, onPanTo],
  );

  if (!state.mapData) return null;

  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-caption text-text-secondary">Minimap</span>
      </div>
      <div ref={containerRef} className="px-2 pb-2">
        <canvas
          ref={canvasRef}
          className="w-full cursor-pointer rounded"
          style={{ imageRendering: 'pixelated' }}
          onClick={handleClick}
        />
      </div>
    </div>
  );
}
