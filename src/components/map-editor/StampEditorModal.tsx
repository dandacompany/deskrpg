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
  onSave: (updated: { layers: StampLayerData[]; tilesets: StampTilesetData[]; thumbnail: string | null }) => void;
  onOpenPixelEditor: (imageDataUrl: string, cols: number, rows: number, tileWidth: number, tileHeight: number, onResult: (dataUrl: string) => void) => void;
}

function getLayerColorByName(name: string) {
  const key = name.toLowerCase() as keyof typeof LAYER_COLORS;
  return LAYER_COLORS[key] ?? { solid: '#6b7280', overlay: 'rgba(107, 114, 128, 0.12)' };
}

export default function StampEditorModal({
  open, onClose, stamp, onSave, onOpenPixelEditor,
}: StampEditorModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [layers, setLayers] = useState<StampLayerData[]>(stamp.layers);
  const [tilesets, setTilesets] = useState<StampTilesetData[]>(stamp.tilesets);
  const [tilesetImages, setTilesetImages] = useState<Map<number, HTMLImageElement>>(new Map());
  const [dirty, setDirty] = useState(false);

  // Reset state when stamp changes
  useEffect(() => {
    setLayers(stamp.layers);
    setTilesets(stamp.tilesets);
    setActiveLayerIndex(0);
    setDirty(false);
  }, [stamp.id]);

  // Load tileset images from base64 data URLs
  useEffect(() => {
    const map = new Map<number, HTMLImageElement>();
    let loaded = 0;
    for (const ts of tilesets) {
      const img = new Image();
      img.onload = () => {
        map.set(ts.firstgid, img);
        loaded++;
        if (loaded === tilesets.length) setTilesetImages(new Map(map));
      };
      img.src = ts.image;
    }
    if (tilesets.length === 0) setTilesetImages(new Map());
  }, [tilesets]);

  // Find tileset for a GID
  const findTileset = useCallback((gid: number) => {
    if (gid === 0) return null;
    let best: StampTilesetData | null = null;
    for (const ts of tilesets) {
      if (gid >= ts.firstgid && (!best || ts.firstgid > best.firstgid)) best = ts;
    }
    return best;
  }, [tilesets]);

  // Render canvas
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || tilesetImages.size === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const tw = stamp.tileWidth;
    const th = stamp.tileHeight;
    canvas.width = stamp.cols * tw;
    canvas.height = stamp.rows * th;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
        ctx.drawImage(img, srcCol * ts.tilewidth, srcRow * ts.tileheight, ts.tilewidth, ts.tileheight, dstCol * tw, dstRow * th, tw, th);
      }

      if (isActive) {
        const lc = getLayerColorByName(layer.name);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lc.overlay;
        for (let i = 0; i < layer.data.length; i++) {
          if (layer.data[i] !== 0) {
            const col = i % stamp.cols;
            const row = Math.floor(i / stamp.cols);
            ctx.fillRect(col * tw, row * th, tw, th);
          }
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(0,255,100,0.4)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= stamp.cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * tw, 0); ctx.lineTo(x * tw, stamp.rows * th); ctx.stroke();
    }
    for (let y = 0; y <= stamp.rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * th); ctx.lineTo(stamp.cols * tw, y * th); ctx.stroke();
    }
  }, [layers, activeLayerIndex, tilesetImages, stamp, findTileset]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

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
      const newFirstgid = tilesets.reduce((max, ts) => Math.max(max, ts.firstgid + ts.tilecount), 1);
      const newTileset: StampTilesetData = {
        name: `${layer.name}-edited`, firstgid: newFirstgid,
        tilewidth: stamp.tileWidth, tileheight: stamp.tileHeight,
        columns: stamp.cols, tilecount: tileCount, image: resultDataUrl,
      };
      const newData = layer.data.map((gid, i) => gid !== 0 ? newFirstgid + i : 0);
      const newLayers = [...layers];
      newLayers[activeLayerIndex] = { ...layer, data: newData };
      setLayers(newLayers);
      setTilesets(prev => [...prev, newTileset]);
      setDirty(true);
    });
  }, [activeLayerIndex, layers, tilesets, stamp, buildLayerImage, onOpenPixelEditor]);

  const handleSave = useCallback(() => {
    const thumbnail = canvasRef.current?.toDataURL('image/png') ?? null;
    onSave({ layers, tilesets, thumbnail });
  }, [layers, tilesets, onSave]);

  const activeLayer = layers[activeLayerIndex];

  return (
    <Modal open={open} onClose={onClose} title={`${stamp.name} — ${t('mapEditor.stamps.stampEditor')}`} size="lg">
      <div className="flex" style={{ height: '60vh' }}>
        {/* Layer Panel */}
        <div className="w-44 border-r border-border p-2 flex flex-col gap-1 flex-shrink-0 overflow-y-auto">
          <div className="text-micro text-text-dim uppercase tracking-wider mb-1">{t('mapEditor.stamps.layers')}</div>
          {layers.map((layer, idx) => {
            const isActive = idx === activeLayerIndex;
            const lc = getLayerColorByName(layer.name);
            const count = layer.data.filter((g) => g !== 0).length;
            return (
              <button key={idx} onClick={() => setActiveLayerIndex(idx)}
                className={`w-full text-left rounded-md px-2 py-1.5 transition-colors flex items-center gap-2 ${isActive ? 'border' : 'border border-transparent hover:bg-surface-raised'}`}
                style={isActive ? { backgroundColor: `${lc.solid}15`, borderColor: `${lc.solid}40` } : {}}
              >
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: lc.solid }} />
                <span className={`text-caption truncate ${isActive ? 'text-text' : 'text-text-secondary'}`}>{layer.name}</span>
                <span className="text-micro text-text-dim ml-auto">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Canvas Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-9 border-b border-border flex items-center px-3 gap-2 flex-shrink-0">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: getLayerColorByName(activeLayer?.name ?? '').solid }} />
            <span className="text-caption text-text">{activeLayer?.name}</span>
            <span className="text-micro text-text-dim ml-auto">{stamp.cols} x {stamp.rows}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-bg-deep p-4">
            <canvas ref={canvasRef} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
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
