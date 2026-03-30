'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Modal } from '@/components/ui';
import {
  Pencil, Eraser, Pipette, Move, BoxSelect,
  Scissors, Trash2, PlusSquare, MinusSquare,
  Undo2, Redo2, HelpCircle, ZoomIn,
  ImageMinus, Grid3x3,
  Maximize2,
} from 'lucide-react';
import Tooltip from './Tooltip';
import { useT } from '@/lib/i18n';
import type { TileRegion, TilesetImageInfo } from './hooks/useMapEditor';
import { removeBgToDataUrl } from '@/lib/remove-bg';

// === Types ===

type Tool = 'pen' | 'eraser' | 'eyedropper' | 'shift' | 'rect-select';

interface PixelSelection {
  x: number; y: number; width: number; height: number;
}

interface TransformState {
  floatingCanvas: HTMLCanvasElement;
  originX: number;
  originY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  smooth: boolean;
}

type HandleType = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se' | 'move';


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
  onOverwrite: (firstgid: number, dataUrl: string, cols: number, rows: number, originalCols: number, originalRows: number) => void;
  /** Direct image mode: provide a pre-rendered image instead of region+tilesetInfo */
  initialImageDataUrl?: string;
  initialTileWidth?: number;
  initialTileHeight?: number;
  initialCols?: number;
  initialRows?: number;
  onSaveAsStamp?: (thumbnail: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => void;
  /** When set, footer shows only Cancel + Apply (for stamp editor pixel editing) */
  onApply?: (dataUrl: string, newCols: number, newRows: number) => void;
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
  initialImageDataUrl,
  initialTileWidth,
  initialTileHeight,
  initialCols,
  initialRows,
  onSaveAsStamp,
  onApply,
}: PixelEditorModalProps) {
  const t = useT();
  // --- State ---
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#000000');
  const [alpha, setAlpha] = useState(255);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [shiftOffset, setShiftOffset] = useState({ dx: 0, dy: 0 });
  const [expandedCols, setExpandedCols] = useState(0);
  const [expandedRows, setExpandedRows] = useState(0);
  const [tileEditMode, setTileEditMode] = useState(false);
  const [hoveredEdge, setHoveredEdge] = useState<{
    top: 'add' | 'delete' | null;
    bottom: 'add' | 'delete' | null;
    left: 'add' | 'delete' | null;
    right: 'add' | 'delete' | null;
  } | null>(null);
  const [resizeTargetCols, setResizeTargetCols] = useState(1);
  const [resizeTargetRows, setResizeTargetRows] = useState(1);
  const [brushSize, setBrushSize] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [removingBg, setRemovingBg] = useState<string | null>(null);
  const [pixelSelection, setPixelSelection] = useState<PixelSelection | null>(null);
  const [pixelClipboard, setPixelClipboard] = useState<ImageData | null>(null);
  const [isPixelPasteMode, setIsPixelPasteMode] = useState(false);
  const isRectSelectingRef = useRef(false);
  const rectSelectStartRef = useRef<{ x: number; y: number } | null>(null);
  const [transformActive, setTransformActive] = useState(false);
  const transformRef = useRef<TransformState | null>(null);
  const transformDragRef = useRef<{
    handle: HandleType;
    startMx: number;
    startMy: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const [transformCursor, setTransformCursor] = useState('default');

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
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const hoverPixelRef = useRef<{ x: number; y: number } | null>(null);
  const isShiftDraggingRef = useRef(false);
  const shiftStartRef = useRef({ x: 0, y: 0 });
  const shiftOffsetRef = useRef({ dx: 0, dy: 0 });

  // Keep shiftOffsetRef in sync to avoid stale closures in renderCanvas
  useEffect(() => {
    shiftOffsetRef.current = shiftOffset;
  }, [shiftOffset]);

  // --- Memory cleanup on modal close ---
  useEffect(() => {
    if (!open) {
      editCanvasRef.current = null;
      checkerCanvasRef.current = null;
      undoStackRef.current = [];
      redoStackRef.current = [];
      isShiftDraggingRef.current = false;
      setShiftOffset({ dx: 0, dy: 0 });
      setExpandedCols(0);
      setExpandedRows(0);
    }
  }, [open]);

  // Pixel dimensions of the region being edited
  const isDirectImage = !!initialImageDataUrl;
  const regionPxW = isDirectImage
    ? (initialCols ?? 1) * (initialTileWidth ?? 32)
    : region && tilesetInfo ? region.width * tilesetInfo.tilewidth : 0;
  const regionPxH = isDirectImage
    ? (initialRows ?? 1) * (initialTileHeight ?? 32)
    : region && tilesetInfo ? region.height * tilesetInfo.tileheight : 0;
  const effectiveTileWidth = tilesetInfo?.tilewidth ?? initialTileWidth ?? 32;
  const effectiveTileHeight = tilesetInfo?.tileheight ?? initialTileHeight ?? 32;

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

  // --- Auto-fit zoom to current editCanvas ---
  const autoFit = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec || !containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (ch < 50) return;
    const fitZoom = Math.min((cw * 0.8) / ec.width, (ch * 0.8) / ec.height);
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fitZoom)));
    setZoom(clamped);
    setPan({ x: (cw - ec.width * clamped) / 2, y: (ch - ec.height * clamped) / 2 });
    buildCheckerboard(ec.width, ec.height, clamped);
  }, [buildCheckerboard]);

  // --- Calculate expanded grid from shift offset ---
  const calcExpandedGrid = useCallback(
    (dx: number, dy: number) => {
      if (!editCanvasRef.current) {
        return { cols: expandedCols, rows: expandedRows, originX: 0, originY: 0 };
      }
      const tilewidth = effectiveTileWidth;
      const tileheight = effectiveTileHeight;
      const ec = editCanvasRef.current;
      const currentCols = Math.round(ec.width / tilewidth);
      const currentRows = Math.round(ec.height / tileheight);

      const extraLeft = dx < 0 ? Math.ceil(Math.abs(dx) / tilewidth) : 0;
      const extraRight = dx > 0 ? Math.ceil(dx / tilewidth) : 0;
      const extraTop = dy < 0 ? Math.ceil(Math.abs(dy) / tileheight) : 0;
      const extraBottom = dy > 0 ? Math.ceil(dy / tileheight) : 0;

      const cols = currentCols + extraLeft + extraRight;
      const rows = currentRows + extraTop + extraBottom;
      const originX = extraLeft * tilewidth + dx;
      const originY = extraTop * tileheight + dy;

      return { cols, rows, originX, originY };
    },
    [effectiveTileWidth, effectiveTileHeight, expandedCols, expandedRows],
  );

  // --- Initialize edit canvas from region ---
  const initEditCanvas = useCallback(() => {
    if (isDirectImage && initialImageDataUrl) {
      // Direct image mode: load from dataUrl
      const img = new Image();
      img.onload = () => {
        const ec = document.createElement('canvas');
        ec.width = img.width;
        ec.height = img.height;
        const ctx = ec.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        editCanvasRef.current = ec;
        undoStackRef.current = [ctx.getImageData(0, 0, ec.width, ec.height)];
        redoStackRef.current = [];
        // Trigger auto-fit after image loads
        autoFit();
      };
      img.src = initialImageDataUrl;
      return;
    }
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
  }, [region, tilesetInfo, isDirectImage, initialImageDataUrl, autoFit]);

  // --- Auto-fit zoom on open ---
  useEffect(() => {
    if (!open) return;
    if (!isDirectImage && (!region || !tilesetInfo)) return;
    initEditCanvas();

    // Calculate auto-fit zoom after container renders (may need multiple frames)
    if (!isDirectImage) {
      const tryAutoFit = (attempts = 0) => {
        if (!containerRef.current || attempts > 10) return;
        const cw = containerRef.current.clientWidth;
        const ch = containerRef.current.clientHeight;
        if (ch < 50 && attempts < 10) {
          requestAnimationFrame(() => tryAutoFit(attempts + 1));
          return;
        }
        const fitZoom = Math.min((cw * 0.8) / regionPxW, (ch * 0.8) / regionPxH);
        const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fitZoom)));
        setZoom(clamped);
        setPan({
          x: (cw - regionPxW * clamped) / 2,
          y: (ch - regionPxH * clamped) / 2,
        });
      };
      requestAnimationFrame(() => tryAutoFit());
    }

    // Reset tool state
    setTool('pen');
    setColor('#000000');
    setAlpha(255);
    setShiftOffset({ dx: 0, dy: 0 });
    const cols = isDirectImage ? (initialCols ?? 1) : region!.width;
    const rows = isDirectImage ? (initialRows ?? 1) : region!.height;
    setExpandedCols(cols);
    setExpandedRows(rows);
    setResizeTargetCols(cols);
    setResizeTargetRows(rows);
  }, [open, region, tilesetInfo, isDirectImage, initEditCanvas, regionPxW, regionPxH, initialCols, initialRows]);

  // Pixel dimensions of the current edit canvas (may be expanded)
  const editPxW = expandedCols * effectiveTileWidth || regionPxW;
  const editPxH = expandedRows * effectiveTileHeight || regionPxH;

  // --- Rebuild checkerboard when zoom or dimensions change ---
  useEffect(() => {
    if (!open || editPxW === 0 || editPxH === 0) return;
    buildCheckerboard(editPxW, editPxH, zoom);
  }, [open, editPxW, editPxH, zoom, buildCheckerboard]);

  // --- Transform handle constants & helpers ---
  const HANDLE_SIZE = 10;
  const HANDLE_HIT = 12;

  const getHandlePositions = useCallback((t: TransformState, z: number) => {
    const x = t.x * z;
    const y = t.y * z;
    const w = t.width * z;
    const h = t.height * z;
    const hw = w / 2;
    const hh = h / 2;
    return {
      nw: { x, y },
      n:  { x: x + hw, y },
      ne: { x: x + w, y },
      w:  { x, y: y + hh },
      e:  { x: x + w, y: y + hh },
      sw: { x, y: y + h },
      s:  { x: x + hw, y: y + h },
      se: { x: x + w, y: y + h },
    };
  }, []);

  const hitTestHandle = useCallback((e: React.MouseEvent): HandleType | null => {
    if (!transformRef.current) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - pan.x;
    const my = e.clientY - rect.top - pan.y;

    const t = transformRef.current;
    const handles = getHandlePositions(t, zoom);
    const hh = HANDLE_HIT / 2;

    const handleEntries = Object.entries(handles) as [HandleType, { x: number; y: number }][];
    for (const [key, p] of handleEntries) {
      if (mx >= p.x - hh && mx <= p.x + hh && my >= p.y - hh && my <= p.y + hh) {
        return key;
      }
    }

    const tx = t.x * zoom;
    const ty = t.y * zoom;
    const tw = t.width * zoom;
    const th = t.height * zoom;
    if (mx >= tx && mx <= tx + tw && my >= ty && my <= ty + th) {
      return 'move';
    }

    return null;
  }, [pan, zoom, getHandlePositions]);

  const getHandleCursor = (handle: HandleType | null): string => {
    switch (handle) {
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'n': case 's': return 'ns-resize';
      case 'w': case 'e': return 'ew-resize';
      case 'move': return 'move';
      default: return 'default';
    }
  };

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

    const so = shiftOffsetRef.current;
    const isShifting = so.dx !== 0 || so.dy !== 0;

    {
      // Normal render (no shift)
      const w = ec.width * zoom;
      const h = ec.height * zoom;

      // Checkerboard behind transparent pixels (pre-rendered offscreen canvas)
      const cc = checkerCanvasRef.current;
      if (cc) {
        ctx.drawImage(cc, 0, 0);
      }

      // Draw edited image scaled (with shift offset if dragging)
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(ec, so.dx * zoom, so.dy * zoom, w, h);

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
      {
        ctx.strokeStyle = 'rgba(0,255,100,0.5)';
        ctx.lineWidth = 1;
        const tw = effectiveTileWidth * zoom;
        const th = effectiveTileHeight * zoom;
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
    }

    // Brush cursor preview
    const hp = hoverPixelRef.current;
    if (hp && (tool === 'pen' || tool === 'eraser')) {
      const half = Math.floor(brushSize / 2);
      const bx = (hp.x - half) * zoom;
      const by = (hp.y - half) * zoom;
      const bs = brushSize * zoom;
      if (tool === 'eraser') {
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bs, bs);
      } else {
        ctx.fillStyle = color + '40'; // 25% opacity preview
        ctx.fillRect(bx, by, bs, bs);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bs, bs);
      }
    }

    // Pixel selection rectangle
    const ps = pixelSelection;
    if (ps) {
      if (isPixelPasteMode) {
        // Copied state: animated marching ants border on source selection
        ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
        ctx.fillRect(ps.x * zoom, ps.y * zoom, ps.width * zoom, ps.height * zoom);
        ctx.save();
        const dashOffset = (Date.now() / 80) % 12;
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -dashOffset;
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(ps.x * zoom, ps.y * zoom, ps.width * zoom, ps.height * zoom);
        // Second pass with white for contrast
        ctx.lineDashOffset = -dashOffset + 4;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.strokeRect(ps.x * zoom, ps.y * zoom, ps.width * zoom, ps.height * zoom);
        ctx.restore();
      } else if (tool === 'rect-select') {
        // Normal selection: static dashed border
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fillRect(ps.x * zoom, ps.y * zoom, ps.width * zoom, ps.height * zoom);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(ps.x * zoom, ps.y * zoom, ps.width * zoom, ps.height * zoom);
        ctx.restore();
      }
    }

    // Paste preview: clipboard image follows cursor (opaque)
    if (isPixelPasteMode && pixelClipboard && hp) {
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = pixelClipboard.width;
      previewCanvas.height = pixelClipboard.height;
      previewCanvas.getContext('2d')!.putImageData(pixelClipboard, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.8;
      ctx.drawImage(previewCanvas, hp.x * zoom, hp.y * zoom, pixelClipboard.width * zoom, pixelClipboard.height * zoom);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(hp.x * zoom, hp.y * zoom, pixelClipboard.width * zoom, pixelClipboard.height * zoom);
    }

    // Transform mode: floating layer + handles
    if (transformActive && transformRef.current) {
      const t = transformRef.current;

      // Draw floating layer
      ctx.imageSmoothingEnabled = t.smooth;
      ctx.drawImage(t.floatingCanvas, t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
      ctx.imageSmoothingEnabled = false;

      // Marching ants border
      ctx.save();
      const dashOff = (Date.now() / 80) % 12;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -dashOff;
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
      ctx.lineDashOffset = -dashOff + 4;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.strokeRect(t.x * zoom, t.y * zoom, t.width * zoom, t.height * zoom);
      ctx.restore();

      // 8 handles
      const handles = getHandlePositions(t, zoom);
      const hs = HANDLE_SIZE / 2;
      const cornerKeys: HandleType[] = ['nw', 'ne', 'sw', 'se'];
      const edgeKeys: HandleType[] = ['n', 's', 'w', 'e'];

      for (const key of cornerKeys) {
        const p = handles[key as keyof typeof handles];
        ctx.fillStyle = '#3b82f6';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.fillRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
      }
      for (const key of edgeKeys) {
        const p = handles[key as keyof typeof handles];
        ctx.fillStyle = '#60a5fa';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.fillRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
      }
    }

    ctx.restore();
  }, [pan, zoom, tilesetInfo, tool, brushSize, color, pixelSelection, isPixelPasteMode, pixelClipboard, transformActive]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // --- Marching ants animation loop for paste mode ---
  useEffect(() => {
    if ((!isPixelPasteMode && !transformActive) || !open) return;
    let raf: number;
    const animate = () => {
      renderCanvas();
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [isPixelPasteMode, open, renderCanvas]);

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
      const ec = editCanvasRef.current;
      if (!canvas || !ec) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - pan.x;
      const my = e.clientY - rect.top - pan.y;
      const px = Math.floor(mx / zoom);
      const py = Math.floor(my / zoom);
      if (px < 0 || py < 0 || px >= ec.width || py >= ec.height) return null;
      return { x: px, y: py };
    },
    [pan, zoom],
  );

  // --- Tile coordinate from mouse event (for edge detection) ---
  const getTileCoord = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      const ec = editCanvasRef.current;
      if (!canvas || !ec) return null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - pan.x;
      const my = e.clientY - rect.top - pan.y;
      const tw = effectiveTileWidth * zoom;
      const th = effectiveTileHeight * zoom;
      const cols = Math.round(ec.width / effectiveTileWidth);
      const rows = Math.round(ec.height / effectiveTileHeight);
      const tileX = Math.floor(mx / tw);
      const tileY = Math.floor(my / th);
      if (tileX < 0 || tileY < 0 || tileX >= cols || tileY >= rows) return null;
      return { tileX, tileY, cols, rows };
    },
    [pan, zoom, effectiveTileWidth, effectiveTileHeight],
  );

  // --- Parse hex color to RGBA ---
  const colorToRGBA = useCallback((): [number, number, number, number] => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return [r, g, b, alpha];
  }, [color, alpha]);

  // --- Paint pixels with brush size ---
  const paintPixel = useCallback(
    (px: number, py: number) => {
      const ec = editCanvasRef.current;
      if (!ec) return;
      const ctx = ec.getContext('2d')!;
      const half = Math.floor(brushSize / 2);

      if (tool === 'eraser') {
        for (let dy = -half; dy < brushSize - half; dy++) {
          for (let dx = -half; dx < brushSize - half; dx++) {
            const x = px + dx, y = py + dy;
            if (x >= 0 && x < ec.width && y >= 0 && y < ec.height) {
              ctx.clearRect(x, y, 1, 1);
            }
          }
        }
      } else if (tool === 'pen') {
        const [r, g, b, a] = colorToRGBA();
        for (let dy = -half; dy < brushSize - half; dy++) {
          for (let dx = -half; dx < brushSize - half; dx++) {
            const x = px + dx, y = py + dy;
            if (x >= 0 && x < ec.width && y >= 0 && y < ec.height) {
              const id = ctx.createImageData(1, 1);
              id.data[0] = r; id.data[1] = g; id.data[2] = b; id.data[3] = a;
              ctx.putImageData(id, x, y);
            }
          }
        }
      }
      renderCanvas();
    },
    [tool, brushSize, colorToRGBA, renderCanvas],
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

  // --- Apply shift: move image within current canvas (no auto-expand) ---
  const applyShift = useCallback(
    (dx: number, dy: number) => {
      const ec = editCanvasRef.current;
      if (!ec) return;
      if (dx === 0 && dy === 0) {
        isShiftDraggingRef.current = false;
        setShiftOffset({ dx: 0, dy: 0 });
        return;
      }

      pushUndo();

      // Redraw image at offset within same canvas size (content beyond edges is clipped)
      const newCanvas = document.createElement('canvas');
      newCanvas.width = ec.width;
      newCanvas.height = ec.height;
      const newCtx = newCanvas.getContext('2d')!;
      newCtx.drawImage(ec, dx, dy);

      editCanvasRef.current = newCanvas;
      setShiftOffset({ dx: 0, dy: 0 });
      isShiftDraggingRef.current = false;

      renderCanvas();
    },
    [pushUndo, renderCanvas],
  );

  const enterTransform = useCallback(() => {
    const ec = editCanvasRef.current;
    const sel = pixelSelection;
    if (!ec || !sel || sel.width < 1 || sel.height < 1) return;

    pushUndo();

    // Extract selected pixels into floating canvas
    const srcCtx = ec.getContext('2d')!;
    const imageData = srcCtx.getImageData(sel.x, sel.y, sel.width, sel.height);

    const floating = document.createElement('canvas');
    floating.width = sel.width;
    floating.height = sel.height;
    floating.getContext('2d')!.putImageData(imageData, 0, 0);

    // Clear original area
    srcCtx.clearRect(sel.x, sel.y, sel.width, sel.height);

    // Initialize transform state
    transformRef.current = {
      floatingCanvas: floating,
      originX: sel.x,
      originY: sel.y,
      x: sel.x,
      y: sel.y,
      width: sel.width,
      height: sel.height,
      smooth: false,
    };
    setTransformActive(true);
    renderCanvas();
  }, [pixelSelection, pushUndo, renderCanvas]);

  const commitTransform = useCallback(() => {
    const t = transformRef.current;
    const ec = editCanvasRef.current;
    if (!t || !ec) return;

    const ctx = ec.getContext('2d')!;
    ctx.imageSmoothingEnabled = t.smooth;
    ctx.drawImage(t.floatingCanvas, t.x, t.y, t.width, t.height);
    ctx.imageSmoothingEnabled = false;

    transformRef.current = null;
    transformDragRef.current = null;
    setTransformActive(false);
    setPixelSelection(null);
    setTransformCursor('default');
    renderCanvas();
  }, [renderCanvas]);

  const cancelTransform = useCallback(() => {
    if (!transformRef.current) return;
    undo();
    transformRef.current = null;
    transformDragRef.current = null;
    setTransformActive(false);
    setPixelSelection(null);
    setTransformCursor('default');
    renderCanvas();
  }, [undo, renderCanvas]);

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

      // Transform mode: handle clicks
      if (transformActive && e.button === 0) {
        const handle = hitTestHandle(e);
        if (handle) {
          const t = transformRef.current!;
          const canvas = canvasRef.current!;
          const rect = canvas.getBoundingClientRect();
          const mx = (e.clientX - rect.left - pan.x) / zoom;
          const my = (e.clientY - rect.top - pan.y) / zoom;
          transformDragRef.current = {
            handle,
            startMx: mx,
            startMy: my,
            startX: t.x,
            startY: t.y,
            startW: t.width,
            startH: t.height,
          };
          return;
        } else {
          commitTransform();
          return;
        }
      }

      if (e.button !== 0) return;

      // Shift tool: start shift drag
      if (tool === 'shift') {
        isShiftDraggingRef.current = true;
        setHoveredEdge(null);
        shiftStartRef.current = { x: e.clientX, y: e.clientY };
        return;
      }

      const coord = getPixelCoord(e);
      if (!coord) return;

      // Paste mode: click to place clipboard (works regardless of tool)
      if (isPixelPasteMode && pixelClipboard) {
        const ec = editCanvasRef.current;
        if (ec) {
          pushUndo();
          const ctx = ec.getContext('2d')!;
          ctx.putImageData(pixelClipboard, coord.x, coord.y);
          renderCanvas();
        }
        return;
      }

      // Rect-select tool
      if (tool === 'rect-select') {
        // Start selection drag
        isRectSelectingRef.current = true;
        setHoveredEdge(null);
        rectSelectStartRef.current = { x: coord.x, y: coord.y };
        setPixelSelection({ x: coord.x, y: coord.y, width: 1, height: 1 });
        return;
      }

      if (tool === 'eyedropper') {
        pickColor(coord.x, coord.y);
        return;
      }

      pushUndo();
      isDrawingRef.current = true;
      setHoveredEdge(null);
      drawStartRef.current = { x: coord.x, y: coord.y };
      paintPixel(coord.x, coord.y);
    },
    [getPixelCoord, tool, pickColor, pushUndo, paintPixel, handlePanMove, handlePanEnd, isPixelPasteMode, pixelClipboard, renderCanvas, transformActive, hitTestHandle, commitTransform, zoom, pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Transform mode: update cursor on hover
      if (transformActive && !transformDragRef.current) {
        const handle = hitTestHandle(e);
        setTransformCursor(getHandleCursor(handle));
      }

      // Transform mode: drag in progress
      if (transformActive && transformDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left - pan.x) / zoom;
        const my = (e.clientY - rect.top - pan.y) / zoom;
        const drag = transformDragRef.current;
        const t = transformRef.current!;
        const dx = mx - drag.startMx;
        const dy = my - drag.startMy;
        const h = drag.handle;

        if (h === 'move') {
          t.x = Math.round(drag.startX + dx);
          t.y = Math.round(drag.startY + dy);
        } else {
          let newX = drag.startX;
          let newY = drag.startY;
          let newW = drag.startW;
          let newH = drag.startH;

          const isCorner = h === 'nw' || h === 'ne' || h === 'sw' || h === 'se';

          if (h === 'se' || h === 'e' || h === 'ne') newW = drag.startW + dx;
          if (h === 'nw' || h === 'w' || h === 'sw') { newX = drag.startX + dx; newW = drag.startW - dx; }
          if (h === 'se' || h === 's' || h === 'sw') newH = drag.startH + dy;
          if (h === 'nw' || h === 'n' || h === 'ne') { newY = drag.startY + dy; newH = drag.startH - dy; }

          if (isCorner && !e.shiftKey) {
            const ratio = drag.startW / drag.startH;
            const absDx = Math.abs(newW - drag.startW);
            const absDy = Math.abs(newH - drag.startH);

            if (absDx >= absDy) {
              const targetH = Math.round(newW / ratio);
              if (h === 'nw' || h === 'ne') {
                newY = drag.startY + drag.startH - targetH;
              }
              newH = targetH;
            } else {
              const targetW = Math.round(newH * ratio);
              if (h === 'nw' || h === 'sw') {
                newX = drag.startX + drag.startW - targetW;
              }
              newW = targetW;
            }
          }

          if (newW < 0) { newX += newW; newW = -newW; }
          if (newH < 0) { newY += newH; newH = -newH; }

          if (newW < 1) newW = 1;
          if (newH < 1) newH = 1;

          t.x = Math.round(newX);
          t.y = Math.round(newY);
          t.width = Math.round(newW);
          t.height = Math.round(newH);
        }

        renderCanvas();
        return;
      }

      // Shift dragging
      if (isShiftDraggingRef.current) {
        const dx = Math.round((e.clientX - shiftStartRef.current.x) / zoom);
        const dy = Math.round((e.clientY - shiftStartRef.current.y) / zoom);
        const newOffset = { dx, dy };
        shiftOffsetRef.current = newOffset;
        setShiftOffset(newOffset);
        renderCanvas();
        return;
      }

      // Rect-select drag
      if (isRectSelectingRef.current && rectSelectStartRef.current) {
        const coord = getPixelCoord(e);
        if (coord) {
          const sx = Math.min(rectSelectStartRef.current.x, coord.x);
          const sy = Math.min(rectSelectStartRef.current.y, coord.y);
          const ex = Math.max(rectSelectStartRef.current.x, coord.x);
          const ey = Math.max(rectSelectStartRef.current.y, coord.y);
          setPixelSelection({ x: sx, y: sy, width: ex - sx + 1, height: ey - sy + 1 });
        }
        renderCanvas();
        return;
      }

      // Update hover cursor for brush preview
      const hoverCoord = getPixelCoord(e);
      hoverPixelRef.current = hoverCoord;

      // Edge hover detection (only in tile edit mode)
      // - On edge tiles → 'delete'
      // - Outside image (within 1 tile margin) → 'add'
      if (tileEditMode && !isDrawingRef.current && !isShiftDraggingRef.current && !isRectSelectingRef.current) {
        const ec = editCanvasRef.current;
        const canvas = canvasRef.current;
        if (ec && canvas) {
          const rect = canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left - pan.x;
          const my = e.clientY - rect.top - pan.y;
          const tw = effectiveTileWidth * zoom;
          const th = effectiveTileHeight * zoom;
          const cols = Math.round(ec.width / effectiveTileWidth);
          const rows = Math.round(ec.height / effectiveTileHeight);
          const imgW = cols * tw;
          const imgH = rows * th;

          const inImageX = mx >= 0 && mx < imgW;
          const inImageY = my >= 0 && my < imgH;
          // Outside image but within one tile width/height
          const inAddLeft = mx >= -tw && mx < 0;
          const inAddRight = mx >= imgW && mx < imgW + tw;
          const inAddTop = my >= -th && my < 0;
          const inAddBottom = my >= imgH && my < imgH + th;

          const tileX = Math.floor(mx / tw);
          const tileY = Math.floor(my / th);

          type A = 'add' | 'delete' | null;
          let top: A = null, bottom: A = null, left: A = null, right: A = null;

          if (inImageX && inImageY) {
            // On edge tiles → delete
            const isTop = tileY === 0;
            const isBottom = tileY === rows - 1;
            const isLeft = tileX === 0;
            const isRight = tileX === cols - 1;

            if ((isTop || isBottom) && (isLeft || isRight)) {
              // Corner tile: use diagonal to pick one axis
              // Distance from tile edges: closer to horizontal edge → row, closer to vertical → column
              const withinTileX = mx - tileX * tw; // px from left of tile
              const withinTileY = my - tileY * th; // px from top of tile
              const distToVertEdge = isLeft ? withinTileX : tw - withinTileX;
              const distToHorizEdge = isTop ? withinTileY : th - withinTileY;
              // Normalize: compare ratio to tile dimensions
              if (distToHorizEdge / th < distToVertEdge / tw) {
                // Closer to horizontal edge → select row
                if (isTop) top = 'delete';
                if (isBottom) bottom = 'delete';
              } else {
                // Closer to vertical edge → select column
                if (isLeft) left = 'delete';
                if (isRight) right = 'delete';
              }
            } else {
              if (isTop) top = 'delete';
              if (isBottom) bottom = 'delete';
              if (isLeft) left = 'delete';
              if (isRight) right = 'delete';
            }
          } else {
            // Outside image → add for the corresponding edge
            const isAddTop = inAddTop && (inImageX || inAddLeft || inAddRight);
            const isAddBottom = inAddBottom && (inImageX || inAddLeft || inAddRight);
            const isAddLeft = inAddLeft && (inImageY || inAddTop || inAddBottom);
            const isAddRight = inAddRight && (inImageY || inAddTop || inAddBottom);

            if ((isAddTop || isAddBottom) && (isAddLeft || isAddRight)) {
              // Corner outside: use diagonal to pick one axis
              const distToImgX = isAddLeft ? -mx : mx - imgW;
              const distToImgY = isAddTop ? -my : my - imgH;
              if (distToImgY / th < distToImgX / tw) {
                if (isAddTop) top = 'add';
                if (isAddBottom) bottom = 'add';
              } else {
                if (isAddLeft) left = 'add';
                if (isAddRight) right = 'add';
              }
            } else {
              if (isAddTop) top = 'add';
              if (isAddBottom) bottom = 'add';
              if (isAddLeft) left = 'add';
              if (isAddRight) right = 'add';
            }
          }

          if (top || bottom || left || right) {
            setHoveredEdge({ top, bottom, left, right });
          } else {
            setHoveredEdge(null);
          }
        }
      }

      // Drawing (pan is handled at document level now)
      if (!isDrawingRef.current) {
        renderCanvas(); // re-render to show cursor preview
        return;
      }
      const coord = hoverCoord;
      if (!coord) return;

      // Shift key: constrain to horizontal or vertical axis from start
      if (e.shiftKey && drawStartRef.current) {
        const dx = Math.abs(coord.x - drawStartRef.current.x);
        const dy = Math.abs(coord.y - drawStartRef.current.y);
        if (dx > dy) {
          coord.y = drawStartRef.current.y; // lock vertical
        } else {
          coord.x = drawStartRef.current.x; // lock horizontal
        }
      }

      paintPixel(coord.x, coord.y);
    },
    [getPixelCoord, getTileCoord, paintPixel, zoom, pan, effectiveTileWidth, effectiveTileHeight, tileEditMode, renderCanvas],
  );

  const handleMouseUp = useCallback(() => {
    if (transformDragRef.current) {
      transformDragRef.current = null;
      return;
    }
    if (isRectSelectingRef.current) {
      isRectSelectingRef.current = false;
      rectSelectStartRef.current = null;
      // Enter transform mode if we have a valid selection
      setTimeout(() => enterTransform(), 0);
      return;
    }
    if (isShiftDraggingRef.current) {
      const so = shiftOffsetRef.current;
      applyShift(so.dx, so.dy);
      return;
    }
    isDrawingRef.current = false;
    drawStartRef.current = null;
  }, [applyShift, enterTransform]);

  // Cleanup document listeners on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handlePanMove);
      document.removeEventListener('mouseup', handlePanEnd);
    };
  }, [handlePanMove, handlePanEnd]);

  // --- Wheel: scroll=pan vertical, shift+scroll=pan horizontal, cmd/ctrl+scroll=zoom ---
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Cmd/Ctrl + scroll = zoom
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

        const wx = (mx - pan.x) / oldZoom;
        const wy = (my - pan.y) / oldZoom;
        setPan({ x: mx - wx * newZoom, y: my - wy * newZoom });
        setZoom(newZoom);
      } else if (e.shiftKey) {
        // Shift + scroll = pan horizontal
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        setPan((p) => ({ ...p, x: p.x - delta }));
      } else {
        // Scroll = pan vertical
        setPan((p) => ({ ...p, y: p.y - e.deltaY }));
      }
    },
    [zoom, pan],
  );

  const switchTool = useCallback((newTool: Tool) => {
    if (transformActive) commitTransform();
    setTool(newTool);
    setIsPixelPasteMode(false);
    setTileEditMode(false);
    setHoveredEdge(null);
  }, [transformActive, commitTransform]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        redo();
      } else if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        // Copy pixel selection → auto enter paste mode
        e.preventDefault();
        const ec = editCanvasRef.current;
        if (ec && pixelSelection) {
          const ctx = ec.getContext('2d')!;
          const id = ctx.getImageData(pixelSelection.x, pixelSelection.y, pixelSelection.width, pixelSelection.height);
          setPixelClipboard(id);
          setIsPixelPasteMode(true);
        }
      } else if (!mod) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (transformActive) {
            cancelTransform();
          } else if (isPixelPasteMode) {
            setIsPixelPasteMode(false);
            setPixelClipboard(null);
          } else {
            setPixelSelection(null);
          }
        }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (transformActive) {
            commitTransform();
          }
        }
        else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); switchTool('eraser'); }
        else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); switchTool('pen'); }
        else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); switchTool('eyedropper'); }
        else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); switchTool('shift'); }
        else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); switchTool('rect-select'); }
        else if (e.key === 't' || e.key === 'T') { e.preventDefault(); trimEdges(); }
        else if (e.key === '[') { e.preventDefault(); setBrushSize((s) => Math.max(1, s - 1)); }
        else if (e.key === ']') { e.preventDefault(); setBrushSize((s) => Math.min(16, s + 1)); }
        else if (e.key === '?') { e.preventDefault(); setShowHelp((v) => !v); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, undo, redo, pixelSelection, pixelClipboard, isPixelPasteMode, transformActive, commitTransform, cancelTransform, switchTool]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Save handlers ---
  const getDataUrl = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec) return '';
    return ec.toDataURL('image/png');
  }, []);

  const handleSaveAsNew = useCallback(() => {
    if (!isDirectImage && (!tilesetInfo || !region)) return;
    const ec = editCanvasRef.current;
    if (!ec) return;

    const tileCount = expandedCols * expandedRows;

    // Re-layout tiles: use original tileset columns if available, otherwise square-ish grid
    const origColumns = tilesetInfo?.columns ?? expandedCols;
    const maxCols = tileCount === 1 ? origColumns : Math.min(expandedCols, Math.max(origColumns, Math.ceil(Math.sqrt(tileCount))));
    const layoutRows = Math.ceil(tileCount / maxCols);

    // Re-draw tiles into new layout
    const tw = effectiveTileWidth;
    const th = effectiveTileHeight;
    const layoutCanvas = document.createElement('canvas');
    layoutCanvas.width = maxCols * tw;
    layoutCanvas.height = layoutRows * th;
    const ctx = layoutCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < tileCount; i++) {
      const srcCol = i % expandedCols;
      const srcRow = Math.floor(i / expandedCols);
      const dstCol = i % maxCols;
      const dstRow = Math.floor(i / maxCols);
      ctx.drawImage(ec, srcCol * tw, srcRow * th, tw, th, dstCol * tw, dstRow * th, tw, th);
    }

    const dataUrl = layoutCanvas.toDataURL('image/png');
    const name = tilesetInfo ? `${tilesetInfo.name}-edited` : 'selection-edited';
    onSaveAsNew(dataUrl, name, maxCols, tw, th, tileCount);
    onClose();
  }, [effectiveTileWidth, effectiveTileHeight, tilesetInfo, region, isDirectImage, expandedCols, expandedRows, onSaveAsNew, onClose]);

  const handleOverwrite = useCallback(() => {
    const dataUrl = getDataUrl();
    const tw = effectiveTileWidth;
    const th = effectiveTileHeight;

    if (isDirectImage) {
      // Direct image mode (e.g. opened from selection)
      const origCols = initialCols ?? 1;
      const origRows = initialRows ?? 1;
      // Use firstgid 0 to signal "apply edited selection back to map"
      onOverwrite(0, dataUrl, expandedCols, expandedRows, origCols, origRows);
    } else if (region) {
      onOverwrite(region.firstgid, dataUrl, expandedCols, expandedRows, region.width, region.height);
    }
    onClose();
  }, [region, getDataUrl, onOverwrite, onClose, isDirectImage, expandedCols, expandedRows, initialCols, initialRows, effectiveTileWidth, effectiveTileHeight]);

  // --- Resize handler ---
  const applyResize = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec) return;

    const targetW = resizeTargetCols * effectiveTileWidth;
    const targetH = resizeTargetRows * effectiveTileHeight;
    if (targetW === ec.width && targetH === ec.height) return;

    pushUndo();

    const newCanvas = document.createElement('canvas');
    newCanvas.width = targetW;
    newCanvas.height = targetH;
    const ctx = newCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ec, 0, 0, ec.width, ec.height, 0, 0, targetW, targetH);

    editCanvasRef.current = newCanvas;
    setExpandedCols(resizeTargetCols);
    setExpandedRows(resizeTargetRows);
    requestAnimationFrame(() => { autoFit(); renderCanvas(); });
  }, [tilesetInfo, resizeTargetCols, resizeTargetRows, pushUndo, autoFit, renderCanvas]);

  // --- Remove background from current edit canvas ---
  const handleRemoveBg = useCallback(async () => {
    const ec = editCanvasRef.current;
    if (!ec) return;

    pushUndo();
    setRemovingBg(t('mapEditor.pixel.removingBg'));

    try {
      const blob = await new Promise<Blob>((resolve) => {
        ec.toBlob((b) => resolve(b!), 'image/png');
      });

      const resultDataUrl = await removeBgToDataUrl(blob, (p) => {
        setRemovingBg(t('mapEditor.pixel.removingBgProgress', { percent: Math.round(p * 100) }));
      });

      // Load result and replace edit canvas
      const img = new Image();
      img.onload = () => {
        const newCanvas = document.createElement('canvas');
        newCanvas.width = ec.width;
        newCanvas.height = ec.height;
        const ctx = newCanvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        editCanvasRef.current = newCanvas;
        setRemovingBg(null);
        renderCanvas();
      };
      img.src = resultDataUrl;
    } catch (err) {
      console.error('Background removal failed:', err);
      setRemovingBg(null);
    }
  }, [pushUndo, renderCanvas]);

  // --- Trim fully transparent edge rows/columns ---
  const trimEdges = useCallback(() => {
    const ec = editCanvasRef.current;
    if (!ec) return;
    const ctx = ec.getContext('2d')!;
    const tw = effectiveTileWidth;
    const th = effectiveTileHeight;
    const cols = Math.round(ec.width / tw);
    const rows = Math.round(ec.height / th);

    // Check which edge tile-columns/rows are fully transparent
    const isColEmpty = (col: number) => {
      const id = ctx.getImageData(col * tw, 0, tw, ec.height);
      for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 0) return false;
      return true;
    };
    const isRowEmpty = (row: number) => {
      const id = ctx.getImageData(0, row * th, ec.width, th);
      for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 0) return false;
      return true;
    };

    let trimLeft = 0, trimRight = 0, trimTop = 0, trimBottom = 0;
    while (trimLeft < cols - 1 && isColEmpty(trimLeft)) trimLeft++;
    while (trimRight < cols - 1 - trimLeft && isColEmpty(cols - 1 - trimRight)) trimRight++;
    while (trimTop < rows - 1 && isRowEmpty(trimTop)) trimTop++;
    while (trimBottom < rows - 1 - trimTop && isRowEmpty(rows - 1 - trimBottom)) trimBottom++;

    if (trimLeft === 0 && trimRight === 0 && trimTop === 0 && trimBottom === 0) return;

    pushUndo();
    const newCols = cols - trimLeft - trimRight;
    const newRows = rows - trimTop - trimBottom;
    const newCanvas = document.createElement('canvas');
    newCanvas.width = newCols * tw;
    newCanvas.height = newRows * th;
    const newCtx = newCanvas.getContext('2d')!;
    newCtx.drawImage(ec, trimLeft * tw, trimTop * th, newCanvas.width, newCanvas.height, 0, 0, newCanvas.width, newCanvas.height);

    editCanvasRef.current = newCanvas;
    setExpandedCols(newCols);
    setExpandedRows(newRows);
    requestAnimationFrame(() => { autoFit(); renderCanvas(); });
  }, [effectiveTileWidth, effectiveTileHeight, pushUndo, autoFit, renderCanvas]);

  // --- Delete edge row/column ---
  const deleteEdge = useCallback((edge: 'left' | 'right' | 'top' | 'bottom') => {
    const ec = editCanvasRef.current;
    if (!ec) return;
    const tw = effectiveTileWidth;
    const th = effectiveTileHeight;
    const cols = Math.round(ec.width / tw);
    const rows = Math.round(ec.height / th);
    if ((edge === 'left' || edge === 'right') && cols <= 1) return;
    if ((edge === 'top' || edge === 'bottom') && rows <= 1) return;

    pushUndo();
    let sx = 0, sy = 0, newCols = cols, newRows = rows;
    if (edge === 'left') { sx = tw; newCols--; }
    if (edge === 'right') { newCols--; }
    if (edge === 'top') { sy = th; newRows--; }
    if (edge === 'bottom') { newRows--; }

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newCols * tw;
    newCanvas.height = newRows * th;
    const newCtx = newCanvas.getContext('2d')!;
    newCtx.drawImage(ec, sx, sy, newCanvas.width, newCanvas.height, 0, 0, newCanvas.width, newCanvas.height);

    editCanvasRef.current = newCanvas;
    setExpandedCols(newCols);
    setExpandedRows(newRows);
    requestAnimationFrame(() => { autoFit(); renderCanvas(); });
  }, [effectiveTileWidth, effectiveTileHeight, pushUndo, autoFit, renderCanvas]);

  // --- Add edge tile row/column ---
  const addEdge = useCallback((edge: 'left' | 'right' | 'top' | 'bottom') => {
    const ec = editCanvasRef.current;
    if (!ec) return;
    const tw = effectiveTileWidth;
    const th = effectiveTileHeight;
    const cols = Math.round(ec.width / tw);
    const rows = Math.round(ec.height / th);

    pushUndo();
    let drawX = 0, drawY = 0, newCols = cols, newRows = rows;
    if (edge === 'left') { drawX = tw; newCols++; }
    if (edge === 'right') { newCols++; }
    if (edge === 'top') { drawY = th; newRows++; }
    if (edge === 'bottom') { newRows++; }

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newCols * tw;
    newCanvas.height = newRows * th;
    const newCtx = newCanvas.getContext('2d')!;
    newCtx.drawImage(ec, drawX, drawY);

    editCanvasRef.current = newCanvas;
    setExpandedCols(newCols);
    setExpandedRows(newRows);
    requestAnimationFrame(() => { autoFit(); renderCanvas(); });
  }, [effectiveTileWidth, effectiveTileHeight, pushUndo, autoFit, renderCanvas]);

  // --- Guard: don't render if no data ---
  if (!isDirectImage && (!region || !tilesetInfo)) {
    return (
      <Modal open={open} onClose={onClose} title={t('mapEditor.pixel.title')} size="full" disableEscapeClose>
        <Modal.Body>
          <p className="text-text-secondary">{t('mapEditor.pixel.noRegion')}</p>
        </Modal.Body>
      </Modal>
    );
  }

  // --- Cursor style ---
  const cursorStyle = transformActive
    ? transformCursor
    : tool === 'shift' ? 'move' : tool === 'rect-select' ? 'crosshair' : tool === 'eyedropper' ? 'crosshair' : tool === 'eraser' ? 'cell' : 'default';

  const isExpanded = region && (expandedCols !== region.width || expandedRows !== region.height);

  return (
    <Modal open={open} onClose={onClose} title={t('mapEditor.pixel.title')} size="full" disableEscapeClose>
      {/* Custom body: fixed height to fill modal, flex col so canvas area stretches */}
      <div className="flex flex-col overflow-hidden" style={{ height: 'calc(85vh - 120px)' }}>
        {/* Toolbar row */}
        <div className="flex items-center h-10 bg-surface border-b border-border px-1 select-none flex-shrink-0">
          {/* Tools */}
          <div className="flex items-center gap-1 px-2 border-r border-border">
            <Tooltip label={t('mapEditor.pixel.penTooltip')} shortcut="P">
              <Button variant={!tileEditMode && tool === 'pen' ? 'primary' : 'ghost'} size="sm" onClick={() => switchTool('pen')}>
                <Pencil className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('mapEditor.pixel.eraserTooltip')} shortcut="E">
              <Button variant={!tileEditMode && tool === 'eraser' ? 'primary' : 'ghost'} size="sm" onClick={() => switchTool('eraser')}>
                <Eraser className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('mapEditor.pixel.eyedropperTooltip')} shortcut="I">
              <Button variant={!tileEditMode && tool === 'eyedropper' ? 'primary' : 'ghost'} size="sm" onClick={() => switchTool('eyedropper')}>
                <Pipette className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('mapEditor.pixel.shiftTooltip')} shortcut="V">
              <Button variant={!tileEditMode && tool === 'shift' ? 'primary' : 'ghost'} size="sm" onClick={() => switchTool('shift')}>
                <Move className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('mapEditor.pixel.selectTooltip')} shortcut="M">
              <Button variant={!tileEditMode && tool === 'rect-select' ? 'primary' : 'ghost'} size="sm" onClick={() => switchTool('rect-select')}>
                <BoxSelect className="w-4 h-4" />
              </Button>
            </Tooltip>
          </div>

          {/* Canvas Operations: BG Remove, Trim */}
          <div className="flex items-center gap-0.5 px-2 border-r border-border">
            {removingBg ? (
              <span className="text-caption text-primary-light px-1">{removingBg}</span>
            ) : (
              <Tooltip label={t('mapEditor.pixel.eraseBgTooltip')}>
                <Button variant="ghost" size="sm" onClick={handleRemoveBg}>
                  <ImageMinus className="w-4 h-4" />
                </Button>
              </Tooltip>
            )}
            <Tooltip label={t('mapEditor.pixel.trimTooltip')} shortcut="T">
              <Button variant="ghost" size="sm" onClick={trimEdges}>
                <Scissors className="w-4 h-4" />
              </Button>
            </Tooltip>

            <div className="w-px h-4 bg-border mx-0.5" />

            <Tooltip label={t('mapEditor.pixel.tileEditMode')}>
              <Button variant={tileEditMode ? 'primary' : 'ghost'} size="sm" onClick={() => { setTileEditMode(v => !v); setHoveredEdge(null); }}>
                <Grid3x3 className="w-4 h-4" />
              </Button>
            </Tooltip>

            {/* Resize (next to tile edit mode) */}
            <Tooltip label={t('mapEditor.pixel.resize')}>
              <span className="text-caption text-text-secondary"><Maximize2 className="w-3.5 h-3.5" /></span>
            </Tooltip>
            <input
              type="number"
              min={1}
              max={20}
              value={resizeTargetCols}
              onChange={(e) => setResizeTargetCols(Math.max(1, Number(e.target.value)))}
              className="w-10 h-6 text-center text-caption bg-surface-raised border border-border rounded text-text"
            />
            <span className="text-caption text-text-dim">×</span>
            <input
              type="number"
              min={1}
              max={20}
              value={resizeTargetRows}
              onChange={(e) => setResizeTargetRows(Math.max(1, Number(e.target.value)))}
              className="w-10 h-6 text-center text-caption bg-surface-raised border border-border rounded text-text"
            />
            <Button variant="ghost" size="sm" onClick={applyResize}>{t('mapEditor.pixel.apply')}</Button>
          </div>

          {/* Brush & Color */}
          <div className="flex items-center gap-1.5 px-2 border-r border-border">
            <Tooltip label={t('mapEditor.pixel.brushSizeTooltip')} shortcut="[ / ]">
              <span className="text-caption text-text-secondary">{t('mapEditor.pixel.brushSize')}</span>
            </Tooltip>
            <input
              type="range"
              min={1}
              max={16}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-16"
            />
            <span className="text-caption text-text-secondary w-5 text-right tabular-nums">{brushSize}</span>

            <div className="w-px h-4 bg-border mx-0.5" />

            <Tooltip label={t('mapEditor.pixel.color')}>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-6 h-6 border border-border rounded cursor-pointer bg-transparent"
              />
            </Tooltip>

            <Tooltip label={t('mapEditor.pixel.alpha')}>
              <span className="text-caption text-text-secondary">A</span>
            </Tooltip>
            <input
              type="range"
              min={0}
              max={255}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
              className="w-16"
            />
            <span className="text-caption text-text-secondary w-8 text-right tabular-nums">{alpha}</span>
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center gap-1 px-2 border-r border-border">
            <Tooltip label={t('mapEditor.pixel.undoTooltip')} shortcut="⌘Z">
              <Button variant="ghost" size="sm" onClick={undo}>
                <Undo2 className="w-4 h-4" />
              </Button>
            </Tooltip>
            <Tooltip label={t('mapEditor.pixel.redoTooltip')} shortcut="⌘⇧Z">
              <Button variant="ghost" size="sm" onClick={redo}>
                <Redo2 className="w-4 h-4" />
              </Button>
            </Tooltip>
          </div>

          {/* Zoom */}
          <div className="flex items-center gap-1 px-2 border-r border-border">
            <Tooltip label={t('mapEditor.pixel.zoomTooltip')} shortcut="Wheel">
              <span className="text-caption text-text-secondary tabular-nums">{zoom}×</span>
            </Tooltip>
          </div>

          {/* Help */}
          <div className="flex items-center px-2">
            <Tooltip label={t('mapEditor.pixel.shortcutsTooltip')} shortcut="?">
              <Button variant="ghost" size="sm" onClick={() => setShowHelp(true)}>
                <HelpCircle className="w-4 h-4" />
              </Button>
            </Tooltip>
          </div>

          {/* Spacer + Region Info */}
          <div className="flex-1" />
          <div className="px-3">
            <span className="text-caption text-text-secondary tabular-nums">
              {t('mapEditor.pixel.dimensions', { w: editPxW, h: editPxH, cols: expandedCols, rows: expandedRows })}
              {isExpanded && (
                <span className="text-amber-400 ml-1">{t('mapEditor.pixel.expanded')}</span>
              )}
            </span>
          </div>
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="flex-1 min-h-0 overflow-hidden bg-bg-deep relative"
          style={{ cursor: cursorStyle }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { hoverPixelRef.current = null; setHoveredEdge(null); renderCanvas(); }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { hoverPixelRef.current = null; renderCanvas(); }}
            onWheel={handleWheel}
            onContextMenu={(e) => e.preventDefault()}
          />

          {/* Edge hover zones: delete (red) on edge row/col, add (green) outside */}
          {hoveredEdge && (() => {
            const ec = editCanvasRef.current;
            if (!ec) return null;
            const tw = effectiveTileWidth * zoom;
            const th = effectiveTileHeight * zoom;
            const cols = Math.round(ec.width / effectiveTileWidth);
            const rows = Math.round(ec.height / effectiveTileHeight);
            const imgW = cols * tw;
            const imgH = rows * th;

            const zones: React.ReactNode[] = [];
            const delCls = "w-full h-full bg-red-500/20 hover:bg-red-500/35 border border-red-500/40 hover:border-red-500/60 transition-colors";
            const addCls = "w-full h-full bg-green-500/15 hover:bg-green-500/30 border border-dashed border-green-500/30 hover:border-green-500/50 transition-colors";

            // Top
            if (hoveredEdge.top === 'delete') {
              zones.push(
                <div key="del-top" className="absolute cursor-pointer" title={t('mapEditor.pixel.deleteTopRowTooltip')}
                  style={{ left: pan.x, top: pan.y, width: imgW, height: th }}
                  onClick={() => { deleteEdge('top'); setHoveredEdge(null); }}
                ><div className={delCls} /></div>
              );
            } else if (hoveredEdge.top === 'add') {
              zones.push(
                <div key="add-top" className="absolute cursor-pointer" title={t('mapEditor.pixel.addTopRowTooltip')}
                  style={{ left: pan.x, top: pan.y - th, width: imgW, height: th }}
                  onClick={() => { addEdge('top'); setHoveredEdge(null); }}
                ><div className={addCls} /></div>
              );
            }

            // Bottom
            if (hoveredEdge.bottom === 'delete') {
              zones.push(
                <div key="del-bottom" className="absolute cursor-pointer" title={t('mapEditor.pixel.deleteBottomRowTooltip')}
                  style={{ left: pan.x, top: pan.y + imgH - th, width: imgW, height: th }}
                  onClick={() => { deleteEdge('bottom'); setHoveredEdge(null); }}
                ><div className={delCls} /></div>
              );
            } else if (hoveredEdge.bottom === 'add') {
              zones.push(
                <div key="add-bottom" className="absolute cursor-pointer" title={t('mapEditor.pixel.addBottomRowTooltip')}
                  style={{ left: pan.x, top: pan.y + imgH, width: imgW, height: th }}
                  onClick={() => { addEdge('bottom'); setHoveredEdge(null); }}
                ><div className={addCls} /></div>
              );
            }

            // Left
            if (hoveredEdge.left === 'delete') {
              zones.push(
                <div key="del-left" className="absolute cursor-pointer" title={t('mapEditor.pixel.deleteLeftColTooltip')}
                  style={{ left: pan.x, top: pan.y, width: tw, height: imgH }}
                  onClick={() => { deleteEdge('left'); setHoveredEdge(null); }}
                ><div className={delCls} /></div>
              );
            } else if (hoveredEdge.left === 'add') {
              zones.push(
                <div key="add-left" className="absolute cursor-pointer" title={t('mapEditor.pixel.addLeftColTooltip')}
                  style={{ left: pan.x - tw, top: pan.y, width: tw, height: imgH }}
                  onClick={() => { addEdge('left'); setHoveredEdge(null); }}
                ><div className={addCls} /></div>
              );
            }

            // Right
            if (hoveredEdge.right === 'delete') {
              zones.push(
                <div key="del-right" className="absolute cursor-pointer" title={t('mapEditor.pixel.deleteRightColTooltip')}
                  style={{ left: pan.x + imgW - tw, top: pan.y, width: tw, height: imgH }}
                  onClick={() => { deleteEdge('right'); setHoveredEdge(null); }}
                ><div className={delCls} /></div>
              );
            } else if (hoveredEdge.right === 'add') {
              zones.push(
                <div key="add-right" className="absolute cursor-pointer" title={t('mapEditor.pixel.addRightColTooltip')}
                  style={{ left: pan.x + imgW, top: pan.y, width: tw, height: imgH }}
                  onClick={() => { addEdge('right'); setHoveredEdge(null); }}
                ><div className={addCls} /></div>
              );
            }

            return <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}><div className="pointer-events-auto">{zones}</div></div>;
          })()}
        </div>
      </div>

      {/* Help overlay */}
      {showHelp && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-bg rounded-xl border border-border p-6 max-w-lg text-body"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-heading text-text">{t('mapEditor.pixel.keyboardShortcuts')}</h3>
              <button onClick={() => setShowHelp(false)} className="text-text-muted hover:text-text">&times;</button>
            </div>
            <div className="grid grid-cols-2 gap-y-1 gap-x-6 text-caption">
              {[
                ['P', t('mapEditor.pixel.shortcutPen')],
                ['E', t('mapEditor.pixel.shortcutEraser')],
                ['I', t('mapEditor.pixel.shortcutEyedropper')],
                ['V', t('mapEditor.pixel.shortcutShift')],
                ['M', t('mapEditor.pixel.shortcutSelect')],
                ['Cmd/Ctrl+C', t('mapEditor.pixel.shortcutCopy')],
                ['Escape', t('mapEditor.pixel.shortcutEscape')],
                ['T', t('mapEditor.pixel.shortcutTrim')],
                ['[ / ]', t('mapEditor.pixel.shortcutBrushSize')],
                ['Cmd/Ctrl+Z', t('mapEditor.pixel.shortcutUndo')],
                ['Cmd/Ctrl+Y', t('mapEditor.pixel.shortcutRedo')],
                ['Cmd/Ctrl+Shift+Z', t('mapEditor.pixel.shortcutRedoAlt')],
                ['?', t('mapEditor.pixel.shortcutHelp')],
                ['Mouse wheel', t('mapEditor.pixel.shortcutZoom')],
                ['Middle-click drag', t('mapEditor.pixel.shortcutPan')],
                ['Shift + draw', t('mapEditor.pixel.shortcutConstrain')],
                ['Escape', t('mapEditor.pixel.shortcutClose')],
              ].map(([key, desc]) => (
                <div key={key} className="contents">
                  <span className="text-text font-mono bg-surface-raised px-1.5 py-0.5 rounded border border-border text-center">
                    {key}
                  </span>
                  <span className="text-text-secondary py-0.5">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <Modal.Footer>
        {onApply ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => {
              const ec = editCanvasRef.current;
              if (!ec) return;
              onApply(ec.toDataURL('image/png'), expandedCols, expandedRows);
            }}>
              {t('mapEditor.pixel.apply')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {onSaveAsStamp && (
              <Button variant="secondary" size="sm" onClick={() => {
                const ec = editCanvasRef.current;
                if (!ec) return;
                const dataUrl = ec.toDataURL('image/png');
                onSaveAsStamp(dataUrl, expandedCols, expandedRows, effectiveTileWidth, effectiveTileHeight);
              }}>
                {t('mapEditor.pixel.saveAsStamp')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={handleSaveAsNew}>
              {t('mapEditor.pixel.saveAsNew')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleOverwrite}
              disabled={isDirectImage ? false : !!isExpanded}
              title={!isDirectImage && isExpanded ? t('mapEditor.pixel.overwriteDisabled') : undefined}
            >
              {t('mapEditor.pixel.applyToMap')}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
