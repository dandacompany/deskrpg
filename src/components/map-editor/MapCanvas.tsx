'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { EditorState, TileRegion, TilesetImageInfo, EditorAction } from './hooks/useMapEditor';
import { useCanvasRenderer, type CharacterState } from './hooks/useCanvasRenderer';
import { usePanZoom } from './hooks/usePanZoom';
import { compositeCharacter } from '@/lib/sprite-compositor';
import { getDefaultLayers } from '@/hooks/useCharacterAppearance';
import { useT } from '@/lib/i18n';

// === Props ===

interface MapCanvasProps {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  findTileset: (gid: number) => TilesetImageInfo | null;
  onStatusUpdate?: (info: { tileX: number; tileY: number; gid: number }) => void;
  layerOverlayMap?: Record<number, boolean>;
  onEditSelectionPixels?: (dataUrl: string, width: number, height: number, tileWidth: number, tileHeight: number) => void;
  onCopySelection?: () => void;
  onSaveAsStamp?: (thumbnail: string | null) => void;
  activeStamp?: any | null;
  onPlaceStamp?: (targetX: number, targetY: number) => void;
}

// === Constants ===

const CHARACTER_DRAW_SIZE = 48;
const CHARACTER_FRAME_COUNT = 9; // 0 = idle, 1-8 = walk
const WALK_INTERVAL_MS = 120;

// === Component ===

