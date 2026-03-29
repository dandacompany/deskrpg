'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  useMapEditor,
  createDefaultMap,
  generateCollisionTilesetDataUrl,
  isCoreLayer,
} from './hooks/useMapEditor';
import type {
  TiledMap,
  TiledTileset,
  TilesetImageInfo,
  TileRegion,
  TiledLayer,
} from './hooks/useMapEditor';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import Toolbar from './Toolbar';
import LayerPanel from './LayerPanel';
import TilePalette from './TilePalette';
import type { RemoveBgProgress } from './TilePalette';
import { MapCanvas } from './MapCanvas';
import HelpModal from './HelpModal';
import NewMapModal from './NewMapModal';
import ImportTilesetModal from './ImportTilesetModal';
import type { ImportTilesetResult } from './ImportTilesetModal';
import { buildProjectZip, loadProjectZip } from '@/lib/map-project';
import { exportTmx } from '@/lib/tmx-exporter';
import { removeBgToDataUrl } from '@/lib/remove-bg';

// === Props ===

interface MapEditorLayoutProps {
  initialTemplateId?: string | null;
  fromCreate?: boolean;
  characterId?: string | null;
}

// === Helpers ===

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadString(content: string, filename: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  downloadBlob(blob, filename);
}

// === Component ===

export default function MapEditorLayout({
  initialTemplateId,
  fromCreate,
  characterId,
}: MapEditorLayoutProps) {
  const router = useRouter();
  const { state, dispatch, findTileset } = useMapEditor();

  // Modal visibility
  const [showNewMap, setShowNewMap] = useState(false);
  const [showImportTileset, setShowImportTileset] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Pan (space-held) state
  const [spaceHeld, setSpaceHeld] = useState(false);
  const previousToolRef = useRef(state.tool);

  // Resizable panel
  const [panelWidth, setPanelWidth] = useState(300);
  const isResizing = useRef(false);

  // Layer visibility (local -- independent from mapData.layers[].visible which persists)
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  // Status bar
  const [statusInfo, setStatusInfo] = useState<{
    tileX: number;
    tileY: number;
    gid: number;
  } | null>(null);

  // Remove BG progress
  const [removeBgProgress, setRemoveBgProgress] = useState<RemoveBgProgress | null>(null);

  // File input ref
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track initialization
  const initialized = useRef(false);

  // === Initialization ===

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    if (initialTemplateId) {
      // Load template from server
      loadTemplate(initialTemplateId);
    } else {
      // Show new map modal on first load
      setShowNewMap(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplate(templateId: string) {
    try {
      const res = await fetch(`/api/map-templates/${templateId}`);
      if (!res.ok) throw new Error('Failed to load template');
      const data = await res.json();
      const mapData = JSON.parse(data.tiledJson) as TiledMap;

      // Load tileset images from server
      const tilesetImages: Record<number, TilesetImageInfo> = {};
      for (const ts of mapData.tilesets) {
        const imgSrc = ts.image.startsWith('data:')
          ? ts.image
          : `/assets/uploads/${templateId}/${ts.image}`;
        const img = await loadImage(imgSrc);
        tilesetImages[ts.firstgid] = {
          img,
          firstgid: ts.firstgid,
          columns: ts.columns,
          tilewidth: ts.tilewidth,
          tileheight: ts.tileheight,
          tilecount: ts.tilecount,
          name: ts.name,
        };
      }

      // Dispatch with tileset images pre-loaded
      for (const [fgid, info] of Object.entries(tilesetImages)) {
        const ts = mapData.tilesets.find((t) => t.firstgid === Number(fgid));
        if (ts) {
          dispatch({ type: 'ADD_TILESET', tileset: ts, imageInfo: info });
        }
      }

      dispatch({
        type: 'SET_MAP',
        mapData,
        projectName: data.name || 'Loaded Template',
        templateId,
      });
    } catch (err) {
      console.error('Failed to load template:', err);
      setShowNewMap(true);
    }
  }

  // === Layer visibility sync ===

  useEffect(() => {
    if (!state.mapData) return;
    setLayerVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const layer of state.mapData!.layers) {
        next[layer.name] = prev[layer.name] ?? layer.visible;
      }
      return next;
    });
  }, [state.mapData?.layers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // === Dirty state warning ===

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (state.dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [state.dirty]);

  // === Document title ===

  useEffect(() => {
    const suffix = state.dirty ? ' *' : '';
    document.title = `Map Editor - ${state.projectName}${suffix}`;
    return () => {
      document.title = 'DeskRPG';
    };
  }, [state.projectName, state.dirty]);

  // === Confirm if dirty before destructive action ===

  const confirmIfDirty = useCallback(
    (message = 'You have unsaved changes. Continue?') => {
      if (!state.dirty) return true;
      return window.confirm(message);
    },
    [state.dirty],
  );

  // === Image loader util ===

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // === Collision Tileset ===

  const addCollisionTileset = useCallback(
    (mapData: TiledMap) => {
      // Calculate firstgid after all existing tilesets
      let firstgid = 1;
      for (const ts of mapData.tilesets) {
        const end = ts.firstgid + ts.tilecount;
        if (end > firstgid) firstgid = end;
      }

      const dataUrl = generateCollisionTilesetDataUrl(mapData.tilewidth);
      const img = new Image();
      img.src = dataUrl;

      const tileset: TiledTileset = {
        firstgid,
        name: 'collision-tileset',
        tilewidth: mapData.tilewidth,
        tileheight: mapData.tileheight,
        tilecount: 2,
        columns: 2,
        image: dataUrl,
        imagewidth: mapData.tilewidth * 2,
        imageheight: mapData.tileheight,
      };

      const imageInfo: TilesetImageInfo = {
        img,
        firstgid,
        columns: 2,
        tilewidth: mapData.tilewidth,
        tileheight: mapData.tileheight,
        tilecount: 2,
        name: 'collision-tileset',
      };

      dispatch({ type: 'ADD_TILESET', tileset, imageInfo });
    },
    [dispatch],
  );

  // === File Operations ===

  const handleNewMap = useCallback(
    (mapData: TiledMap, projectName: string) => {
      dispatch({ type: 'SET_MAP', mapData, projectName, templateId: null });
      // Add collision tileset after setting map
      addCollisionTileset(mapData);
    },
    [dispatch, addCollisionTileset],
  );

  const handleLoad = useCallback(() => {
    if (!confirmIfDirty()) return;
    fileInputRef.current?.click();
  }, [confirmIfDirty]);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset input so same file can be selected again
      e.target.value = '';

      try {
        if (file.name.endsWith('.zip')) {
          // ZIP project
          const { mapData, tilesetDataUrls, projectName } = await loadProjectZip(file);

          dispatch({ type: 'SET_MAP', mapData, projectName, templateId: null });

          // Load tileset images
          for (const ts of mapData.tilesets) {
            const imgUrl =
              tilesetDataUrls[ts.image] ??
              tilesetDataUrls[ts.image.split('/').pop()!];
            if (!imgUrl) continue;
            const img = await loadImage(imgUrl);
            const imageInfo: TilesetImageInfo = {
              img,
              firstgid: ts.firstgid,
              columns: ts.columns,
              tilewidth: ts.tilewidth,
              tileheight: ts.tileheight,
              tilecount: ts.tilecount,
              name: ts.name,
            };
            dispatch({ type: 'ADD_TILESET', tileset: ts, imageInfo });
          }
        } else {
          // TMJ / JSON
          const text = await file.text();
          const mapData = JSON.parse(text) as TiledMap;
          const projectName = file.name.replace(/\.(tmj|json|tmx)$/i, '');
          dispatch({ type: 'SET_MAP', mapData, projectName, templateId: null });

          // Load tileset images from data URLs embedded in TMJ
          for (const ts of mapData.tilesets) {
            if (ts.image?.startsWith('data:')) {
              const img = await loadImage(ts.image);
              const imageInfo: TilesetImageInfo = {
                img,
                firstgid: ts.firstgid,
                columns: ts.columns,
                tilewidth: ts.tilewidth,
                tileheight: ts.tileheight,
                tilecount: ts.tilecount,
                name: ts.name,
              };
              dispatch({ type: 'ADD_TILESET', tileset: ts, imageInfo });
            }
          }
        }
      } catch (err) {
        console.error('Failed to load file:', err);
        alert('Failed to load file. Make sure it is a valid TMJ or ZIP project.');
      }
    },
    [dispatch],
  );

  const handleSaveToDeskRPG = useCallback(async () => {
    if (!state.mapData) return;

    try {
      const zipBlob = await buildProjectZip(
        state.mapData,
        state.tilesetImages,
        state.projectName,
      );

      const formData = new FormData();
      formData.append('tmjFile', zipBlob, `${state.projectName}.zip`);
      formData.append('name', state.projectName);

      const res = await fetch('/api/map-templates/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      dispatch({ type: 'MARK_CLEAN' });

      if (fromCreate && data.template?.id) {
        const params = new URLSearchParams();
        if (characterId) params.set('characterId', characterId);
        params.set('templateId', data.template.id);
        router.push(`/channels/create?${params.toString()}`);
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert('Failed to save to DeskRPG. Please try again.');
    }
  }, [state.mapData, state.tilesetImages, state.projectName, dispatch, fromCreate, characterId, router]);

  const handleExportTMJ = useCallback(() => {
    if (!state.mapData) return;
    const json = JSON.stringify(state.mapData, null, 2);
    downloadString(json, `${state.projectName}.tmj`);
  }, [state.mapData, state.projectName]);

  const handleExportTMX = useCallback(() => {
    if (!state.mapData) return;
    const xml = exportTmx(state.mapData);
    downloadString(xml, `${state.projectName}.tmx`, 'application/xml');
  }, [state.mapData, state.projectName]);

  // === Layer Operations ===

  const handleAddLayer = useCallback(() => {
    if (!state.mapData) return;
    const name = window.prompt('Layer name:');
    if (!name?.trim()) return;

    const layer: TiledLayer = {
      id: state.mapData.nextlayerid,
      name: name.trim(),
      type: 'tilelayer',
      width: state.mapData.width,
      height: state.mapData.height,
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      data: new Array(state.mapData.width * state.mapData.height).fill(0),
    };
    dispatch({ type: 'ADD_LAYER', layer });
  }, [state.mapData, dispatch]);

  const handleDeleteLayer = useCallback(
    (index?: number) => {
      if (!state.mapData) return;
      const idx = index ?? state.activeLayerIndex;
      const layer = state.mapData.layers[idx];
      if (!layer) return;

      if (isCoreLayer(layer)) {
        alert(`Cannot delete core layer "${layer.name}".`);
        return;
      }

      if (!window.confirm(`Delete layer "${layer.name}"?`)) return;
      dispatch({ type: 'DELETE_LAYER', index: idx });
    },
    [state.mapData, state.activeLayerIndex, dispatch],
  );

  const handleToggleLayerVisibility = useCallback(
    (index: number) => {
      if (!state.mapData) return;
      const layer = state.mapData.layers[index];
      if (!layer) return;
      setLayerVisibility((prev) => ({
        ...prev,
        [layer.name]: !(prev[layer.name] ?? layer.visible),
      }));
    },
    [state.mapData],
  );

  // === Tileset Operations ===

  const handleImportTileset = useCallback(
    (result: ImportTilesetResult) => {
      dispatch({
        type: 'ADD_TILESET',
        tileset: result.tileset,
        imageInfo: result.imageInfo,
      });
    },
    [dispatch],
  );

  const handleDeleteTileset = useCallback(
    (firstgid: number) => {
      if (!state.mapData) return;

      // Check if tiles from this tileset are in use
      const ts = state.mapData.tilesets.find((t) => t.firstgid === firstgid);
      if (!ts) return;
      const maxGid = ts.firstgid + ts.tilecount - 1;

      let inUse = false;
      for (const layer of state.mapData.layers) {
        if (layer.type === 'tilelayer' && layer.data) {
          if (layer.data.some((gid) => gid >= firstgid && gid <= maxGid)) {
            inUse = true;
            break;
          }
        }
      }

      const msg = inUse
        ? `Tileset "${ts.name}" has tiles in use on the map. Delete anyway?`
        : `Delete tileset "${ts.name}"?`;
      if (!window.confirm(msg)) return;
      dispatch({ type: 'DELETE_TILESET', firstgid });
    },
    [state.mapData, dispatch],
  );

  // === Remove Background ===

  const handleRemoveBg = useCallback(
    async (firstgid: number) => {
      const tsInfo = state.tilesetImages[firstgid];
      if (!tsInfo?.img) return;

      setRemoveBgProgress({ firstgid, progress: 0 });

      try {
        const resultDataUrl = await removeBgToDataUrl(tsInfo.img, (p) => {
          setRemoveBgProgress({ firstgid, progress: Math.round(p * 100) });
        });

        const newImg = new Image();
        newImg.onload = () => {
          const newTsInfo: TilesetImageInfo = { ...tsInfo, img: newImg };
          dispatch({ type: 'UPDATE_TILESET_IMAGE', firstgid, imageInfo: newTsInfo, imageDataUrl: resultDataUrl });
          setRemoveBgProgress(null);
        };
        newImg.onerror = () => {
          console.error('Failed to load processed image');
          setRemoveBgProgress(null);
        };
        newImg.src = resultDataUrl;
      } catch (err) {
        console.error('Background removal failed:', err);
        setRemoveBgProgress(null);
      }
    },
    [state.tilesetImages, dispatch],
  );

  // === Sorted tileset list for palette ===

  const sortedTilesets = useMemo(() => {
    return Object.values(state.tilesetImages).sort(
      (a, b) => a.firstgid - b.firstgid,
    );
  }, [state.tilesetImages]);

  // === Space-held pan mode ===

  const handleSpaceDown = useCallback(() => {
    if (!spaceHeld) {
      previousToolRef.current = state.tool;
      dispatch({ type: 'SET_TOOL', tool: 'pan' });
      setSpaceHeld(true);
    }
  }, [spaceHeld, state.tool, dispatch]);

  const handleSpaceUp = useCallback(() => {
    if (spaceHeld) {
      dispatch({ type: 'SET_TOOL', tool: previousToolRef.current });
      setSpaceHeld(false);
    }
  }, [spaceHeld, dispatch]);

  // === Keyboard Shortcuts ===

  useKeyboardShortcuts({
    onToolPaint: () => dispatch({ type: 'SET_TOOL', tool: 'paint' }),
    onToolErase: () => dispatch({ type: 'SET_TOOL', tool: 'erase' }),
    onToggleGrid: () => dispatch({ type: 'TOGGLE_GRID' }),
    onZoomIn: () => dispatch({ type: 'SET_ZOOM', zoom: state.zoom + 0.5 }),
    onZoomOut: () => dispatch({ type: 'SET_ZOOM', zoom: state.zoom - 0.5 }),
    onUndo: () => dispatch({ type: 'UNDO' }),
    onRedo: () => dispatch({ type: 'REDO' }),
    onNewMap: () => {
      if (confirmIfDirty()) setShowNewMap(true);
    },
    onSave: handleSaveToDeskRPG,
    onLoad: handleLoad,
    onImportTileset: () => setShowImportTileset(true),
    onHelp: () => setShowHelp((prev) => !prev),
    onDeleteLayer: () => handleDeleteLayer(),
    onSpaceDown: handleSpaceDown,
    onSpaceUp: handleSpaceUp,
  });

  // === Resize Handle ===

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = ev.clientX - startX;
      setPanelWidth(Math.max(200, Math.min(500, startWidth + delta)));
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth]);

  // === Tile selection handler ===

  const handleSelectRegion = useCallback(
    (region: TileRegion) => {
      const gid = region.gids[0][0];
      dispatch({ type: 'SET_SELECTED_TILE', gid, region });
    },
    [dispatch],
  );

  // === Status bar info ===

  const activeLayerName = state.mapData?.layers[state.activeLayerIndex]?.name ?? '-';
  const toolName = state.tool === 'paint' ? 'Paint' : state.tool === 'erase' ? 'Erase' : 'Pan';

  // === Render ===

  return (
    <div
      className="h-screen w-screen flex flex-col bg-surface-base text-text overflow-hidden"
    >
      {/* Toolbar */}
      <Toolbar
        activeTool={state.tool}
        zoom={state.zoom}
        showGrid={state.showGrid}
        showCollision={state.showCollision}
        canUndo={state.undoStack.length > 0}
        canRedo={state.redoStack.length > 0}
        dirty={state.dirty}
        onToolChange={(tool) => dispatch({ type: 'SET_TOOL', tool })}
        onNewMap={() => {
          if (confirmIfDirty()) setShowNewMap(true);
        }}
        onLoad={handleLoad}
        onSaveToDeskRPG={handleSaveToDeskRPG}
        onExportTMJ={handleExportTMJ}
        onExportTMX={handleExportTMX}
        onZoomIn={() => dispatch({ type: 'SET_ZOOM', zoom: state.zoom + 0.5 })}
        onZoomOut={() => dispatch({ type: 'SET_ZOOM', zoom: state.zoom - 0.5 })}
        onToggleGrid={() => dispatch({ type: 'TOGGLE_GRID' })}
        onToggleCollision={() => dispatch({ type: 'TOGGLE_COLLISION' })}
        onUndo={() => dispatch({ type: 'UNDO' })}
        onRedo={() => dispatch({ type: 'REDO' })}
        onHelp={() => setShowHelp(true)}
      />

      {/* Main area: panel + canvas */}
      <div className="flex-1 flex min-h-0">
        {/* Left Panel */}
        <div
          className="flex flex-col bg-surface border-r border-border flex-shrink-0"
          style={{ width: panelWidth }}
        >
          {/* Layer Panel */}
          <div className="max-h-[280px] overflow-hidden border-b border-border">
            {state.mapData && (
              <LayerPanel
                layers={state.mapData.layers}
                activeLayerIndex={state.activeLayerIndex}
                onSelectLayer={(index) => dispatch({ type: 'SET_ACTIVE_LAYER', index })}
                onRenameLayer={(index, name) => dispatch({ type: 'RENAME_LAYER', index, name })}
                onDeleteLayer={(index) => handleDeleteLayer(index)}
                onReorderLayers={(from, to) =>
                  dispatch({ type: 'REORDER_LAYERS', fromIndex: from, toIndex: to })
                }
                onAddLayer={handleAddLayer}
                onToggleVisibility={handleToggleLayerVisibility}
              />
            )}
          </div>

          {/* Tile Palette */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <TilePalette
              tilesets={sortedTilesets}
              selectedRegion={state.selectedRegion}
              onSelectRegion={handleSelectRegion}
              onImportTileset={() => setShowImportTileset(true)}
              onDeleteTileset={handleDeleteTileset}
              onRemoveBg={handleRemoveBg}
              removeBgProgress={removeBgProgress}
            />
          </div>
        </div>

        {/* Resize Handle */}
        <div
          className="w-1 cursor-col-resize bg-border hover:bg-primary-light/50 transition-colors flex-shrink-0"
          onMouseDown={handleResizeMouseDown}
        />

        {/* Canvas Area */}
        <div className="flex-1 min-w-0 min-h-0">
          {state.mapData ? (
            <MapCanvas
              state={state}
              dispatch={dispatch}
              findTileset={findTileset}
              onStatusUpdate={setStatusInfo}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-dim text-body">
              Create or load a map to get started.
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="h-6 flex items-center gap-4 px-3 bg-surface border-t border-border text-micro text-text-dim select-none flex-shrink-0">
        {statusInfo && (
          <span>
            Tile: ({statusInfo.tileX}, {statusInfo.tileY})
          </span>
        )}
        <span>Layer: {activeLayerName}</span>
        <span>Tool: {toolName}</span>
        {statusInfo && statusInfo.gid > 0 && <span>GID: {statusInfo.gid}</span>}
        <span className="ml-auto">
          {state.mapData
            ? `${state.mapData.width}x${state.mapData.height} (${state.mapData.tilewidth}px)`
            : 'No map'}
        </span>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".tmj,.tmx,.json,.zip"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Modals */}
      <NewMapModal
        open={showNewMap}
        onClose={() => setShowNewMap(false)}
        onSubmit={handleNewMap}
      />

      <ImportTilesetModal
        open={showImportTileset}
        onClose={() => setShowImportTileset(false)}
        existingTilesets={state.mapData?.tilesets ?? []}
        onImport={handleImportTileset}
      />

      <HelpModal
        open={showHelp}
        onClose={() => setShowHelp(false)}
      />
    </div>
  );
}
