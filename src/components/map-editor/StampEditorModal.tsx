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
  onSave: (updated: { name?: string; layers: StampLayerData[]; tilesets: StampTilesetData[]; thumbnail: string | null }) => void;
  onOpenPixelEditor: (imageDataUrl: string, cols: number, rows: number, tileWidth: number, tileHeight: number, onResult: (dataUrl: string) => void) => void;
}

function getLayerColorByName(name: string) {
  const key = name.toLowerCase() as keyof typeof LAYER_COLORS;
  return LAYER_COLORS[key] ?? { solid: '#6b7280', overlay: 'rgba(107, 114, 128, 0.12)' };
}

const parseLayers = (v: unknown): StampLayerData[] => {
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) ? parsed : [];
};
const parseTilesets = (v: unknown): StampTilesetData[] => {
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) ? parsed : [];
};

export default function StampEditorModal({
  open, onClose, stamp, onSave, onOpenPixelEditor,
}: StampEditorModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [layers, setLayers] = useState<StampLayerData[]>(parseLayers(stamp.layers));
  const [tilesets, setTilesets] = useState<StampTilesetData[]>(parseTilesets(stamp.tilesets));
  const [tilesetImages, setTilesetImages] = useState<Map<number, HTMLImageElement>>(new Map());
  const [dirty, setDirty] = useState(false);
  const [selectedTile, setSelectedTile] = useState<{ col: number; row: number } | null>(null);
  const [stampName, setStampName] = useState(stamp.name);
  const [editingName, setEditingName] = useState(false);

  // Calculate zoom to fill canvas area nicely
  const DISPLAY_TILE_SIZE = 64; // each tile displayed at this size

  useEffect(() => {
    setLayers(parseLayers(stamp.layers));
    setTilesets(parseTilesets(stamp.tilesets));
    setActiveLayerIndex(0);
    setDirty(false);
    setSelectedTile(null);
    setStampName(stamp.name);
    setEditingName(false);
  }, [stamp.id]);

  useEffect(() => {
    const map = new Map<number, HTMLImageElement>();
    let loaded = 0;
    const allTilesets = tilesets;
    if (allTilesets.length === 0) { setTilesetImages(new Map()); return; }
    for (const ts of allTilesets) {
      const img = new Image();
      img.onload = () => {
        map.set(ts.firstgid, img);
        loaded++;
        if (loaded === allTilesets.length) setTilesetImages(new Map(map));
      };
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
    const idx = row * stamp.cols + col;
    // Check layers from top (last) to bottom (first) — topmost non-zero wins
    for (let li = layers.length - 1; li >= 0; li--) {
      if (layers[li].data[idx] !== 0) return li;
    }
    return -1;
  }, [layers, stamp.cols]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tilesetImages.size === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ds = DISPLAY_TILE_SIZE;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    canvas.width = stamp.cols * ds;
    canvas.height = stamp.rows * ds;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;

    // Draw checkerboard background
    for (let row = 0; row < stamp.rows; row++) {
      for (let col = 0; col < stamp.cols; col++) {
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
        const dstCol = i % stamp.cols;
        const dstRow = Math.floor(i / stamp.cols);
        ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * ds, dstRow * ds, ds, ds);
      }

      // Active layer color overlay on non-empty tiles
      if (isActive) {
        const lc = getLayerColorByName(layer.name);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lc.overlay;
        for (let i = 0; i < layer.data.length; i++) {
          if (layer.data[i] !== 0) {
            const col = i % stamp.cols;
            const row = Math.floor(i / stamp.cols);
            ctx.fillRect(col * ds, row * ds, ds, ds);
          }
        }
      }
    }

    ctx.globalAlpha = 1;

    // Layer color badge per tile (small dot in corner showing which layer owns it)
    for (let row = 0; row < stamp.rows; row++) {
      for (let col = 0; col < stamp.cols; col++) {
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
    for (let x = 0; x <= stamp.cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * ds, 0); ctx.lineTo(x * ds, stamp.rows * ds); ctx.stroke();
    }
    for (let y = 0; y <= stamp.rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * ds); ctx.lineTo(stamp.cols * ds, y * ds); ctx.stroke();
    }

    // Selected tile highlight
    if (selectedTile) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      ctx.strokeRect(selectedTile.col * ds + 1.5, selectedTile.row * ds + 1.5, ds - 3, ds - 3);
    }
  }, [layers, activeLayerIndex, tilesetImages, stamp, findTileset, selectedTile, getTileOwnerLayer]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // Handle canvas click — select tile
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const col = Math.floor(mx / DISPLAY_TILE_SIZE);
    const row = Math.floor(my / DISPLAY_TILE_SIZE);
    if (col >= 0 && col < stamp.cols && row >= 0 && row < stamp.rows) {
      setSelectedTile({ col, row });
    }
  }, [stamp.cols, stamp.rows]);

  // Move selected tile to a different layer
  const moveTileToLayer = useCallback((targetLayerIndex: number) => {
    if (!selectedTile) return;
    const idx = selectedTile.row * stamp.cols + selectedTile.col;
    const newLayers = layers.map((layer, li) => {
      const newData = [...layer.data];
      if (li === targetLayerIndex) {
        // Find which layer currently has this tile
        for (const srcLayer of layers) {
          if (srcLayer.data[idx] !== 0) {
            newData[idx] = srcLayer.data[idx];
            break;
          }
        }
      } else {
        // Clear this tile from all other layers
        newData[idx] = 0;
      }
      return { ...layer, data: newData };
    });
    setLayers(newLayers);
    setDirty(true);
  }, [selectedTile, layers, stamp.cols]);

  // Handle layer click — switch active layer only (tile move is via dropdown)
  const handleLayerClick = useCallback((idx: number) => {
    setActiveLayerIndex(idx);
  }, [selectedTile, layers, stamp.cols, getTileOwnerLayer, moveTileToLayer]);

  const buildLayerImage = useCallback((layerIndex: number): string | null => {
    const layer = layers[layerIndex];
    if (!layer) return null;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width = stamp.cols * tw;
    offscreen.height = stamp.rows * th;
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
      const dstCol = i % stamp.cols;
      const dstRow = Math.floor(i / stamp.cols);
      ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * tw, dstRow * th, tw, th);
    }
    return offscreen.toDataURL('image/png');
  }, [layers, tilesetImages, stamp, findTileset]);

  const handleEditPixels = useCallback(() => {
    const imageDataUrl = buildLayerImage(activeLayerIndex);
    if (!imageDataUrl) return;
    onOpenPixelEditor(imageDataUrl, stamp.cols, stamp.rows, stamp.tileWidth, stamp.tileHeight, (resultDataUrl: string) => {
      const layer = layers[activeLayerIndex];
      const tileCount = stamp.cols * stamp.rows;

      // Find which tileset this layer uses (first non-zero GID)
      const firstGid = layer.data.find((g) => g !== 0);
      const existingTs = firstGid ? findTileset(firstGid) : null;

      if (existingTs) {
        // Update existing tileset image in-place, keep same GIDs
        const updatedTilesets = tilesets.map((ts) =>
          ts.firstgid === existingTs.firstgid
            ? { ...ts, image: resultDataUrl, columns: stamp.cols, tilecount: tileCount }
            : ts,
        );
        setTilesets(updatedTilesets);
        // GIDs stay the same — just remap to sequential within this tileset
        const newData = layer.data.map((gid, i) => gid !== 0 ? existingTs.firstgid + i : 0);
        const newLayers = [...layers];
        newLayers[activeLayerIndex] = { ...layer, data: newData };
        setLayers(newLayers);
      } else {
        // No existing tileset — create one with the original layer name (not "-edited")
        const newFirstgid = tilesets.reduce((max, ts) => Math.max(max, ts.firstgid + ts.tilecount), 1);
        const newTileset: StampTilesetData = {
          name: layer.name, firstgid: newFirstgid,
          tilewidth: stamp.tileWidth, tileheight: stamp.tileHeight,
          columns: stamp.cols, tilecount: tileCount, image: resultDataUrl,
        };
        const newData = layer.data.map((_gid, i) => newFirstgid + i);
        const newLayers = [...layers];
        newLayers[activeLayerIndex] = { ...layer, data: newData };
        setLayers(newLayers);
        setTilesets(prev => [...prev, newTileset]);
      }
      setDirty(true);
    });
  }, [activeLayerIndex, layers, tilesets, stamp, buildLayerImage, onOpenPixelEditor]);

  const handleSave = useCallback(() => {
    const thumbnail = canvasRef.current?.toDataURL('image/png') ?? null;
    onSave({ name: stampName !== stamp.name ? stampName : undefined, layers, tilesets, thumbnail });
  }, [layers, tilesets, stampName, stamp.name, onSave]);

  const activeLayer = layers[activeLayerIndex];
  const selectedTileOwner = selectedTile ? getTileOwnerLayer(selectedTile.col, selectedTile.row) : -1;

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
            const STANDARD_LAYERS = ['Floor', 'Walls', 'Foreground'];
            const existing = new Set(layers.map((l) => l.name.toLowerCase()));
            const available = STANDARD_LAYERS.filter((n) => !existing.has(n.toLowerCase()));
            if (available.length === 0) return null;
            return (
              <div className="mt-1">
                <select
                  className="w-full text-micro bg-surface-raised border border-border rounded px-1.5 py-1 text-text-secondary cursor-pointer"
                  value=""
                  onChange={(e) => {
                    const name = e.target.value;
                    if (!name) return;
                    const emptyData = new Array(stamp.cols * stamp.rows).fill(0);
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
            const idx = selectedTile.row * stamp.cols + selectedTile.col;
            const tileLayers = layers
              .map((layer, li) => ({ li, layer, gid: layer.data[idx] }))
              .filter((t) => t.gid !== 0);

            return (
              <div className="mt-2 pt-2 border-t border-border">
                <div className="text-micro text-text-dim mb-1.5">
                  {t('mapEditor.stamps.selectedTile')} ({selectedTile.col}, {selectedTile.row})
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
                                // Move tile from li to targetIdx
                                const newLayers = layers.map((l, i) => {
                                  const newData = [...l.data];
                                  if (i === li) newData[idx] = 0; // remove from source
                                  if (i === targetIdx) newData[idx] = layer.data[idx]; // add to target
                                  return { ...l, data: newData };
                                });
                                setLayers(newLayers);
                                setDirty(true);
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
            <span className="text-micro text-text-dim ml-auto">{stamp.cols} x {stamp.rows}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-bg-deep p-4">
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              className="cursor-pointer"
              style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }}
            />
          </div>
        </div>
      </div>

      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={handleEditPixels}>{t('mapEditor.stamps.editPixels')}</Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty}>{t('common.save')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