export function MapCanvas({ state, dispatch, findTileset, onStatusUpdate, layerOverlayMap, onEditSelectionPixels, onCopySelection, onSaveAsStamp, activeStamp, onPlaceStamp }: MapCanvasProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Character
  const characterSheetRef = useRef<HTMLImageElement | null>(null);
  const [characterLoaded, setCharacterLoaded] = useState(false);
  const [characterState, setCharacterState] = useState<CharacterState>({
    tileX: 0,
    tileY: 0,
    frame: 0,
    direction: 0,
  });

  // Drag state refs (avoid re-renders during drag)
  const isDraggingTile = useRef(false);
  const isDraggingCharacter = useRef(false);
  const isSelectDragging = useRef(false);
  const isMovingSelection = useRef(false);
  const moveOrigin = useRef<{ x: number; y: number } | null>(null);
  const moveStartSelection = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const selectStart = useRef<{ x: number; y: number } | null>(null);
  const pendingChanges = useRef<Array<{ index: number; oldGid: number; newGid: number }>>([]);
  const pendingLayerIndex = useRef<number>(0);
  const walkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDragPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPasteMode, setIsPasteMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [stampCursorTile, setStampCursorTile] = useState<{ x: number; y: number } | null>(null);
  const stampPreviewImgRef = useRef<HTMLImageElement | null>(null);
  const [pasteCursorTile, setPasteCursorTile] = useState<{ x: number; y: number } | null>(null);
  const pastePreviewImgRef = useRef<HTMLImageElement | null>(null);

  // Hooks
  const { render } = useCanvasRenderer(state, findTileset);
  const panZoom = usePanZoom(state, dispatch);

  // === Load character spritesheet (composited from default appearance) ===

  useEffect(() => {
    const canvas = document.createElement('canvas');
    const appearance = { bodyType: 'male', layers: getDefaultLayers('male') };
    compositeCharacter(canvas, appearance)
      .then(() => {
        // Convert composited canvas to an Image for the renderer
        const img = new Image();
        img.onload = () => {
          characterSheetRef.current = img;
          setCharacterLoaded(true);
        };
        img.src = canvas.toDataURL('image/png');
      })
      .catch(() => {
        characterSheetRef.current = null;
      });
  }, []);

  // === Place character at spawn point on map init ===

  useEffect(() => {
    if (!state.mapData) return;
    for (const layer of state.mapData.layers) {
      if (layer.type === 'objectgroup' && layer.objects) {
        const spawn = layer.objects.find(
          (o) => o.type === 'spawn' || o.name.toLowerCase() === 'spawn',
        );
        if (spawn) {
          setCharacterState((prev) => ({
            ...prev,
            tileX: Math.floor(spawn.x / state.mapData!.tilewidth),
            tileY: Math.floor(spawn.y / state.mapData!.tileheight),
            frame: 0,
          }));
          return;
        }
      }
    }
    // Fallback: center of map
    setCharacterState((prev) => ({
      ...prev,
      tileX: Math.floor(state.mapData!.width / 2),
      tileY: Math.floor(state.mapData!.height / 2),
      frame: 0,
    }));
  }, [state.mapData?.width, state.mapData?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // === Canvas sizing via ResizeObserver ===

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const preview = activeStamp && stampCursorTile
          ? { tileX: stampCursorTile.x, tileY: stampCursorTile.y, cols: activeStamp.cols, rows: activeStamp.rows, previewImage: stampPreviewImgRef.current ?? undefined }
          : isPasteMode && pasteCursorTile && state.clipboard
          ? { tileX: pasteCursorTile.x, tileY: pasteCursorTile.y, cols: state.clipboard.width, rows: state.clipboard.height, previewImage: pastePreviewImgRef.current ?? undefined }
          : undefined;
        render(canvas, characterSheetRef.current ?? undefined, characterState, {
          layerOverlayMap,
          stampPreview: preview,
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [render, characterState]); // eslint-disable-line react-hooks/exhaustive-deps

  // === Re-render on state changes ===

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const preview = activeStamp && stampCursorTile
      ? { tileX: stampCursorTile.x, tileY: stampCursorTile.y, cols: activeStamp.cols, rows: activeStamp.rows, previewImage: stampPreviewImgRef.current ?? undefined }
      : isPasteMode && pasteCursorTile && state.clipboard
      ? { tileX: pasteCursorTile.x, tileY: pasteCursorTile.y, cols: state.clipboard.width, rows: state.clipboard.height, previewImage: pastePreviewImgRef.current ?? undefined }
      : undefined;
    render(canvas, characterSheetRef.current ?? undefined, characterState, {
      layerOverlayMap,
      stampPreview: preview,
    });
  }, [state, characterState, characterLoaded, render, stampCursorTile, activeStamp, isPasteMode, pasteCursorTile]);

  // === Coordinate conversion ===

  const screenToTile = useCallback(
    (mx: number, my: number): { x: number; y: number } => {
      if (!state.mapData) return { x: 0, y: 0 };
      const worldX = (mx - state.panX) / state.zoom;
      const worldY = (my - state.panY) / state.zoom;
      return {
        x: Math.floor(worldX / state.mapData.tilewidth),
        y: Math.floor(worldY / state.mapData.tileheight),
      };
    },
    [state.mapData, state.panX, state.panY, state.zoom],
  );

  // === Collision check for character movement ===

  const isBlocked = useCallback(
    (tileX: number, tileY: number): boolean => {
      if (!state.mapData) return false;
      const mapW = state.mapData.width;
      const idx = tileY * mapW + tileX;

      for (const layer of state.mapData.layers) {
        if (layer.type !== 'tilelayer' || !layer.data) continue;
        const name = (layer.name || '').toLowerCase();
        // Check Collision layer only
        if (name === 'collision') {
          if (layer.data[idx] !== 0) return true;
        }
      }
      return false;
    },
    [state.mapData],
  );

  // === Character hit test ===

  const isCharacterHit = useCallback(
    (mx: number, my: number): boolean => {
      if (!state.mapData) return false;
      const worldX = (mx - state.panX) / state.zoom;
      const worldY = (my - state.panY) / state.zoom;
      const tw = state.mapData.tilewidth;
      const th = state.mapData.tileheight;
      const charPxX = characterState.tileX * tw + (tw - CHARACTER_DRAW_SIZE) / 2;
      const charPxY = characterState.tileY * th + (th - CHARACTER_DRAW_SIZE) / 2;
      return (
        worldX >= charPxX &&
        worldX <= charPxX + CHARACTER_DRAW_SIZE &&
        worldY >= charPxY &&
        worldY <= charPxY + CHARACTER_DRAW_SIZE
      );
    },
    [state.mapData, state.panX, state.panY, state.zoom, characterState.tileX, characterState.tileY],
  );

  // === Apply tool (paint/erase) ===

  const applyTool = useCallback(
    (mx: number, my: number) => {
      if (!state.mapData) return;
      const layer = state.mapData.layers[state.activeLayerIndex];
      if (!layer || layer.type !== 'tilelayer' || !layer.data) return;

      const tile = screenToTile(mx, my);
      const mapW = state.mapData.width;
      const mapH = state.mapData.height;

      if (tile.x < 0 || tile.x >= mapW || tile.y < 0 || tile.y >= mapH) return;

      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];

      if (state.tool === 'erase') {
        const idx = tile.y * mapW + tile.x;
        const oldGid = layer.data[idx];
        if (oldGid !== 0) {
          changes.push({ index: idx, oldGid, newGid: 0 });
        }
      } else if (state.tool === 'paint') {
        const region = state.selectedRegion;
        if (region && (region.width > 1 || region.height > 1)) {
          // Stamp region
          for (let ry = 0; ry < region.height; ry++) {
            for (let rx = 0; rx < region.width; rx++) {
              const tx = tile.x + rx;
              const ty = tile.y + ry;
              if (tx >= mapW || ty >= mapH) continue;
              const idx = ty * mapW + tx;
              const oldGid = layer.data[idx];
              const newGid = region.gids[ry][rx];
              if (oldGid !== newGid) {
                changes.push({ index: idx, oldGid, newGid });
              }
            }
          }
        } else {
          // Single tile
          const idx = tile.y * mapW + tile.x;
          const oldGid = layer.data[idx];
          const newGid = state.selectedTileGid;
          if (oldGid !== newGid) {
            changes.push({ index: idx, oldGid, newGid });
          }
        }
      }

      if (changes.length > 0) {
        // Accumulate for undo grouping
        pendingChanges.current.push(...changes);
        // Apply immediately for visual feedback
        dispatch({
          type: 'PAINT_TILE',
          layerIndex: state.activeLayerIndex,
          changes,
        });
      }
    },
    [state.mapData, state.activeLayerIndex, state.tool, state.selectedTileGid, state.selectedRegion, screenToTile, dispatch],
  );

  // === Walk animation helpers ===

  const startWalkAnimation = useCallback(() => {
    if (walkIntervalRef.current) return;
    let frame = 1;
    walkIntervalRef.current = setInterval(() => {
      frame = frame >= 8 ? 1 : frame + 1;
      setCharacterState((prev) => ({ ...prev, frame }));
    }, WALK_INTERVAL_MS);
  }, []);

  const stopWalkAnimation = useCallback(() => {
    if (walkIntervalRef.current) {
      clearInterval(walkIntervalRef.current);
      walkIntervalRef.current = null;
    }
    setCharacterState((prev) => ({ ...prev, frame: 0 }));
  }, []);

  // === Direction auto-detect from movement delta ===

  const directionFromDelta = useCallback((dx: number, dy: number): number => {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx > 0 ? 2 : 1; // right : left
    }
    return dy > 0 ? 0 : 3; // down : up
  }, []);

  // === Mouse handlers ===

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Close context menu on any mouse down
      setContextMenu(null);

      const canvas = canvasRef.current;
      if (!canvas || !state.mapData) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // 1. Pan check
      if (panZoom.handleMouseDown(e, rect)) return;

      // 2. Character hit test
      if (characterSheetRef.current && isCharacterHit(mx, my)) {
        if (e.button === 2) {
          // Right-click: cycle direction
          e.preventDefault();
          setCharacterState((prev) => ({
            ...prev,
            direction: (prev.direction + 1) % 4,
          }));
          return;
        }
        if (e.button === 0) {
          // Left-click: start drag
          isDraggingCharacter.current = true;
          lastDragPos.current = { x: e.clientX, y: e.clientY };
          startWalkAnimation();
          return;
        }
      }

      // Stamp placement mode
      if (activeStamp && e.button === 0) {
        const tile = screenToTile(mx, my);
        onPlaceStamp?.(tile.x, tile.y);
        return;
      }

      // 3. Select tool
      if (state.tool === 'select' && e.button === 0) {
        const tile = screenToTile(mx, my);

        // Paste mode: click to place clipboard content
        if (isPasteMode && state.clipboard) {
          dispatch({ type: 'PASTE_CLIPBOARD', x: tile.x, y: tile.y });
          // Stay in paste mode for multiple pastes; Escape to exit
          return;
        }

        // Check if clicking inside existing selection → start move drag
        if (state.selection) {
          const sel = state.selection;
          if (
            tile.x >= sel.x && tile.x < sel.x + sel.width &&
            tile.y >= sel.y && tile.y < sel.y + sel.height
          ) {
            isMovingSelection.current = true;
            moveOrigin.current = { x: tile.x, y: tile.y };
            moveStartSelection.current = { ...sel };
            return;
          }
        }

        // Click outside selection (or no selection) → start new selection drag
        isSelectDragging.current = true;
        selectStart.current = { x: tile.x, y: tile.y };
        setIsPasteMode(false);
        dispatch({ type: 'CLEAR_SELECTION' });
        dispatch({
          type: 'SET_SELECTION',
          selection: { x: tile.x, y: tile.y, width: 1, height: 1 },
        });
        return;
      }

      // 4. Paint/Erase
      if ((state.tool === 'paint' || state.tool === 'erase') && e.button === 0) {
        isDraggingTile.current = true;
        pendingChanges.current = [];
        pendingLayerIndex.current = state.activeLayerIndex;
        applyTool(mx, my);
      }
    },
    [state.mapData, state.tool, state.activeLayerIndex, state.clipboard, panZoom, isCharacterHit, applyTool, startWalkAnimation, screenToTile, dispatch],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !state.mapData) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // 1. Pan
      if (panZoom.handleMouseMove(e)) return;

      // 2. Character drag (with collision check)
      if (isDraggingCharacter.current) {
        const dx = e.clientX - lastDragPos.current.x;
        const dy = e.clientY - lastDragPos.current.y;

        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          const newDir = directionFromDelta(dx, dy);
          const tile = screenToTile(mx, my);
          const mapW = state.mapData.width;
          const mapH = state.mapData.height;
          const clampedX = Math.max(0, Math.min(mapW - 1, tile.x));
          const clampedY = Math.max(0, Math.min(mapH - 1, tile.y));

          // Check if target tile is blocked (Collision or Walls layer has non-zero GID)
          const blocked = isBlocked(clampedX, clampedY);

          if (!blocked) {
            setCharacterState((prev) => ({
              ...prev,
              tileX: clampedX,
              tileY: clampedY,
              direction: newDir,
            }));
          } else {
            // Still update direction even if blocked
            setCharacterState((prev) => ({
              ...prev,
              direction: newDir,
            }));
          }
          lastDragPos.current = { x: e.clientX, y: e.clientY };
        }
        return;
      }

      // 3a. Move selection drag
      if (isMovingSelection.current && moveOrigin.current && state.selection) {
        const tile = screenToTile(mx, my);
        const dx = tile.x - moveOrigin.current.x;
        const dy = tile.y - moveOrigin.current.y;
        if (dx !== 0 || dy !== 0) {
          // Move the selection rectangle
          dispatch({
            type: 'SET_SELECTION',
            selection: {
              x: state.selection.x + dx,
              y: state.selection.y + dy,
              width: state.selection.width,
              height: state.selection.height,
            },
          });
          moveOrigin.current = { x: tile.x, y: tile.y };
        }
        return;
      }

      // 3b. Select drag (creating new selection)
      if (isSelectDragging.current && selectStart.current) {
        const tile = screenToTile(mx, my);
        const sx = Math.min(selectStart.current.x, tile.x);
        const sy = Math.min(selectStart.current.y, tile.y);
        const ex = Math.max(selectStart.current.x, tile.x);
        const ey = Math.max(selectStart.current.y, tile.y);
        dispatch({
          type: 'SET_SELECTION',
          selection: { x: sx, y: sy, width: ex - sx + 1, height: ey - sy + 1 },
        });
        return;
      }

      // 4. Paint/erase drag
      if (isDraggingTile.current) {
        applyTool(mx, my);
        return;
      }

      // Stamp cursor tracking
      if (activeStamp) {
        const tile = screenToTile(mx, my);
        setStampCursorTile(tile);
      }

      // Paste preview cursor tracking
      if (isPasteMode && state.clipboard) {
        const tile = screenToTile(mx, my);
        setPasteCursorTile(tile);
      }

      // 4. Status bar update
      if (onStatusUpdate) {
        const tile = screenToTile(mx, my);
        const mapW = state.mapData.width;
        const mapH = state.mapData.height;
        if (tile.x >= 0 && tile.x < mapW && tile.y >= 0 && tile.y < mapH) {
          const layer = state.mapData.layers[state.activeLayerIndex];
          const gid =
            layer?.type === 'tilelayer' && layer.data
              ? layer.data[tile.y * mapW + tile.x]
              : 0;
          onStatusUpdate({ tileX: tile.x, tileY: tile.y, gid });
        }
      }
    },
    [state.mapData, state.activeLayerIndex, panZoom, screenToTile, applyTool, directionFromDelta, onStatusUpdate, dispatch, isBlocked],
  );

  const handleMouseUp = useCallback((e?: React.MouseEvent) => {
    // Pan
    panZoom.handleMouseUp();

    // Character drag
    if (isDraggingCharacter.current) {
      isDraggingCharacter.current = false;
      stopWalkAnimation();
    }

    // Move selection finalize — apply tile data move
    if (isMovingSelection.current && moveStartSelection.current && state.selection) {
      const from = moveStartSelection.current;
      const to = state.selection;
      if (from.x !== to.x || from.y !== to.y) {
        dispatch({
          type: 'MOVE_TILES',
          fromX: from.x,
          fromY: from.y,
          toX: to.x,
          toY: to.y,
          width: from.width,
          height: from.height,
        });
      }
      isMovingSelection.current = false;
      moveOrigin.current = null;
      moveStartSelection.current = null;
    } else if (isMovingSelection.current) {
      isMovingSelection.current = false;
      moveOrigin.current = null;
      moveStartSelection.current = null;
    }

    // Select drag finalize → auto show context menu
    if (isSelectDragging.current) {
      isSelectDragging.current = false;
      selectStart.current = null;
      if (e && state.selection && state.selection.width > 0 && state.selection.height > 0) {
        setContextMenu({ x: e.clientX, y: e.clientY });
      }
    }

    // Tile drag -- changes already applied per-stroke via dispatch;
    // pendingChanges tracked for potential grouped-undo if needed
    if (isDraggingTile.current) {
      isDraggingTile.current = false;
      pendingChanges.current = [];
    }
  }, [panZoom, stopWalkAnimation, state.selection, dispatch]);

  // Register wheel handler as non-passive native listener to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      panZoom.handleWheel(e, canvas.getBoundingClientRect());
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [panZoom]);

  const renderSelectionToDataUrl = useCallback((): string | null => {
    if (!state.mapData || !state.selection) return null;
    const sel = state.selection;
    const tw = state.mapData.tilewidth;
    const th = state.mapData.tileheight;
    const pw = sel.width * tw;
    const ph = sel.height * th;

    const offscreen = document.createElement('canvas');
    offscreen.width = pw;
    offscreen.height = ph;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    // Only render active layer's tiles
    const layer = state.mapData.layers[state.activeLayerIndex];
    if (!layer || layer.type !== 'tilelayer' || !layer.data) return null;

    for (let row = 0; row < sel.height; row++) {
      for (let col = 0; col < sel.width; col++) {
        const mapCol = sel.x + col;
        const mapRow = sel.y + row;
        if (mapCol < 0 || mapCol >= state.mapData!.width || mapRow < 0 || mapRow >= state.mapData!.height) continue;

        const gid = layer.data[mapRow * state.mapData!.width + mapCol];
        if (gid === 0) continue;

        const tsInfo = findTileset(gid);
        if (!tsInfo || !tsInfo.img.complete) continue;

        const localId = gid - tsInfo.firstgid;
        const srcCol = localId % tsInfo.columns;
        const srcRow = Math.floor(localId / tsInfo.columns);

        ctx.drawImage(
          tsInfo.img,
          srcCol * tsInfo.tilewidth, srcRow * tsInfo.tileheight,
          tsInfo.tilewidth, tsInfo.tileheight,
          col * tw, row * th, tw, th,
        );
      }
    }

    return offscreen.toDataURL('image/png');
  }, [state.mapData, state.selection, state.activeLayerIndex, findTileset]);

  // Render selection from ALL visible layers (for stamp thumbnail)
  const renderSelectionAllLayers = useCallback((): string | null => {
    if (!state.mapData || !state.selection) return null;
    const sel = state.selection;
    const tw = state.mapData.tilewidth;
    const th = state.mapData.tileheight;
    const offscreen = document.createElement('canvas');
    offscreen.width = sel.width * tw;
    offscreen.height = sel.height * th;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    for (const layer of state.mapData.layers) {
      if (!layer.visible || layer.type !== 'tilelayer' || !layer.data) continue;
      if (layer.name.toLowerCase() === 'collision') continue;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = layer.opacity;
      for (let row = 0; row < sel.height; row++) {
        for (let col = 0; col < sel.width; col++) {
          const mapCol = sel.x + col;
          const mapRow = sel.y + row;
          if (mapCol < 0 || mapCol >= state.mapData!.width || mapRow < 0 || mapRow >= state.mapData!.height) continue;
          const gid = layer.data[mapRow * state.mapData!.width + mapCol];
          if (gid === 0) continue;
          const tsInfo = findTileset(gid);
          if (!tsInfo || !tsInfo.img.complete) continue;
          const localId = gid - tsInfo.firstgid;
          const srcCol = localId % tsInfo.columns;
          const srcRow = Math.floor(localId / tsInfo.columns);
          ctx.drawImage(tsInfo.img, srcCol * tsInfo.tilewidth, srcRow * tsInfo.tileheight, tsInfo.tilewidth, tsInfo.tileheight, col * tw, row * th, tw, th);
        }
      }
      ctx.globalAlpha = prevAlpha;
    }
    return offscreen.toDataURL('image/png');
  }, [state.mapData, state.selection, findTileset]);

  // Close context menu on any keypress
  useEffect(() => {
    if (!contextMenu) return;
    const handleKey = () => setContextMenu(null);
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (state.tool === 'select' && state.selection) {
      setContextMenu({ x: e.clientX, y: e.clientY });
    } else {
      setContextMenu(null);
    }
  }, [state.tool, state.selection]);

  const handleEditSelectionPixels = useCallback(() => {
    if (!state.selection || !state.mapData || !onEditSelectionPixels) return;
    const dataUrl = renderSelectionToDataUrl();
    if (!dataUrl) return;
    const tw = state.mapData.tilewidth;
    const th = state.mapData.tileheight;
    onEditSelectionPixels(dataUrl, state.selection.width, state.selection.height, tw, th);
    setContextMenu(null);
  }, [state.selection, state.mapData, onEditSelectionPixels, renderSelectionToDataUrl]);

  // === Escape key to exit paste mode ===
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isPasteMode) { setIsPasteMode(false); setPasteCursorTile(null); }
        setStampCursorTile(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isPasteMode]);

  // === Load stamp preview image ===
  useEffect(() => {
    if (activeStamp?.thumbnail) {
      const img = new Image();
      img.onload = () => { stampPreviewImgRef.current = img; };
      img.src = activeStamp.thumbnail;
    } else {
      stampPreviewImgRef.current = null;
    }
  }, [activeStamp?.thumbnail]);

  // === Enter paste mode when clipboard is set ===
  useEffect(() => {
    if (state.clipboard && state.tool === 'select') {
      setIsPasteMode(true);
      // Generate paste preview image from clipboard GIDs
      if (state.mapData) {
        const tw = state.mapData.tilewidth;
        const th = state.mapData.tileheight;
        const offscreen = document.createElement('canvas');
        offscreen.width = state.clipboard.width * tw;
        offscreen.height = state.clipboard.height * th;
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          for (let row = 0; row < state.clipboard.height; row++) {
            for (let col = 0; col < state.clipboard.width; col++) {
              const gid = state.clipboard.gids[row]?.[col];
              if (!gid) continue;
              const tsInfo = findTileset(gid);
              if (!tsInfo || !tsInfo.img.complete) continue;
              const localId = gid - tsInfo.firstgid;
              const srcCol = localId % tsInfo.columns;
              const srcRow = Math.floor(localId / tsInfo.columns);
              ctx.drawImage(tsInfo.img, srcCol * tsInfo.tilewidth, srcRow * tsInfo.tileheight, tsInfo.tilewidth, tsInfo.tileheight, col * tw, row * th, tw, th);
            }
          }
          const img = new Image();
          img.onload = () => { pastePreviewImgRef.current = img; };
          img.src = offscreen.toDataURL('image/png');
        }
      }
    } else {
      pastePreviewImgRef.current = null;
    }
  }, [state.clipboard, state.tool, state.mapData, findTileset]);

  // === Cleanup walk interval on unmount ===

  useEffect(() => {
    return () => {
      if (walkIntervalRef.current) {
        clearInterval(walkIntervalRef.current);
      }
    };
  }, []);

  // === Render ===

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      <canvas
        id="map-canvas"
        ref={canvasRef}
        className="block cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        /* wheel handled via native listener (non-passive) in useEffect */
        onContextMenu={handleContextMenu}
      />
      {/* Context Menu */}
      {contextMenu && state.selection && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setContextMenu(null)} />
          <div
            className="fixed z-50 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {/* Edit Pixels */}
            <button
              className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
              onClick={handleEditSelectionPixels}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
              {t('mapEditor.context.editPixels')}
            </button>
            <div className="border-t border-border my-1" />
            {/* Copy */}
            <button
              className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
              onClick={() => { onCopySelection?.(); setContextMenu(null); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
              {t('mapEditor.context.copy')}
            </button>
            {/* Cut */}
            <button
              className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
              onClick={() => { onCopySelection?.(); dispatch({ type: 'DELETE_SELECTION' }); setContextMenu(null); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88" /><path d="M14.47 14.48 20 20" /><path d="M8.12 8.12 12 12" />
              </svg>
              {t('mapEditor.context.cut')}
            </button>
            {/* Delete */}
            <button
              className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
              onClick={() => { dispatch({ type: 'DELETE_SELECTION' }); setIsPasteMode(false); setPasteCursorTile(null); pastePreviewImgRef.current = null; setContextMenu(null); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
              {t('mapEditor.context.delete')}
            </button>
            {/* Move to Layer */}
            {state.mapData && state.mapData.layers.filter(l => l.type === 'tilelayer').length > 1 && (
              <>
                <div className="border-t border-border my-1" />
                <div className="px-3 py-1 text-micro text-text-dim uppercase tracking-wider">{t('mapEditor.context.moveToLayer')}</div>
                {state.mapData.layers.map((layer, idx) => {
                  if (layer.type !== 'tilelayer' || idx === state.activeLayerIndex) return null;
                  return (
                    <button
                      key={idx}
                      className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
                      onClick={() => { dispatch({ type: 'MOVE_SELECTION_TO_LAYER', targetLayerIndex: idx }); setContextMenu(null); }}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 15h18" />
                      </svg>
                      {layer.name}
                    </button>
                  );
                })}
              </>
            )}
            <div className="border-t border-border my-1" />
            {/* Save as Stamp */}
            <button
              className="w-full text-left px-3 py-1.5 text-caption text-text hover:bg-surface-raised transition-colors flex items-center gap-2"
              onClick={() => {
                const dataUrl = renderSelectionAllLayers();
                onSaveAsStamp?.(dataUrl);
                setContextMenu(null);
              }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <path d="M3 9h18" /><path d="M9 21V9" />
              </svg>
              {t('mapEditor.stamps.saveAsStamp')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
