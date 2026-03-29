'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal } from '@/components/ui';
import type { TileRegion, TilesetImageInfo } from './hooks/useMapEditor';

// === Types ===

type Tool = 'pen' | 'eraser' | 'eyedropper';

interface PixelEditorModalProps {
  open: boolean;
  onClose: () => void;
  region: TileRegion | null;
  tilesetInfo: TilesetImageInfo | null;
  onSaveAsNew: (
    dataUrl: string,
    name: string,
    columns: number,
    tileWidth: number,
    tileHeight: number,
    tileCount: number,
  ) => void;
  onOverwrite: (firstgid: number, dataUrl: string) => void;
}

// === Constants ===

const MAX_UNDO = 50;
const CHECKER_SIZE = 8;
const CHECKER_LIGHT = '#cccccc';
const CHECKER_DARK = '#999999';
const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

// === Component ===

export default function PixelEditorModal({
  open,
  onClose,
  region,
  tilesetInfo,
  onSaveAsNew,
  onOverwrite,
}: PixelEditorModalProps) {
  // --- State ---
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#000000');
  const [alpha, setAlpha] = useState(255);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // --- Refs ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const checkerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const isPanningRef = useRef(false);
  const lastPanRef = useRef({ x: 0, y: 0 });
  const isDrawingRef = useRef(false);

  // --- Memory cleanup on modal close ---
  useEffect(() => {
    if (!open) {
      editCanvasRef.current = null;
      checkerCanvasRef.current = null;
      undoStackRef.current = [];
      redoStackRef.current = [];
    }
  }, [open]);

  // Pixel dimensions of the region being edited
  const regionPxW = region && tilesetInfo ? region.width * tilesetInfo.tilewidth : 0;
  const regionPxH = region && tilesetInfo ? region.height * tilesetInfo.tileheight : 0;

  // --- Pre-render checkerboard pattern for given zoom level ---
  const buildCheckerboard = useCallback(
    (pixelW: number, pixelH: number, z: number) => {
      const cc = document.createElement('canvas');
      cc.width = pixelW * z;
      cc.height = pixelH * z;
      const ctx = cc.getContext('2d')!;
      const blockSize = CHECKER_SIZE * z;
      const cols = Math.ceil(cc.width / blockSize);
      const rows = Math.ceil(cc.height / blockSize);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
          ctx.fillRect(c * blockSize, r * blockSize, blockSize, blockSize);
        }
      }
      checkerCanvasRef.current = cc;
    },
    [],
  );

  // --- Initialize edit canvas from region ---
  const initEditCanvas = useCallback(() => {
    if (!region || !tilesetInfo) return;
    const { col, row, width, height } = region;
    const { img, tilewidth, tileheight } = tilesetInfo;

    const pw = width * tilewidth;
    const ph = height * tileheight;

    const ec = document.createElement('canvas');
    ec.width = pw;
    ec.height = ph;
    const ctx = ec.getContext('2d')!;

    // Draw the region from the tileset image
    const sx = col * tilewidth;
    const sy = row * tileheight;
    ctx.drawImage(img, sx, sy, pw, ph, 0, 0, pw, ph);

    editCanvasRef.current = ec;
    undoStackRef.current = [ctx.getImageData(0, 0, pw, ph)];
    redoStackRef.current = [];
  }, [region, tilesetInfo]);

  // --- Auto-fit zoom on open ---
  useEffect(() => {
    if (!open || !region || !tilesetInfo) return;
    initEditCanvas();

    // Calculate auto-fit zoom after a tick (container needs to render)
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const fitZoom = Math.min((cw * 0.8) / regionPxW, (ch * 0.8) / regionPxH);
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fitZoom)));
      setZoom(clamped);
      setPan({
        x: (cw - regionPxW * clamped) / 2,
        y: (ch - regionPxH * clamped) / 2,
      });
    });

    // Reset tool state
    setTool('pen');
    setColor('#000000');
    setAlpha(255);
  }, [open, region, tilesetInfo, initEditCanvas, regionPxW, regionPxH]);

  // --- Rebuild checkerboard when zoom or dimensions change ---
  useEffect(() => {
    if (!open || regionPxW === 0 || regionPxH === 0) return;
    buildCheckerboard(regionPxW, regionPxH, zoom);
  }, [open, regionPxW, regionPxH, zoom, buildCheckerboard]);

  // --- Render display canvas ---
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ec = editCanvasRef.current;
    if (!canvas || !ec) return;

    const ctx = canvas.getContext('2d')!;
    const cw = canvas.width;
    const ch = canvas.height;

    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(pan.x, pan.y);

    const w = ec.width * zoom;
    const h = ec.height * zoom;

    // Checkerboard behind transparent pixels (pre-rendered offscreen canvas)
    const cc = checkerCanvasRef.current;
    if (cc) {
      ctx.drawImage(cc, 0, 0);
    }

    // Draw edited image scaled
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ec, 0, 0, w, h);

    // Pixel grid lines at zoom >= 4x
    if (zoom >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x <= ec.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * zoom, 0);
        ctx.lineTo(x * zoom, h);
        ctx.stroke();
      }
      for (let y = 0; y <= ec.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * zoom);
        ctx.lineTo(w, y * zoom);
        ctx.stroke();
      }
    }

    // Tile boundary grid lines (green, always visible)
    if (tilesetInfo) {
      ctx.strokeStyle = 'rgba(0,255,100,0.5)';
      ctx.lineWidth = 1;
      const tw = tilesetInfo.tilewidth * zoom;
      const th = tilesetInfo.tileheight * zoom;
      for (let x = 0; x <= w; x += tw) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += th) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }, [pan, zoom, tilesetInfo]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // --- Resize display canvas to container ---
  useEffect(() => {
    if (!open) return;
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      renderCanvas();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [open, renderCanvas]);

  // --- Push undo snapshot ---
  const pushUndo = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec) return;
    const ctx = ec.getContext('2d')!;
    const snapshot = ctx.getImageData(0, 0, ec.width, ec.height);
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > MAX_UNDO) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
  }, []);

  const undo = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec || undoStackRef.current.length <= 1) return;
    const current = undoStackRef.current.pop()!;
    redoStackRef.current.push(current);
    const prev = undoStackRef.current[undoStackRef.current.length - 1];
    ec.getContext('2d')!.putImageData(prev, 0, 0);
    renderCanvas();
  }, [renderCanvas]);

  const redo = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec || redoStackRef.current.length === 0) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(next);
    ec.getContext('2d')!.putImageData(next, 0, 0);
    renderCanvas();
  }, [renderCanvas]);

  // --- Pixel coordinate from mouse event ---
  const getPixelCoord = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - pan.x;
      const my = e.clientY - rect.top - pan.y;
      const px = Math.floor(mx / zoom);
      const py = Math.floor(my / zoom);
      if (px < 0 || py < 0 || px >= regionPxW || py >= regionPxH) return null;
      return { x: px, y: py };
    },
    [pan, zoom, regionPxW, regionPxH],
  );

  // --- Parse hex color to RGBA ---
  const colorToRGBA = useCallback((): [number, number, number, number] => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return [r, g, b, alpha];
  }, [color, alpha]);

  // --- Paint a single pixel ---
  const paintPixel = useCallback(
    (px: number, py: number) => {
      const ec = editCanvasRef.current;
      if (!ec) return;
      const ctx = ec.getContext('2d')!;

      if (tool === 'eraser') {
        ctx.clearRect(px, py, 1, 1);
      } else if (tool === 'pen') {
        const [r, g, b, a] = colorToRGBA();
        const id = ctx.createImageData(1, 1);
        id.data[0] = r;
        id.data[1] = g;
        id.data[2] = b;
        id.data[3] = a;
        ctx.putImageData(id, px, py);
      }
      renderCanvas();
    },
    [tool, colorToRGBA, renderCanvas],
  );

  // --- Pick color from pixel (eyedropper) ---
  const pickColor = useCallback(
    (px: number, py: number) => {
      const ec = editCanvasRef.current;
      if (!ec) return;
      const ctx = ec.getContext('2d')!;
      const id = ctx.getImageData(px, py, 1, 1);
      const [r, g, b, a] = id.data;
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      setColor(hex);
      setAlpha(a);
      setTool('pen');
    },
    [],
  );

  // --- Mouse handlers ---

  // Document-level pan listeners (attached on middle-click, removed on mouseup)
  const handlePanMove = useCallback((e: MouseEvent) => {
    const dx = e.clientX - lastPanRef.current.x;
    const dy = e.clientY - lastPanRef.current.y;
    lastPanRef.current = { x: e.clientX, y: e.clientY };
    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, []);

  const handlePanEnd = useCallback(() => {
    isPanningRef.current = false;
    document.removeEventListener('mousemove', handlePanMove);
    document.removeEventListener('mouseup', handlePanEnd);
  }, [handlePanMove]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle-click: start panning with document-level listeners
      if (e.button === 1) {
        e.preventDefault();
        isPanningRef.current = true;
        lastPanRef.current = { x: e.clientX, y: e.clientY };
        document.addEventListener('mousemove', handlePanMove);
        document.addEventListener('mouseup', handlePanEnd);
        return;
      }

      if (e.button !== 0) return;

      const coord = getPixelCoord(e);
      if (!coord) return;

      if (tool === 'eyedropper') {
        pickColor(coord.x, coord.y);
        return;
      }

      pushUndo();
      isDrawingRef.current = true;
      paintPixel(coord.x, coord.y);
    },
    [getPixelCoord, tool, pickColor, pushUndo, paintPixel, handlePanMove, handlePanEnd],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Drawing (pan is handled at document level now)
      if (!isDrawingRef.current) return;
      const coord = getPixelCoord(e);
      if (!coord) return;
      paintPixel(coord.x, coord.y);
    },
    [getPixelCoord, paintPixel],
  );

  const handleMouseUp = useCallback(() => {
    isDrawingRef.current = false;
  }, []);

  // Cleanup document listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handlePanMove);
      document.removeEventListener('mouseup', handlePanEnd);
    };
  }, [handlePanMove, handlePanEnd]);

  // --- Wheel zoom (cursor-anchored) ---
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const oldZoom = zoom;
      const currentIdx = ZOOM_LEVELS.indexOf(oldZoom as (typeof ZOOM_LEVELS)[number]);
      const idx = currentIdx === -1
        ? ZOOM_LEVELS.findIndex((z) => z >= oldZoom)
        : currentIdx;
      const direction = e.deltaY < 0 ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
      const newZoom = ZOOM_LEVELS[nextIdx];
      if (newZoom === oldZoom) return;

      // Anchor zoom on cursor position
      const wx = (mx - pan.x) / oldZoom;
      const wy = (my - pan.y) / oldZoom;
      const newPanX = mx - wx * newZoom;
      const newPanY = my - wy * newZoom;

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    },
    [zoom, pan],
  );

  // --- Keyboard shortcuts ---
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setTool('eraser');
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setTool('pen');
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        setTool('eyedropper');
      } else if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, undo, redo]);

  // --- Save handlers ---
  const getDataUrl = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec) return '';
    return ec.toDataURL('image/png');
  }, []);

  const handleSaveAsNew = useCallback(() => {
    if (!tilesetInfo || !region) return;
    const dataUrl = getDataUrl();
    const name = `${tilesetInfo.name}-edited`;
    onSaveAsNew(
      dataUrl,
      name,
      region.width,
      tilesetInfo.tilewidth,
      tilesetInfo.tileheight,
      region.width * region.height,
    );
    onClose();
  }, [tilesetInfo, region, getDataUrl, onSaveAsNew, onClose]);

  const handleOverwrite = useCallback(() => {
    if (!region) return;
    const dataUrl = getDataUrl();
    onOverwrite(region.firstgid, dataUrl);
    onClose();
  }, [region, getDataUrl, onOverwrite, onClose]);

  // --- Guard: don't render if no data ---
  if (!region || !tilesetInfo) {
    return (
      <Modal open={open} onClose={onClose} title="Pixel Editor" size="full">
        <Modal.Body>
          <p className="text-text-secondary">No region selected.</p>
        </Modal.Body>
      </Modal>
    );
  }

  // --- Cursor style ---
  const cursorStyle =
    tool === 'eyedropper' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';

  return (
    <Modal open={open} onClose={onClose} title="Pixel Editor" size="full">
      <Modal.Body className="flex flex-col gap-3 p-0 !px-0 !py-0 overflow-hidden">
        {/* Toolbar row */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-surface flex-shrink-0">
          {/* Tool buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant={tool === 'pen' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setTool('pen')}
              title="Pen (P)"
            >
              Pen
            </Button>
            <Button
              variant={tool === 'eraser' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setTool('eraser')}
              title="Eraser (E)"
            >
              Eraser
            </Button>
            <Button
              variant={tool === 'eyedropper' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setTool('eyedropper')}
              title="Eyedropper (I)"
            >
              Pick
            </Button>
          </div>

          {/* Separator */}
          <div className="w-px h-6 bg-border" />

          {/* Color picker */}
          <div className="flex items-center gap-2">
            <label className="text-caption text-text-secondary">Color</label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-7 h-7 border border-border rounded cursor-pointer bg-transparent"
            />
          </div>

          {/* Alpha slider */}
          <div className="flex items-center gap-2">
            <label className="text-caption text-text-secondary">Alpha</label>
            <input
              type="range"
              min={0}
              max={255}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
              className="w-20"
            />
            <span className="text-caption text-text-secondary w-8 text-right">{alpha}</span>
          </div>

          {/* Separator */}
          <div className="w-px h-6 bg-border" />

          {/* Undo/Redo */}
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={undo} title="Undo (Ctrl+Z)">
              Undo
            </Button>
            <Button variant="ghost" size="sm" onClick={redo} title="Redo (Ctrl+Y)">
              Redo
            </Button>
          </div>

          {/* Separator */}
          <div className="w-px h-6 bg-border" />

          {/* Zoom display */}
          <span className="text-caption text-text-secondary">{zoom}x</span>

          {/* Region info */}
          <span className="text-caption text-text-secondary ml-auto">
            {regionPxW} x {regionPxH} px &middot; {region.width} x {region.height} tiles
          </span>
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="flex-1 overflow-hidden bg-bg-deep relative"
          style={{ cursor: cursorStyle }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={handleSaveAsNew}>
          Save as New Tileset
        </Button>
        <Button variant="primary" size="sm" onClick={handleOverwrite}>
          Overwrite Original
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
