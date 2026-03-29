'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { Button } from '@/components/ui';
import type { TileRegion, TilesetImageInfo } from './hooks/useMapEditor';

export interface TilePaletteProps {
  tilesets: TilesetImageInfo[];
  selectedRegion: TileRegion | null;
  onSelectRegion: (region: TileRegion) => void;
  onImportTileset: () => void;
  onDeleteTileset: (firstgid: number) => void;
}

interface DragState {
  firstgid: number;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

function TilesetSection({
  info,
  selectedRegion,
  onSelectRegion,
  onDelete,
}: {
  info: TilesetImageInfo;
  selectedRegion: TileRegion | null;
  onSelectRegion: (region: TileRegion) => void;
  onDelete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const { img, firstgid, columns, tilewidth, tileheight, tilecount, name } = info;
  const rows = Math.ceil(tilecount / columns);
  const isCompact = tilecount <= 4;

  // Draw tileset image + grid + selection overlay
  const draw = useCallback(
    (currentDrag: DragState | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // Grid overlay
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      for (let c = 0; c <= columns; c++) {
        const x = c * tilewidth;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, rows * tileheight);
        ctx.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = r * tileheight;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(columns * tilewidth, y + 0.5);
        ctx.stroke();
      }

      // Selection highlight — either current drag or persisted selectedRegion
      let selMinCol: number, selMinRow: number, selMaxCol: number, selMaxRow: number;
      let showSelection = false;

      if (currentDrag && currentDrag.firstgid === firstgid) {
        selMinCol = Math.min(currentDrag.startCol, currentDrag.endCol);
        selMinRow = Math.min(currentDrag.startRow, currentDrag.endRow);
        selMaxCol = Math.max(currentDrag.startCol, currentDrag.endCol);
        selMaxRow = Math.max(currentDrag.startRow, currentDrag.endRow);
        showSelection = true;
      } else if (selectedRegion && selectedRegion.firstgid === firstgid) {
        selMinCol = selectedRegion.col;
        selMinRow = selectedRegion.row;
        selMaxCol = selectedRegion.col + selectedRegion.width - 1;
        selMaxRow = selectedRegion.row + selectedRegion.height - 1;
        showSelection = true;
      }

      if (showSelection) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
        ctx.fillRect(
          selMinCol! * tilewidth,
          selMinRow! * tileheight,
          (selMaxCol! - selMinCol! + 1) * tilewidth,
          (selMaxRow! - selMinRow! + 1) * tileheight,
        );
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          selMinCol! * tilewidth,
          selMinRow! * tileheight,
          (selMaxCol! - selMinCol! + 1) * tilewidth,
          (selMaxRow! - selMinRow! + 1) * tileheight,
        );
      }
    },
    [img, firstgid, columns, rows, tilewidth, tileheight, selectedRegion],
  );

  useEffect(() => {
    if (img.complete) {
      draw(null);
    } else {
      img.onload = () => draw(null);
    }
  }, [img, draw]);

  const getCellFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const nativeX = (e.clientX - rect.left) * scaleX;
      const nativeY = (e.clientY - rect.top) * scaleY;
      const col = Math.max(0, Math.min(columns - 1, Math.floor(nativeX / tilewidth)));
      const row = Math.max(0, Math.min(rows - 1, Math.floor(nativeY / tileheight)));
      return { col, row };
    },
    [columns, rows, tilewidth, tileheight],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const cell = getCellFromEvent(e);
      if (!cell) return;
      const newDrag: DragState = {
        firstgid,
        startCol: cell.col,
        startRow: cell.row,
        endCol: cell.col,
        endRow: cell.row,
      };
      dragRef.current = newDrag;
      setDrag(newDrag);
      draw(newDrag);
    },
    [getCellFromEvent, firstgid, draw],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) return;
      const cell = getCellFromEvent(e);
      if (!cell) return;
      const updated: DragState = {
        ...dragRef.current,
        endCol: cell.col,
        endRow: cell.row,
      };
      dragRef.current = updated;
      setDrag(updated);
      draw(updated);
    },
    [getCellFromEvent, draw],
  );

  const handleMouseUp = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);

    const minCol = Math.min(d.startCol, d.endCol);
    const minRow = Math.min(d.startRow, d.endRow);
    const maxCol = Math.max(d.startCol, d.endCol);
    const maxRow = Math.max(d.startRow, d.endRow);
    const w = maxCol - minCol + 1;
    const h = maxRow - minRow + 1;

    const gids: number[][] = [];
    for (let r = 0; r < h; r++) {
      const row: number[] = [];
      for (let c = 0; c < w; c++) {
        const tileIndex = (minRow + r) * columns + (minCol + c);
        row.push(firstgid + tileIndex);
      }
      gids.push(row);
    }

    const region: TileRegion = {
      firstgid,
      col: minCol,
      row: minRow,
      width: w,
      height: h,
      gids,
    };
    onSelectRegion(region);
  }, [firstgid, columns, onSelectRegion]);

  // Redraw when selectedRegion changes externally
  useEffect(() => {
    draw(drag);
  }, [selectedRegion, draw, drag]);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-1 py-1">
        <span className="text-caption text-text-secondary truncate" title={name}>
          {name}
        </span>
        <button
          onClick={onDelete}
          className="text-text-dim hover:text-danger text-body transition-colors flex-shrink-0 px-1"
          title="Remove tileset"
        >
          &times;
        </button>
      </div>
      <div className="overflow-x-auto">
        <canvas
          ref={canvasRef}
          className="cursor-crosshair"
          style={{
            width: '100%',
            minWidth: '200px',
            ...(isCompact ? { maxHeight: '48px', objectFit: 'contain' } : {}),
            imageRendering: 'pixelated',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>
    </div>
  );
}

export default function TilePalette({
  tilesets,
  selectedRegion,
  onSelectRegion,
  onImportTileset,
  onDeleteTileset,
}: TilePaletteProps) {
  // Compute selection info text
  let selectionInfo = '';
  if (selectedRegion) {
    const { width, height, gids } = selectedRegion;
    if (width === 1 && height === 1) {
      selectionInfo = `GID ${gids[0][0]}`;
    } else {
      selectionInfo = `Selected: ${width}x${height} region (${width * height} tiles)`;
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-title text-text">Tilesets</span>
        <Button variant="ghost" size="sm" onClick={onImportTileset} title="Import Tileset (I)">
          Import (I)
        </Button>
      </div>

      {/* Selection info */}
      {selectionInfo && (
        <div className="px-3 py-1.5 bg-surface-raised text-caption text-text-secondary border-b border-border flex-shrink-0">
          {selectionInfo}
        </div>
      )}

      {/* Tileset list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {tilesets.length === 0 && (
          <p className="text-caption text-text-dim text-center py-8">
            No tilesets imported yet.
          </p>
        )}
        {tilesets.map((info) => (
          <TilesetSection
            key={info.firstgid}
            info={info}
            selectedRegion={selectedRegion}
            onSelectRegion={onSelectRegion}
            onDelete={() => onDeleteTileset(info.firstgid)}
          />
        ))}
      </div>
    </div>
  );
}
