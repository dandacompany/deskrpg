'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal, Input } from '@/components/ui';
import type { TiledTileset, TilesetImageInfo } from './hooks/useMapEditor';

export interface ImportTilesetResult {
  tileset: TiledTileset;
  imageInfo: TilesetImageInfo;
  imageDataUrl: string;
}

export interface ImportTilesetModalProps {
  open: boolean;
  onClose: () => void;
  existingTilesets: TiledTileset[];
  onImport: (result: ImportTilesetResult) => void;
  initialFile?: File | null;
}

interface SelectionRect {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export default function ImportTilesetModal({
  open,
  onClose,
  existingTilesets,
  onImport,
  initialFile,
}: ImportTilesetModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fileName, setFileName] = useState('');
  const [name, setName] = useState('');
  const [tileWidth, setTileWidth] = useState(32);
  const [tileHeight, setTileHeight] = useState(32);
  const [margin, setMargin] = useState(0);
  const [spacing, setSpacing] = useState(0);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<SelectionRect | null>(null);

  // Calculate grid dimensions
  const calcGrid = useCallback(() => {
    if (!image) return { columns: 0, rows: 0 };
    const usableW = image.naturalWidth - 2 * margin;
    const usableH = image.naturalHeight - 2 * margin;
    const columns = Math.max(1, Math.floor((usableW + spacing) / (tileWidth + spacing)));
    const rows = Math.max(1, Math.floor((usableH + spacing) / (tileHeight + spacing)));
    return { columns, rows };
  }, [image, tileWidth, tileHeight, margin, spacing]);

