'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';
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
  projectId?: string | null;
  onLinkTileset?: (tilesetId: string, firstgid: number) => void;
}

interface SelectionRect {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

interface LibraryTileset {
  id: string;
  name: string;
  tilewidth: number;
  tileheight: number;
  columns: number;
  tilecount: number;
  image: string;
}

export default function ImportTilesetModal({
  open,
  onClose,
  existingTilesets,
  onImport,
  initialFile,
  projectId,
  onLinkTileset,
}: ImportTilesetModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<'upload' | 'myTilesets' | 'builtIn'>('upload');
  const [libraryTilesets, setLibraryTilesets] = useState<LibraryTileset[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

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

  // Fetch library tilesets
  const fetchLibrary = useCallback(async (builtIn: boolean) => {
    setLibraryLoading(true);
    try {
      const res = await fetch(`/api/tilesets?builtIn=${builtIn}`);
      if (res.ok) setLibraryTilesets(await res.json());
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'myTilesets') fetchLibrary(false);
    else if (activeTab === 'builtIn') fetchLibrary(true);
  }, [activeTab, fetchLibrary]);

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
      setActiveTab('upload');
      setLibraryTilesets([]);
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
  const handleImport = useCallback(async () => {
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

    // Save tileset to DB and link to project (await before closing)
    if (projectId) {
      try {
        const saveRes = await fetch('/api/tilesets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name || 'Imported Tileset',
            tilewidth: tileWidth,
            tileheight: tileHeight,
            columns: selW,
            tilecount,
            image: imageDataUrl,
          }),
        });
        if (saveRes.ok) {
          const saved = await saveRes.json();
          await onLinkTileset?.(saved.id, firstgid);
        }
      } catch (err) {
        console.error('Failed to save tileset to DB:', err);
      }
    }

    onClose();
  }, [image, calcGrid, selection, tileWidth, tileHeight, margin, spacing, name, existingTilesets, onImport, onClose, projectId, onLinkTileset]);

  return (
    <Modal open={open} onClose={onClose} title={t('mapEditor.importTileset.title')} size="lg">
      <Modal.Body>
        {/* Tab bar */}
        <div className="flex border-b border-gray-700 mb-4">
          {(['upload', 'myTilesets', 'builtIn'] as const).map((tab) => (
            <button
              key={tab}
              className={`px-4 py-2 text-sm ${
                activeTab === tab
                  ? 'border-b-2 border-blue-500 text-blue-400'
                  : 'text-gray-400 hover:text-white'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'upload' && t('mapEditor.assets.tabUpload')}
              {tab === 'myTilesets' && t('mapEditor.assets.tabMyTilesets')}
              {tab === 'builtIn' && t('mapEditor.assets.tabBuiltIn')}
            </button>
          ))}
        </div>

        {/* Upload tab */}
        {activeTab === 'upload' && (
          <div className="space-y-4">
            {/* File picker */}
            <div>
              <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.imageFile')}</label>
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
                    <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.name')}</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('mapEditor.importTileset.namePlaceholder')} />
                  </div>
                  <div>
                    <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.tileWidth')}</label>
                    <Input type="number" value={tileWidth} onChange={(e) => setTileWidth(Math.max(1, Number(e.target.value)))} min={1} />
                  </div>
                  <div>
                    <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.tileHeight')}</label>
                    <Input type="number" value={tileHeight} onChange={(e) => setTileHeight(Math.max(1, Number(e.target.value)))} min={1} />
                  </div>
                  <div>
                    <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.margin')}</label>
                    <Input type="number" value={margin} onChange={(e) => setMargin(Math.max(0, Number(e.target.value)))} min={0} />
                  </div>
                  <div>
                    <label className="text-caption text-text-secondary block mb-1">{t('mapEditor.importTileset.spacing')}</label>
                    <Input type="number" value={spacing} onChange={(e) => setSpacing(Math.max(0, Number(e.target.value)))} min={0} />
                  </div>
                  <div className="text-caption text-text-dim pt-1">
                    {(() => {
                      const { columns, rows } = calcGrid();
                      return t('mapEditor.importTileset.tileInfo', { columns, rows, total: columns * rows });
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Library tabs (My Tilesets / Built-in) */}
        {activeTab !== 'upload' && (
          <div className="grid grid-cols-3 gap-3 max-h-80 overflow-auto p-4">
            {libraryLoading ? (
              <div className="col-span-3 text-center text-gray-500 py-8">Loading...</div>
            ) : libraryTilesets.length === 0 ? (
              <div className="col-span-3 text-center text-gray-500 py-8">{t('mapEditor.assets.noTilesets')}</div>
            ) : (
              libraryTilesets.map((ts) => (
                <button
                  key={ts.id}
                  className="flex flex-col items-center p-2 bg-gray-800 rounded border border-gray-700 hover:border-blue-500"
                  onClick={() => {
                    const img = new Image();
                    img.src = ts.image;
                    img.onload = () => {
                      const nextFirstgid = existingTilesets.reduce(
                        (max, t) => Math.max(max, t.firstgid + t.tilecount),
                        1,
                      );
                      onImport({
                        tileset: {
                          firstgid: nextFirstgid,
                          name: ts.name,
                          tilewidth: ts.tilewidth,
                          tileheight: ts.tileheight,
                          tilecount: ts.tilecount,
                          columns: ts.columns,
                          image: ts.image,
                          imagewidth: ts.columns * ts.tilewidth,
                          imageheight: Math.ceil(ts.tilecount / ts.columns) * ts.tileheight,
                        },
                        imageInfo: {
                          img,
                          firstgid: nextFirstgid,
                          columns: ts.columns,
                          tilewidth: ts.tilewidth,
                          tileheight: ts.tileheight,
                          tilecount: ts.tilecount,
                          name: ts.name,
                        },
                        imageDataUrl: ts.image,
                      });
                      onLinkTileset?.(ts.id, nextFirstgid);
                      onClose();
                    };
                  }}
                >
                  <img src={ts.image} alt={ts.name} className="w-16 h-16 object-contain bg-gray-900 rounded" />
                  <span className="text-xs text-gray-300 mt-1 truncate w-full text-center">{ts.name}</span>
                  <span className="text-xs text-gray-500">{ts.tilewidth}×{ts.tileheight}</span>
                </button>
              ))
            )}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {activeTab === 'upload' && (
          <Button variant="primary" onClick={handleImport} disabled={!image}>
            {t('mapEditor.importTileset.import')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}
