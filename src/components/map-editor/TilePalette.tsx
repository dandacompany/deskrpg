'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { Button } from '@/components/ui';
import { CheckSquare, X, Pencil } from 'lucide-react';
import type { TileRegion, TilesetImageInfo } from './hooks/useMapEditor';
import { BUILTIN_TILESET_NAME } from './hooks/useMapEditor';
import Tooltip from './Tooltip';

export interface TilePaletteProps {
  tilesets: TilesetImageInfo[];
  selectedRegion: TileRegion | null;
  onSelectRegion: (region: TileRegion) => void;
  onImportTileset: () => void;
  onDeleteTileset: (firstgid: number) => void;
  onRenameTileset?: (firstgid: number, name: string) => void;
  onEditPixels?: (firstgid: number, region: TileRegion) => void;
  onReorderTileset?: (fromFirstgid: number, toFirstgid: number) => void;
  hideHeader?: boolean;
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
  onRename,
  onEditPixels,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver,
}: {
  info: TilesetImageInfo;
  selectedRegion: TileRegion | null;
  onSelectRegion: (region: TileRegion) => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
  onEditPixels?: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragOver?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  const { img, firstgid, columns, tilewidth, tileheight, tilecount, name } = info;
  const rows = Math.ceil(tilecount / columns);
  const isCompact = rows === 1;

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

  // Check if selection is in this tileset for showing "Remove BG (Selection)" button
  const hasSelectionInThisTileset = selectedRegion && selectedRegion.firstgid === firstgid;

  return (
    <div
      className={`mb-3 ${isDragOver ? 'border-t-2 border-primary-light' : 'border-t-2 border-transparent'}`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(e);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div
        className="flex items-center justify-between px-1 py-1 cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <span className="text-caption text-text-secondary truncate flex items-center gap-1 min-w-0">
          {isEditing ? (
            <input
              ref={editRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => { const t = editName.trim(); if (t && t !== name) onRename(t); setIsEditing(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { const t = editName.trim(); if (t && t !== name) onRename(t); setIsEditing(false); } if (e.key === 'Escape') setIsEditing(false); }}
              onClick={(e) => e.stopPropagation()}
              className="bg-surface text-caption text-text px-1 py-0 rounded border border-border outline-none focus:border-primary-light w-full"
            />
          ) : (
            <span
              className="truncate"
              title={`${name} — double-click to rename`}
              onDoubleClick={() => { setEditName(name); setIsEditing(true); setTimeout(() => editRef.current?.select(), 0); }}
            >
              {name}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {name !== BUILTIN_TILESET_NAME && (
            <Tooltip label="Select All">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const region: TileRegion = {
                  firstgid,
                  col: 0,
                  row: 0,
                  width: columns,
                  height: rows,
                  gids: Array.from({ length: rows }, (_, r) =>
                    Array.from({ length: columns }, (_, c) => firstgid + r * columns + c),
                  ),
                };
                onSelectRegion(region);
              }}
            >
              <CheckSquare className="w-3.5 h-3.5" />
            </Button>
            </Tooltip>
          )}
          {onEditPixels && hasSelectionInThisTileset && (
            <Tooltip label="Edit Pixels">
            <Button
              variant="ghost"
              size="sm"
              onClick={onEditPixels}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
            </Tooltip>
          )}
          {name !== BUILTIN_TILESET_NAME && (
            <Tooltip label="Remove Tileset">
            <button
              onClick={onDelete}
              className="text-text-dim hover:text-danger text-body transition-colors px-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <canvas
          ref={canvasRef}
          className="cursor-crosshair"
          style={{
            width: '100%',
            imageRendering: 'pixelated',
            ...(isCompact ? { maxHeight: '48px', objectFit: 'contain' as const } : {}),
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
  onRenameTileset,
  onEditPixels,
  onReorderTileset,
  hideHeader,
}: TilePaletteProps) {
  // Drag reorder state
  const [dragFromFirstgid, setDragFromFirstgid] = useState<number | null>(null);
  const [dragOverFirstgid, setDragOverFirstgid] = useState<number | null>(null);

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
    <div>
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
          <span className="text-title text-text">Tilesets</span>
          <Button variant="ghost" size="sm" onClick={onImportTileset} title="Import Tileset (I)">
            Import (I)
          </Button>
        </div>
      )}

      {/* Selection info */}
      {selectionInfo && (
        <div className="px-3 py-1.5 bg-surface-raised text-caption text-text-secondary border-b border-border flex-shrink-0">
          {selectionInfo}
        </div>
      )}

      {/* Tileset list */}
      <div className="px-2 py-2">
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
            onRename={(newName) => onRenameTileset?.(info.firstgid, newName)}
            onEditPixels={
              onEditPixels && selectedRegion && selectedRegion.firstgid === info.firstgid
                ? () => onEditPixels(info.firstgid, selectedRegion!)
                : undefined
            }
            onDragStart={() => setDragFromFirstgid(info.firstgid)}
            onDragOver={(e: React.DragEvent) => {
              e.preventDefault();
              if (dragFromFirstgid != null && dragFromFirstgid !== info.firstgid) {
                setDragOverFirstgid(info.firstgid);
              }
            }}
            onDrop={() => {
              if (dragFromFirstgid != null && dragFromFirstgid !== info.firstgid && onReorderTileset) {
                onReorderTileset(dragFromFirstgid, info.firstgid);
              }
              setDragFromFirstgid(null);
              setDragOverFirstgid(null);
            }}
            onDragEnd={() => {
              setDragFromFirstgid(null);
              setDragOverFirstgid(null);
            }}
            isDragOver={dragOverFirstgid === info.firstgid}
          />
        ))}
      </div>
    </div>
  );
}