  // Draw preview canvas
  const drawPreview = useCallback(
    (sel: SelectionRect | null) => {
      const canvas = canvasRef.current;
      if (!canvas || !image) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);

      const { columns, rows } = calcGrid();

      // Draw grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      for (let c = 0; c <= columns; c++) {
        const x = margin + c * (tileWidth + spacing);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, margin);
        ctx.lineTo(x + 0.5, margin + rows * (tileHeight + spacing) - spacing);
        ctx.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = margin + r * (tileHeight + spacing);
        ctx.beginPath();
        ctx.moveTo(margin, y + 0.5);
        ctx.lineTo(margin + columns * (tileWidth + spacing) - spacing, y + 0.5);
        ctx.stroke();
      }

      // Selection highlight
      const s = sel || { startCol: 0, startRow: 0, endCol: columns - 1, endRow: rows - 1 };
      const minCol = Math.min(s.startCol, s.endCol);
      const minRow = Math.min(s.startRow, s.endRow);
      const maxCol = Math.max(s.startCol, s.endCol);
      const maxRow = Math.max(s.startRow, s.endRow);
      const sx = margin + minCol * (tileWidth + spacing);
      const sy = margin + minRow * (tileHeight + spacing);
      const sw = (maxCol - minCol + 1) * (tileWidth + spacing) - spacing;
      const sh = (maxRow - minRow + 1) * (tileHeight + spacing) - spacing;

      ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, sw, sh);
    },
    [image, calcGrid, tileWidth, tileHeight, margin, spacing],
  );

  // Redraw when settings change
  useEffect(() => {
    drawPreview(selection);
  }, [drawPreview, selection]);

  // File selection handler
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const baseName = file.name.replace(/\.[^.]+$/, '');
    setFileName(baseName);
    setName(baseName);
    setSelection(null);

    const img = new Image();
    img.onload = () => setImage(img);
    img.src = URL.createObjectURL(file);
  }, []);

  // Mouse handlers for selection on canvas
  const getCellFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !image) return null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const nativeX = (e.clientX - rect.left) * scaleX;
      const nativeY = (e.clientY - rect.top) * scaleY;
      const { columns, rows } = calcGrid();
      const col = Math.max(0, Math.min(columns - 1, Math.floor((nativeX - margin) / (tileWidth + spacing))));
      const row = Math.max(0, Math.min(rows - 1, Math.floor((nativeY - margin) / (tileHeight + spacing))));
      return { col, row };
    },
    [image, calcGrid, tileWidth, tileHeight, margin, spacing],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const cell = getCellFromEvent(e);
      if (!cell) return;
      const sel: SelectionRect = { startCol: cell.col, startRow: cell.row, endCol: cell.col, endRow: cell.row };
      dragRef.current = sel;
      setDragging(true);
      setSelection(sel);
      drawPreview(sel);
    },
    [getCellFromEvent, drawPreview],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dragging || !dragRef.current) return;
      const cell = getCellFromEvent(e);
      if (!cell) return;
      const updated = { ...dragRef.current, endCol: cell.col, endRow: cell.row };
      dragRef.current = updated;
      setSelection(updated);
      drawPreview(updated);
    },
    [dragging, getCellFromEvent, drawPreview],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
    dragRef.current = null;
  }, []);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setImage(null);
      setFileName('');
      setName('');
      setTileWidth(32);
      setTileHeight(32);
      setMargin(0);
      setSpacing(0);
      setSelection(null);
      setDragging(false);
    }
  }, [open]);

  // Load initial file (from drag-and-drop)
  useEffect(() => {
    if (!open || !initialFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        setImage(img);
        setFileName(initialFile.name);
        setName(initialFile.name.replace(/\.[^.]+$/, ''));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(initialFile);
  }, [open, initialFile]);

  // Import handler
  const handleImport = useCallback(() => {
    if (!image) return;

    const { columns, rows } = calcGrid();

    // Determine selection bounds (default = entire image)
    const sel = selection || { startCol: 0, startRow: 0, endCol: columns - 1, endRow: rows - 1 };
    const minCol = Math.min(sel.startCol, sel.endCol);
    const minRow = Math.min(sel.startRow, sel.endRow);
    const maxCol = Math.max(sel.startCol, sel.endCol);
    const maxRow = Math.max(sel.startRow, sel.endRow);
    const selW = maxCol - minCol + 1;
    const selH = maxRow - minRow + 1;
    const tilecount = selW * selH;

    // Create new tileset canvas with selected tiles
    const outCanvas = document.createElement('canvas');
    outCanvas.width = selW * tileWidth;
    outCanvas.height = selH * tileHeight;
    const outCtx = outCanvas.getContext('2d')!;

    for (let r = 0; r < selH; r++) {
      for (let c = 0; c < selW; c++) {
        const srcX = margin + (minCol + c) * (tileWidth + spacing);
        const srcY = margin + (minRow + r) * (tileHeight + spacing);
        outCtx.drawImage(image, srcX, srcY, tileWidth, tileHeight, c * tileWidth, r * tileHeight, tileWidth, tileHeight);
      }
    }

    const imageDataUrl = outCanvas.toDataURL('image/png');

    // Calculate firstgid
    let firstgid = 1;
    for (const ts of existingTilesets) {
      const end = ts.firstgid + ts.tilecount;
      if (end > firstgid) firstgid = end;
    }

    const tileset: TiledTileset = {
      firstgid,
      name: name || 'Imported Tileset',
      tilewidth: tileWidth,
      tileheight: tileHeight,
      tilecount,
      columns: selW,
      image: imageDataUrl,
      imagewidth: outCanvas.width,
      imageheight: outCanvas.height,
    };

    // Create image element for TilesetImageInfo
    const infoImg = new Image();
    infoImg.src = imageDataUrl;

    const imageInfo: TilesetImageInfo = {
      img: infoImg,
      firstgid,
      columns: selW,
      tilewidth: tileWidth,
      tileheight: tileHeight,
      tilecount,
      name: name || 'Imported Tileset',
    };

    onImport({ tileset, imageInfo, imageDataUrl });
    onClose();
  }, [image, calcGrid, selection, tileWidth, tileHeight, margin, spacing, name, existingTilesets, onImport, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Import Tileset" size="lg">
      <Modal.Body>
        <div className="space-y-4">
          {/* File picker */}
          <div>
            <label className="text-caption text-text-secondary block mb-1">Image File</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={handleFileChange}
              className="text-caption text-text file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-primary file:text-white file:text-caption file:cursor-pointer file:font-semibold"
            />
          </div>

          {/* Preview + Settings in two columns */}
          {image && (
            <div className="flex gap-4">
              {/* Preview canvas */}
              <div className="flex-1 min-w-0 overflow-x-auto border border-border rounded-md bg-surface p-2">
                <canvas
                  ref={canvasRef}
                  className="cursor-crosshair"
                  style={{ width: '100%', minWidth: '200px', imageRendering: 'pixelated' }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                />
              </div>

              {/* Settings */}
              <div className="w-48 flex-shrink-0 space-y-3">
                <div>
                  <label className="text-caption text-text-secondary block mb-1">Name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tileset name" />
                </div>
                <div>
                  <label className="text-caption text-text-secondary block mb-1">Tile Width</label>
                  <Input type="number" value={tileWidth} onChange={(e) => setTileWidth(Math.max(1, Number(e.target.value)))} min={1} />
                </div>
                <div>
                  <label className="text-caption text-text-secondary block mb-1">Tile Height</label>
                  <Input type="number" value={tileHeight} onChange={(e) => setTileHeight(Math.max(1, Number(e.target.value)))} min={1} />
                </div>
                <div>
                  <label className="text-caption text-text-secondary block mb-1">Margin</label>
                  <Input type="number" value={margin} onChange={(e) => setMargin(Math.max(0, Number(e.target.value)))} min={0} />
                </div>
                <div>
                  <label className="text-caption text-text-secondary block mb-1">Spacing</label>
                  <Input type="number" value={spacing} onChange={(e) => setSpacing(Math.max(0, Number(e.target.value)))} min={0} />
                </div>
                <div className="text-caption text-text-dim pt-1">
                  {(() => {
                    const { columns, rows } = calcGrid();
                    return `${columns} x ${rows} tiles (${columns * rows} total)`;
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleImport} disabled={!image}>
          Import
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
