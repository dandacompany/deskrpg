'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { LAYER_COLORS } from './hooks/useMapEditor';
import type { StampData, StampLayerData, StampTilesetData } from '@/lib/stamp-utils';

interface StampEditorModalProps {
  open: boolean;
  onClose: () => void;
  stamp: StampData;
  onSave: (updated: { name?: string; cols?: number; rows?: number; layers: StampLayerData[]; tilesets: StampTilesetData[]; thumbnail: string | null }) => void;
  onOpenPixelEditor: (imageDataUrl: string, cols: number, rows: number, tileWidth: number, tileHeight: number, onResult: (dataUrl: string, newCols: number, newRows: number) => void) => void;
  onDelete?: (stampId: string) => void;
  mapLayerNames?: string[];
}

function getLayerColorByName(name: string) {
  const key = name.toLowerCase() as keyof typeof LAYER_COLORS;
  return LAYER_COLORS[key] ?? { solid: '#6b7280', overlay: 'rgba(107, 114, 128, 0.12)' };
}

const DEFAULT_LAYERS = ['Floor', 'Walls', 'Foreground', 'Collision'];

const parseLayers = (v: unknown, cols: number, rows: number, extraLayerNames?: string[]): StampLayerData[] => {
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  const layers: StampLayerData[] = Array.isArray(parsed) ? parsed : [];
  // Merge standard layers + map's custom layers (deduplicated)
  const allNames = [...DEFAULT_LAYERS];
  if (extraLayerNames) {
    for (const name of extraLayerNames) {
      if (!allNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
        allNames.push(name);
      }
    }
  }
  const existing = new Set(layers.map((l) => l.name.toLowerCase()));
  for (const name of allNames) {
    if (!existing.has(name.toLowerCase())) {
      layers.push({ name, type: 'tilelayer', depth: 0, data: new Array(cols * rows).fill(0) });
    }
  }
  return layers;
};
const parseTilesets = (v: unknown): StampTilesetData[] => {
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) ? parsed : [];
};

