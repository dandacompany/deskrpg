'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import type { EditorState, TileRegion, TilesetImageInfo, EditorAction } from './hooks/useMapEditor';
import { useCanvasRenderer, type CharacterState } from './hooks/useCanvasRenderer';
import { usePanZoom } from './hooks/usePanZoom';
import { compositeCharacter } from '@/lib/sprite-compositor';
import { getDefaultLayers } from '@/hooks/useCharacterAppearance';

// === Props ===

interface MapCanvasProps {
  state: EditorState;
  dispatch: React.Dispatch<EditorAction>;
  findTileset: (gid: number) => TilesetImageInfo | null;
  onStatusUpdate?: (info: { tileX: number; tileY: number; gid: number }) => void;
}

// === Constants ===

const CHARACTER_DRAW_SIZE = 48;
const CHARACTER_FRAME_COUNT = 9; // 0 = idle, 1-8 = walk
const WALK_INTERVAL_MS = 120;

// === Component ===

export function MapCanvas({ state, dispatch, findTileset, onStatusUpdate }: MapCanvasProps) {
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
  const selectStart = useRef<{ x: number; y: number } | null>(null);
  const pendingChanges = useRef<Array<{ index: number; oldGid: number; newGid: number }>>([]);
  const pendingLayerIndex = useRef<number>(0);
  const walkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDragPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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
        render(canvas, characterSheetRef.current ?? undefined, characterState);
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [render, characterState]); // eslint-disable-line react-hooks/exhaustive-deps

  // === Re-render on state changes ===

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    render(canvas, characterSheetRef.current ?? undefined, characterState);
  }, [state, characterState, characterLoaded, render]);

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
        // Check Collision layer and Walls layer
        if (name === 'collision' || name === 'walls') {
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

      // 3. Select tool
      if (state.tool === 'select' && e.button === 0) {
        // If clipboard exists and we click, paste at this location
        if (state.clipboard) {
          const tile = screenToTile(mx, my);
          dispatch({ type: 'PASTE_CLIPBOARD', x: tile.x, y: tile.y });
          return;
        }
        const tile = screenToTile(mx, my);
        isSelectDragging.current = true;
        selectStart.current = { x: tile.x, y: tile.y };
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

      // 3. Select drag
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

  const handleMouseUp = useCallback(() => {
    // Pan
    panZoom.handleMouseUp();

    // Character drag
    if (isDraggingCharacter.current) {
      isDraggingCharacter.current = false;
      stopWalkAnimation();
    }

    // Select drag finalize
    if (isSelectDragging.current) {
      isSelectDragging.current = false;
      selectStart.current = null;
    }

    // Tile drag -- changes already applied per-stroke via dispatch;
    // pendingChanges tracked for potential grouped-undo if needed
    if (isDraggingTile.current) {
      isDraggingTile.current = false;
      pendingChanges.current = [];
    }
  }, [panZoom, stopWalkAnimation]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      panZoom.handleWheel(e, canvas.getBoundingClientRect());
    },
    [panZoom],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

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
        ref={canvasRef}
        className="block cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}