export default function StampEditorModal({
  open, onClose, stamp, onSave, onOpenPixelEditor, onDelete, mapLayerNames,
}: StampEditorModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [layers, setLayers] = useState<StampLayerData[]>(parseLayers(stamp.layers, stamp.cols, stamp.rows, mapLayerNames));
  const [tilesets, setTilesets] = useState<StampTilesetData[]>(parseTilesets(stamp.tilesets));
  const [tilesetImages, setTilesetImages] = useState<Map<number, HTMLImageElement>>(new Map());
  const [stampCols, setStampCols] = useState(stamp.cols);
  const [stampRows, setStampRows] = useState(stamp.rows);
  const [dirty, setDirty] = useState(false);
  const [selectedTile, setSelectedTile] = useState<{ col: number; row: number; col2: number; row2: number } | null>(null);
  const isDraggingSelRef = useRef(false);
  const dragStartRef = useRef<{ col: number; row: number } | null>(null);
  // Refs to avoid stale closures in pixel editor callback
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const tilesetsRef = useRef(tilesets);
  tilesetsRef.current = tilesets;
  const stampColsRef = useRef(stampCols);
  stampColsRef.current = stampCols;
  const stampRowsRef = useRef(stampRows);
  stampRowsRef.current = stampRows;
  const [stampName, setStampName] = useState(stamp.name);
  const [editingName, setEditingName] = useState(false);

  // Calculate zoom to fill canvas area nicely
  const DISPLAY_TILE_SIZE = 64; // each tile displayed at this size

  useEffect(() => {
    setLayers(parseLayers(stamp.layers, stamp.cols, stamp.rows, mapLayerNames));
    setTilesets(parseTilesets(stamp.tilesets));
    setStampCols(stamp.cols);
    setStampRows(stamp.rows);
    setActiveLayerIndex(0);
    setDirty(false);
    setSelectedTile(null);
    setStampName(stamp.name);
    setEditingName(false);
  }, [stamp.id]);

  useEffect(() => {
    const map = new Map<number, HTMLImageElement>();
    let completed = 0;
    const allTilesets = tilesets;
    if (allTilesets.length === 0) { setTilesetImages(new Map()); return; }
    for (const ts of allTilesets) {
      const img = new Image();
      const done = () => {
        map.set(ts.firstgid, img);
        completed++;
        if (completed === allTilesets.length) setTilesetImages(new Map(map));
      };
      img.onload = done;
      img.onerror = done; // still count failed loads to unblock rendering
      img.src = ts.image;
    }
  }, [tilesets]);

  const findTileset = useCallback((gid: number) => {
    if (gid === 0) return null;
    let best: StampTilesetData | null = null;
    for (const ts of tilesets) {
      if (gid >= ts.firstgid && (!best || ts.firstgid > best.firstgid)) best = ts;
    }
    return best;
  }, [tilesets]);

  // Get which layer owns a tile at (col, row) — returns layer index or -1
  const getTileOwnerLayer = useCallback((col: number, row: number): number => {
    const idx = row * stampCols + col;
    // Check layers from top (last) to bottom (first) — topmost non-zero wins
    for (let li = layers.length - 1; li >= 0; li--) {
      if (layers[li].data[idx] !== 0) return li;
    }
    return -1;
  }, [layers, stampCols]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tilesetImages.size === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ds = DISPLAY_TILE_SIZE;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    canvas.width = stampCols * ds;
    canvas.height = stampRows * ds;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    // Draw checkerboard background
    for (let row = 0; row < stampRows; row++) {
      for (let col = 0; col < stampCols; col++) {
        ctx.fillStyle = (col + row) % 2 === 0 ? '#1a1a2e' : '#16162a';
        ctx.fillRect(col * ds, row * ds, ds, ds);
      }
    }

    // Draw each layer
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const isActive = li === activeLayerIndex;
      ctx.globalAlpha = isActive ? 1.0 : 0.4;

      for (let i = 0; i < layer.data.length; i++) {
        const gid = layer.data[i];
        if (gid === 0) continue;
        const ts = findTileset(gid);
        if (!ts) continue;
        const img = tilesetImages.get(ts.firstgid);
        if (!img) continue;
        const localId = gid - ts.firstgid;
        const srcCol = localId % ts.columns;
        const srcRow = Math.floor(localId / ts.columns);
        const dstCol = i % stampCols;
        const dstRow = Math.floor(i / stampCols);
        ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * ds, dstRow * ds, ds, ds);
      }

      // Active layer color overlay on non-empty tiles
      if (isActive) {
        const lc = getLayerColorByName(layer.name);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lc.overlay;
        for (let i = 0; i < layer.data.length; i++) {
          if (layer.data[i] !== 0) {
            const col = i % stampCols;
            const row = Math.floor(i / stampCols);
            ctx.fillRect(col * ds, row * ds, ds, ds);
          }
        }
      }
    }

    ctx.globalAlpha = 1;

    // Layer color badge per tile (small dot in corner showing which layer owns it)
    for (let row = 0; row < stampRows; row++) {
      for (let col = 0; col < stampCols; col++) {
        const ownerIdx = getTileOwnerLayer(col, row);
        if (ownerIdx < 0) continue;
        const lc = getLayerColorByName(layers[ownerIdx].name);
        ctx.fillStyle = lc.solid;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(col * ds + 8, row * ds + 8, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Tile grid lines
    ctx.strokeStyle = 'rgba(0,255,100,0.3)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= stampCols; x++) {
      ctx.beginPath(); ctx.moveTo(x * ds, 0); ctx.lineTo(x * ds, stampRows * ds); ctx.stroke();
    }
    for (let y = 0; y <= stampRows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * ds); ctx.lineTo(stampCols * ds, y * ds); ctx.stroke();
    }

    // Selected tile(s) highlight
    if (selectedTile) {
      const minCol = Math.min(selectedTile.col, selectedTile.col2);
      const maxCol = Math.max(selectedTile.col, selectedTile.col2);
      const minRow = Math.min(selectedTile.row, selectedTile.row2);
      const maxRow = Math.max(selectedTile.row, selectedTile.row2);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      const sx = minCol * ds + 1.5;
      const sy = minRow * ds + 1.5;
      const sw = (maxCol - minCol + 1) * ds - 3;
      const sh = (maxRow - minRow + 1) * ds - 3;
      ctx.strokeRect(sx, sy, sw, sh);
    }
  }, [layers, activeLayerIndex, tilesetImages, stamp, findTileset, selectedTile, getTileOwnerLayer]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // Handle canvas mouse events — drag to select tile range
  const getCanvasTile = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const col = Math.max(0, Math.min(stampCols - 1, Math.floor(mx / DISPLAY_TILE_SIZE)));
    const row = Math.max(0, Math.min(stampRows - 1, Math.floor(my / DISPLAY_TILE_SIZE)));
    return { col, row };
  }, [stampCols, stampRows]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const tile = getCanvasTile(e);
    if (!tile) return;
    isDraggingSelRef.current = true;
    dragStartRef.current = tile;
    setSelectedTile({ col: tile.col, row: tile.row, col2: tile.col, row2: tile.row });
  }, [getCanvasTile]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingSelRef.current || !dragStartRef.current) return;
    const tile = getCanvasTile(e);
    if (!tile) return;
    const start = dragStartRef.current;
    setSelectedTile({ col: start.col, row: start.row, col2: tile.col, row2: tile.row });
  }, [getCanvasTile]);

  const handleCanvasMouseUp = useCallback(() => {
    isDraggingSelRef.current = false;
  }, []);

  // Move selected tile(s) to a different layer
  const moveTileToLayer = useCallback((targetLayerIndex: number) => {
    if (!selectedTile) return;
    const minCol = Math.min(selectedTile.col, selectedTile.col2);
    const maxCol = Math.max(selectedTile.col, selectedTile.col2);
    const minRow = Math.min(selectedTile.row, selectedTile.row2);
    const maxRow = Math.max(selectedTile.row, selectedTile.row2);

    const newLayers = layers.map((layer, li) => {
      const newData = [...layer.data];
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const idx = r * stampCols + c;
          if (li === targetLayerIndex) {
            for (const srcLayer of layers) {
              if (srcLayer.data[idx] !== 0) {
                newData[idx] = srcLayer.data[idx];
                break;
              }
            }
          } else {
            newData[idx] = 0;
          }
        }
      }
      return { ...layer, data: newData };
    });
    setLayers(newLayers);
    setDirty(true);
  }, [selectedTile, layers, stampCols]);

  // Delete selected tile(s) from active layer
  const deleteSelectedTiles = useCallback(() => {
    if (!selectedTile) return;
    const minCol = Math.min(selectedTile.col, selectedTile.col2);
    const maxCol = Math.max(selectedTile.col, selectedTile.col2);
    const minRow = Math.min(selectedTile.row, selectedTile.row2);
    const maxRow = Math.max(selectedTile.row, selectedTile.row2);

    const newLayers = [...layers];
    const layer = newLayers[activeLayerIndex];
    const newData = [...layer.data];
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        newData[r * stampCols + c] = 0;
      }
    }
    newLayers[activeLayerIndex] = { ...layer, data: newData };
    setLayers(newLayers);
    setDirty(true);
  }, [selectedTile, layers, activeLayerIndex, stampCols]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTile) {
        e.preventDefault();
        deleteSelectedTiles();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, selectedTile, deleteSelectedTiles]);

  // Handle layer click — switch active layer only (tile move is via dropdown)
  const handleLayerClick = useCallback((idx: number) => {
    setActiveLayerIndex(idx);
  }, [selectedTile, layers, stampCols, getTileOwnerLayer, moveTileToLayer]);

  const buildLayerImage = useCallback((layerIndex: number): string | null => {
    const layer = layers[layerIndex];
    if (!layer) return null;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width = stampCols * tw;
    offscreen.height = stampRows * th;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;
    for (let i = 0; i < layer.data.length; i++) {
      const gid = layer.data[i];
      if (gid === 0) continue;
      const ts = findTileset(gid);
      if (!ts) continue;
      const img = tilesetImages.get(ts.firstgid);
      if (!img) continue;
      const localId = gid - ts.firstgid;
      const srcCol = localId % ts.columns;
      const srcRow = Math.floor(localId / ts.columns);
      const dstCol = i % stampCols;
      const dstRow = Math.floor(i / stampCols);
      ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * tw, dstRow * th, tw, th);
    }
    return offscreen.toDataURL('image/png');
  }, [layers, tilesetImages, stamp, findTileset]);

  const handleEditPixels = useCallback(() => {
    const imageDataUrl = buildLayerImage(activeLayerIndex);
    if (!imageDataUrl) return;
    onOpenPixelEditor(imageDataUrl, stampCols, stampRows, stamp.tileWidth, stamp.tileHeight, (resultDataUrl: string, newCols: number, newRows: number) => {
      // Use refs to get current values (avoid stale closure)
      const currentLayers = layersRef.current;
      const currentTilesets = tilesetsRef.current;
      const layer = currentLayers[activeLayerIndex];
      const tileCount = newCols * newRows;
      const oldCols = stampColsRef.current;
      const oldRows = stampRowsRef.current;

      // Check if this layer has a dedicated tileset (not shared with other layers)
      const firstGid = layer.data.find((g) => g !== 0);
      const existingTs = firstGid ? findTileset(firstGid) : null;

      // Check if other layers also use this tileset
      let isShared = false;
      if (existingTs) {
        for (let li = 0; li < currentLayers.length; li++) {
          if (li === activeLayerIndex) continue;
          for (const gid of currentLayers[li].data) {
            if (gid !== 0 && gid >= existingTs.firstgid && gid < existingTs.firstgid + existingTs.tilecount) {
              isShared = true;
              break;
            }
          }
          if (isShared) break;
        }
      }

      // If shared, always create a new tileset; if dedicated, reuse its firstgid
      const baseGid = (existingTs && !isShared)
        ? existingTs.firstgid
        : currentTilesets.reduce((max, ts) => Math.max(max, ts.firstgid + ts.tilecount), 1);
      const isNewTileset = !existingTs || isShared;

      // Detect which tiles have actual pixel content by loading the edited image
      const img = new Image();
      img.onload = () => {
        const tw = stamp.tileWidth;
        const th = stamp.tileHeight;
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = img.width;
        tmpCanvas.height = img.height;
        const tmpCtx = tmpCanvas.getContext('2d')!;
        tmpCtx.drawImage(img, 0, 0);

        // Build GID data: check each tile for non-transparent pixels
        const newData: number[] = [];
        for (let r = 0; r < newRows; r++) {
          for (let c = 0; c < newCols; c++) {
            const tileData = tmpCtx.getImageData(c * tw, r * th, tw, th).data;
            let hasContent = false;
            for (let i = 3; i < tileData.length; i += 4) {
              if (tileData[i] > 0) { hasContent = true; break; }
            }
            if (hasContent) {
              newData.push(baseGid + r * newCols + c);
            } else {
              newData.push(0);
            }
          }
        }

        // Use a unique name so it won't accidentally match map tilesets by name
        const editedTsName = `stamp-edited-${layer.name}`;
        if (!isNewTileset) {
          // Dedicated tileset — update in place
          const updatedTilesets = currentTilesets.map((ts) =>
            ts.firstgid === baseGid
              ? { ...ts, name: editedTsName, image: resultDataUrl, columns: newCols, tilecount: tileCount }
              : ts,
          );
          setTilesets(updatedTilesets);
        } else {
          // Shared or no tileset — create new one (keep original for other layers)
          const newTileset: StampTilesetData = {
            name: editedTsName, firstgid: baseGid,
            tilewidth: stamp.tileWidth, tileheight: stamp.tileHeight,
            columns: newCols, tilecount: tileCount, image: resultDataUrl,
          };
          setTilesets(prev => [...prev, newTileset]);
        }

        // Update layer data and stamp dimensions
        const newLayers = [...currentLayers];
        newLayers[activeLayerIndex] = { ...layer, data: newData };

        // Also resize other layers if grid size changed
        if (newCols !== oldCols || newRows !== oldRows) {
          for (let i = 0; i < newLayers.length; i++) {
            if (i === activeLayerIndex) continue;
            const otherLayer = newLayers[i];
            const resizedData: number[] = [];
            for (let r = 0; r < newRows; r++) {
              for (let c = 0; c < newCols; c++) {
                if (r < oldRows && c < oldCols) {
                  resizedData.push(otherLayer.data[r * oldCols + c]);
                } else {
                  resizedData.push(0);
                }
              }
            }
            newLayers[i] = { ...otherLayer, data: resizedData };
          }
          setStampCols(newCols);
          setStampRows(newRows);
        }

        setLayers(newLayers);
        setDirty(true);
      };
      img.src = resultDataUrl;
    });
  }, [activeLayerIndex, layers, tilesets, stamp, buildLayerImage, onOpenPixelEditor]);

  const generateCleanThumbnail = useCallback((): string | null => {
    if (tilesetImages.size === 0) return null;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width = stampCols * tw;
    offscreen.height = stampRows * th;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;

    // Draw only tile pixels — no grid, no overlays, no selection
    for (const layer of layers) {
      for (let i = 0; i < layer.data.length; i++) {
        const gid = layer.data[i];
        if (gid === 0) continue;
        const ts = findTileset(gid);
        if (!ts) continue;
        const img = tilesetImages.get(ts.firstgid);
        if (!img) continue;
        const localId = gid - ts.firstgid;
        const srcCol = localId % ts.columns;
        const srcRow = Math.floor(localId / ts.columns);
        const dstCol = i % stampCols;
        const dstRow = Math.floor(i / stampCols);
        ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * tw, dstRow * th, tw, th);
      }
    }
    return offscreen.toDataURL('image/png');
  }, [layers, tilesetImages, stamp.tileWidth, stamp.tileHeight, stampCols, stampRows, findTileset]);

  const handleSave = useCallback(() => {
    const thumbnail = generateCleanThumbnail();
    onSave({
      name: stampName !== stamp.name ? stampName : undefined,
      cols: stampCols !== stamp.cols ? stampCols : undefined,
      rows: stampRows !== stamp.rows ? stampRows : undefined,
      layers, tilesets, thumbnail,
    });
  }, [layers, tilesets, stampName, stamp.name, stampCols, stampRows, stamp.cols, stamp.rows, onSave, generateCleanThumbnail]);

  const activeLayer = layers[activeLayerIndex];
  const selectedTileOwner = selectedTile ? getTileOwnerLayer(Math.min(selectedTile.col, selectedTile.col2), Math.min(selectedTile.row, selectedTile.row2)) : -1;

  return (
    <Modal open={open} onClose={onClose} title={
      <span>
        {t('mapEditor.stamps.stampEditor')} -{' '}
        {editingName ? (
          <input
            autoFocus
            className="bg-transparent border-b border-primary-light text-text outline-none px-0.5"
            value={stampName}
            onChange={(e) => { setStampName(e.target.value); setDirty(true); }}
            onBlur={() => setEditingName(false)}
            onKeyDown={(e) => { if (e.key === 'Enter') setEditingName(false); if (e.key === 'Escape') { setStampName(stamp.name); setEditingName(false); } }}
          />
        ) : (
          <span className="cursor-pointer hover:text-primary-light transition-colors" onDoubleClick={() => setEditingName(true)}>
            {stampName}
          </span>
        )}
      </span>
    } size="lg">
      <div className="flex" style={{ height: '60vh' }}>
        {/* Layer Panel */}
        <div className="w-48 border-r border-border p-2 flex flex-col gap-1 flex-shrink-0 overflow-y-auto">
          <div className="text-micro text-text-dim uppercase tracking-wider mb-1">{t('mapEditor.stamps.layers')}</div>
          {layers.map((layer, idx) => {
            const isActive = idx === activeLayerIndex;
            const lc = getLayerColorByName(layer.name);
            const count = layer.data.filter((g) => g !== 0).length;
            const isOwner = selectedTileOwner === idx;
            return (
              <button key={idx} onClick={() => handleLayerClick(idx)}
                className={`w-full text-left rounded-md px-2 py-1.5 transition-colors flex items-center gap-2 ${isActive ? 'border' : 'border border-transparent hover:bg-surface-raised'}`}
                style={isActive ? { backgroundColor: `${lc.solid}15`, borderColor: `${lc.solid}40` } : {}}
              >
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: lc.solid }} />
                <span className={`text-caption truncate ${isActive ? 'text-text' : 'text-text-secondary'}`}>{layer.name}</span>
                {isOwner && selectedTile && (
                  <span className="text-micro text-amber-400">●</span>
                )}
                <span className="text-micro text-text-dim ml-auto">{count}</span>
              </button>
            );
          })}

          {/* Add Layer */}
          {(() => {
            const allLayerNames = [...DEFAULT_LAYERS];
            if (mapLayerNames) {
              for (const name of mapLayerNames) {
                if (!allLayerNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
                  allLayerNames.push(name);
                }
              }
            }
            const existing = new Set(layers.map((l) => l.name.toLowerCase()));
            const available = allLayerNames.filter((n) => !existing.has(n.toLowerCase()));
            if (available.length === 0) return null;
            return (
              <div className="mt-1">
                <select
                  className="w-full text-micro bg-surface-raised border border-border rounded px-1.5 py-1 text-text-secondary cursor-pointer"
                  value=""
                  onChange={(e) => {
                    const name = e.target.value;
                    if (!name) return;
                    const emptyData = new Array(stampCols * stampRows).fill(0);
                    setLayers((prev) => [...prev, { name, type: 'tilelayer', depth: 0, data: emptyData }]);
                    setDirty(true);
                  }}
                >
                  <option value="">+ {t('mapEditor.stamps.addLayer')}</option>
                  {available.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            );
          })()}

          {/* Selected tile info — show ALL layers that have a tile here */}
          {selectedTile && (() => {
            const minCol = Math.min(selectedTile.col, selectedTile.col2);
            const maxCol = Math.max(selectedTile.col, selectedTile.col2);
            const minRow = Math.min(selectedTile.row, selectedTile.row2);
            const maxRow = Math.max(selectedTile.row, selectedTile.row2);
            const isSingle = minCol === maxCol && minRow === maxRow;

            // For display: collect layers that have content in any selected tile
            const tileLayers = layers
              .map((layer, li) => {
                let hasContent = false;
                for (let r = minRow; r <= maxRow && !hasContent; r++) {
                  for (let c = minCol; c <= maxCol && !hasContent; c++) {
                    if (layer.data[r * stampCols + c] !== 0) hasContent = true;
                  }
                }
                return { li, layer, hasContent };
              })
              .filter((t) => t.hasContent);

            return (
              <div className="mt-2 pt-2 border-t border-border">
                <div className="text-micro text-text-dim mb-1.5">
                  {t('mapEditor.stamps.selectedTile')} {isSingle ? `(${minCol}, ${minRow})` : `(${minCol},${minRow})-(${maxCol},${maxRow})`}
                </div>
                {tileLayers.length === 0 ? (
                  <div className="text-micro text-text-dim">{t('mapEditor.stamps.emptyTile')}</div>
                ) : (
                  <div className="space-y-1.5">
                    {tileLayers.map(({ li, layer }) => {
                      const lc = getLayerColorByName(layer.name);
                      return (
                        <div key={li} className="flex items-center gap-1.5">
                          <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: lc.solid }} />
                          <span className="text-micro text-text-secondary flex-1 truncate">{layer.name}</span>
                          {/* Move to layer dropdown */}
                          {layers.length > 1 && (
                            <select
                              className="text-micro bg-surface-raised border border-border rounded px-1 py-0.5 text-text-dim cursor-pointer"
                              value=""
                              onChange={(e) => {
                                const targetIdx = Number(e.target.value);
                                if (isNaN(targetIdx)) return;
                                moveTileToLayer(targetIdx);
                              }}
                            >
                              <option value="">{t('mapEditor.stamps.moveTo')}</option>
                              {layers.map((targetLayer, ti) => {
                                if (ti === li) return null;
                                return <option key={ti} value={ti}>→ {targetLayer.name}</option>;
                              })}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Canvas Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-9 border-b border-border flex items-center px-3 gap-2 flex-shrink-0">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: getLayerColorByName(activeLayer?.name ?? '').solid }} />
            <span className="text-caption text-text">{activeLayer?.name}</span>
            <span className="text-micro text-text-dim ml-auto">{stampCols} x {stampRows}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-bg-deep p-4">
            <canvas
              ref={canvasRef}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              className="cursor-crosshair"
              style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }}
            />
          </div>
        </div>
      </div>

      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
        {onDelete && (
          <Button variant="danger" size="sm" onClick={() => {
            if (confirm(t('mapEditor.stamps.confirmDelete'))) {
              onDelete(stamp.id);
            }
          }}>{t('common.delete')}</Button>
        )}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={handleEditPixels}>{t('mapEditor.stamps.editPixels')}</Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty}>{t('common.save')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
