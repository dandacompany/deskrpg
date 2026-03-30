'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  useMapEditor,
  createDefaultMap,
  generateBuiltinTilesetDataUrl,
  getBuiltinTilesetInfo,
  BUILTIN_TILESET_NAME,
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
import { Plus, Stamp } from 'lucide-react';
import { useT } from '@/lib/i18n';
import Tooltip from './Tooltip';
import Toolbar from './Toolbar';
import LayerPanel from './LayerPanel';
import TilePalette from './TilePalette';
import Minimap from './Minimap';
import { MapCanvas } from './MapCanvas';
import HelpModal from './HelpModal';
import ImportTilesetModal from './ImportTilesetModal';
import PixelEditorModal from './PixelEditorModal';
import type { ImportTilesetResult } from './ImportTilesetModal';
import { exportTmx } from '@/lib/tmx-exporter';
import ProjectBrowser from './ProjectBrowser';
import { useProjectManager } from './hooks/useProjectManager';
import StampPanel from './StampPanel';
import SaveStampModal from './SaveStampModal';
import StampEditorModal from './StampEditorModal';
import type { StampListItem, StampData } from '@/lib/stamp-utils';
import { buildPixelMatchRemap, findLayerByName } from '@/lib/stamp-utils';


// === Props ===

interface MapEditorLayoutProps {
  projectId?: string;
  ownerId?: string;
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
  projectId: initialProjectId,
  ownerId,
  initialTemplateId,
  fromCreate,
  characterId,
}: MapEditorLayoutProps) {
  const router = useRouter();
  const t = useT();
  const { state, dispatch, findTileset } = useMapEditor();

  // useProjectManager needs addBuiltinTileset which is defined below;
  // use a ref to avoid stale closure issues.
  const addBuiltinTilesetRef = useRef<(mapData: TiledMap) => void>(() => {});
  const { loadProject, saveProject, createProject, linkTileset, linkStamp } = useProjectManager({
    dispatch,
    addBuiltinTileset: (mapData) => addBuiltinTilesetRef.current(mapData),
  });

  const [projectLoaded, setProjectLoaded] = useState(false);

  // Modal visibility
  const [showImportTileset, setShowImportTileset] = useState(false);
  const [droppedTilesetFile, setDroppedTilesetFile] = useState<File | null>(null);
  const [isDroppingTileset, setIsDroppingTileset] = useState(false);
  const [layerOverlayMap, setLayerOverlayMap] = useState<Record<number, boolean>>({});
  const [showHelp, setShowHelp] = useState(false);
  const [showPixelEditor, setShowPixelEditor] = useState(false);
  const [selectionPixelData, setSelectionPixelData] = useState<{
    dataUrl: string;
    cols: number;
    rows: number;
    tileWidth: number;
    tileHeight: number;
  } | null>(null);
  const [stamps, setStamps] = useState<StampListItem[]>([]);
  const [activeStamp, setActiveStamp] = useState<StampData | null>(null);
  const [showSaveStamp, setShowSaveStamp] = useState(false);
  const [savingStamp, setSavingStamp] = useState(false);
  const [editingStamp, setEditingStamp] = useState<StampData | null>(null);
  const [showStampEditor, setShowStampEditor] = useState(false);
  const pixelEditorStampCallbackRef = useRef<((dataUrl: string, newCols: number, newRows: number) => void) | null>(null);

  // Pan (space-held) state
  const [spaceHeld, setSpaceHeld] = useState(false);
  const previousToolRef = useRef(state.tool);

  // Resizable panel
  const [panelWidth, setPanelWidth] = useState(300);

  // Left panel section order & collapsed state
  const DEFAULT_SECTION_ORDER = ['layers', 'tilesets', 'stamps', 'minimap'];
  const [sectionOrder, setSectionOrder] = useState<string[]>(DEFAULT_SECTION_ORDER);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  // Hydration-safe: load from localStorage after mount
  useEffect(() => {
    try {
      const v = localStorage.getItem('mapEditor.sectionOrder');
      if (v) {
        const parsed = JSON.parse(v) as string[];
        if (!parsed.includes('stamps')) {
          const idx = parsed.indexOf('tilesets');
          parsed.splice(idx >= 0 ? idx + 1 : parsed.length, 0, 'stamps');
        }
        setSectionOrder(parsed);
      }
    } catch { /* ignore */ }
    try {
      const v = localStorage.getItem('mapEditor.collapsedSections');
      if (v) setCollapsedSections(JSON.parse(v));
    } catch { /* ignore */ }
    try {
      const v = localStorage.getItem('mapEditor.sectionVisibility');
      if (v) {
        const parsed = JSON.parse(v) as Record<string, boolean>;
        if (parsed.stamps === undefined) parsed.stamps = true;
        setSectionVisibility(parsed);
      }
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sectionVisibility, setSectionVisibility] = useState<Record<string, boolean>>({ layers: true, tilesets: true, stamps: true, minimap: true });
  // Persist view settings to localStorage
  useEffect(() => { localStorage.setItem('mapEditor.sectionOrder', JSON.stringify(sectionOrder)); }, [sectionOrder]);
  useEffect(() => { localStorage.setItem('mapEditor.collapsedSections', JSON.stringify(collapsedSections)); }, [collapsedSections]);
  useEffect(() => { localStorage.setItem('mapEditor.sectionVisibility', JSON.stringify(sectionVisibility)); }, [sectionVisibility]);

  const dragSectionRef = useRef<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  // Layer visibility (local -- independent from mapData.layers[].visible which persists)
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  // Status bar
  const [statusInfo, setStatusInfo] = useState<{
    tileX: number;
    tileY: number;
    gid: number;
  } | null>(null);



  // File input refs
  const tilesetFileInputRef = useRef<HTMLInputElement>(null);

  // Track initialization
  const initialized = useRef(false);

  // === Initialization ===

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    if (initialProjectId) {
      loadProject(initialProjectId).then((data) => {
        if (data) {
          setStamps(data.stamps.map(s => ({
            id: s.id,
            name: s.name,
            cols: s.cols,
            rows: s.rows,
            thumbnail: s.thumbnail ?? null,
            layerNames: s.layerNames,
          })));
          setProjectLoaded(true);
        }
      });
    }
  }, []);

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

  // === Built-in Color Palette Tileset ===

  const addBuiltinTileset = useCallback(
    (mapData: TiledMap) => {
      let firstgid = 1;
      for (const ts of mapData.tilesets) {
        const end = ts.firstgid + ts.tilecount;
        if (end > firstgid) firstgid = end;
      }

      const dataUrl = generateBuiltinTilesetDataUrl(mapData.tilewidth);
      const info = getBuiltinTilesetInfo(mapData.tilewidth);
      const img = new Image();
      img.src = dataUrl;

      const tileset: TiledTileset = {
        firstgid,
        name: BUILTIN_TILESET_NAME,
        tilewidth: mapData.tilewidth,
        tileheight: mapData.tileheight,
        tilecount: info.tilecount,
        columns: info.columns,
        image: dataUrl,
        imagewidth: info.imagewidth,
        imageheight: info.imageheight,
      };

      const imageInfo: TilesetImageInfo = {
        img,
        firstgid,
        columns: info.columns,
        tilewidth: mapData.tilewidth,
        tileheight: mapData.tileheight,
        tilecount: info.tilecount,
        name: BUILTIN_TILESET_NAME,
      };

      dispatch({ type: 'ADD_TILESET', tileset, imageInfo });
    },
    [dispatch],
  );
  addBuiltinTilesetRef.current = addBuiltinTileset;

  // === File Operations ===

  const handleSave = useCallback(async () => {
    if (!state.mapData || !state.projectId) return;
    try {
      // Sync tilesets to DB: save images and link to project
      for (const ts of state.mapData.tilesets) {
        const imgInfo = state.tilesetImages[ts.firstgid];
        if (!imgInfo) continue;

        // Get image as base64
        let imageDataUrl = ts.image;
        if (!imageDataUrl.startsWith('data:') && imgInfo.img) {
          const canvas = document.createElement('canvas');
          canvas.width = imgInfo.img.naturalWidth || imgInfo.img.width;
          canvas.height = imgInfo.img.naturalHeight || imgInfo.img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(imgInfo.img, 0, 0);
          imageDataUrl = canvas.toDataURL('image/png');
        }

        // Upsert tileset to DB
        try {
          const saveRes = await fetch('/api/tilesets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: ts.name,
              tilewidth: ts.tilewidth,
              tileheight: ts.tileheight,
              columns: ts.columns,
              tilecount: ts.tilecount,
              image: imageDataUrl,
            }),
          });
          if (saveRes.ok) {
            const saved = await saveRes.json();
            const tilesetDbId = saved.id ?? saved.id;
            // Link to project (ignore duplicate errors)
            await fetch(`/api/projects/${state.projectId}/tilesets`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tilesetId: tilesetDbId, firstgid: ts.firstgid }),
            }).catch(() => {});
          }
        } catch {}
      }

      const canvasEl = document.querySelector<HTMLCanvasElement>('#map-canvas');
      const thumbnail = canvasEl ? canvasEl.toDataURL('image/png', 0.5) : null;
      await saveProject(state.projectId, state.mapData, thumbnail);
    } catch (err) {
      console.error('Save failed:', err);
      alert('Failed to save. Please try again.');
    }
  }, [state.mapData, state.projectId, state.tilesetImages, saveProject]);

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

  const handleExportPNG = useCallback(() => {
    if (!state.mapData) return;
    const mapData = state.mapData;
    const tw = mapData.tilewidth;
    const th = mapData.tileheight;
    const canvas = document.createElement('canvas');
    canvas.width = mapData.width * tw;
    canvas.height = mapData.height * th;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    for (const layer of mapData.layers) {
      if (layer.type !== 'tilelayer' || !layer.data || !layer.visible) continue;
      if (layer.name.toLowerCase() === 'collision') continue;
      for (let y = 0; y < mapData.height; y++) {
        for (let x = 0; x < mapData.width; x++) {
          const gid = layer.data[y * mapData.width + x];
          if (gid === 0) continue;
          const tsInfo = findTileset(gid);
          if (!tsInfo) continue;
          const localId = gid - tsInfo.firstgid;
          const sx = (localId % tsInfo.columns) * tsInfo.tilewidth;
          const sy = Math.floor(localId / tsInfo.columns) * tsInfo.tileheight;
          ctx.drawImage(tsInfo.img, sx, sy, tsInfo.tilewidth, tsInfo.tileheight, x * tw, y * th, tw, th);
        }
      }
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `${state.projectName}.png`);
    }, 'image/png');
  }, [state.mapData, state.projectName, findTileset]);

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
      dispatch({ type: 'TOGGLE_LAYER_VISIBILITY', index });
    },
    [dispatch],
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

  const handleQuickImportTileset = useCallback(() => {
    tilesetFileInputRef.current?.click();
  }, []);

  const handleTilesetFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !state.mapData) return;
      e.target.value = '';

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const tw = state.mapData!.tilewidth;
          const th = state.mapData!.tileheight;
          const columns = Math.max(1, Math.floor(img.naturalWidth / tw));
          const rows = Math.max(1, Math.floor(img.naturalHeight / th));
          const tilecount = columns * rows;
          const name = file.name.replace(/\.[^.]+$/, '');

          let firstgid = 1;
          for (const ts of state.mapData!.tilesets) {
            const end = ts.firstgid + ts.tilecount;
            if (end > firstgid) firstgid = end;
          }

          const tileset: TiledTileset = {
            firstgid,
            name,
            tilewidth: tw,
            tileheight: th,
            tilecount,
            columns,
            image: dataUrl,
            imagewidth: img.naturalWidth,
            imageheight: img.naturalHeight,
          };

          const imageInfo: TilesetImageInfo = {
            img,
            firstgid,
            columns,
            tilewidth: tw,
            tileheight: th,
            tilecount,
            name,
          };

          dispatch({ type: 'ADD_TILESET', tileset, imageInfo });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [state.mapData, dispatch],
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

  // === Pixel Editor ===

  const handleEditSelectionPixels = useCallback(
    (dataUrl: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => {
      // Capture selection position before it might get cleared
      stampSelectionRef.current = state.selection ? { ...state.selection } : null;
      setSelectionPixelData({ dataUrl, cols, rows, tileWidth, tileHeight });
      setShowPixelEditor(true);
    },
    [state.selection],
  );

  const handleEditPixels = useCallback(
    (firstgid: number, region: TileRegion) => {
      if (!state.tilesetImages[firstgid]) return;
      setSelectionPixelData(null);
      setShowPixelEditor(true);
    },
    [state.tilesetImages],
  );

  const handlePixelSaveAsNew = useCallback(
    async (dataUrl: string, name: string, columns: number, tileWidth: number, tileHeight: number, tileCount: number) => {
      if (!state.mapData) return;

      let newFirstgid = 1;
      for (const ts of state.mapData.tilesets) {
        const end = ts.firstgid + ts.tilecount;
        if (end > newFirstgid) newFirstgid = end;
      }

      const newTileset: TiledTileset = {
        firstgid: newFirstgid,
        name,
        tilewidth: tileWidth,
        tileheight: tileHeight,
        tilecount: tileCount,
        columns,
        image: dataUrl,
        imagewidth: columns * tileWidth,
        imageheight: Math.ceil(tileCount / columns) * tileHeight,
      };

      const newImg = await loadImage(dataUrl);
      const newImageInfo: TilesetImageInfo = {
        img: newImg,
        firstgid: newFirstgid,
        columns,
        tilewidth: tileWidth,
        tileheight: tileHeight,
        tilecount: tileCount,
        name,
      };

      dispatch({ type: 'ADD_TILESET', tileset: newTileset, imageInfo: newImageInfo });
    },
    [state.mapData, dispatch],
  );

  const handlePixelOverwrite = useCallback(
    async (firstgid: number, dataUrl: string, newCols: number, newRows: number, origCols: number, origRows: number) => {
      if (!state.mapData) return;

      if (firstgid === 0) {
        // Direct image mode: edited pixels from map selection area
        // Each tile in the edited image corresponds to a map tile at (sel.x+c, sel.y+r)
        // We update each tile's image in its source tileset
        const sel = stampSelectionRef.current ?? state.selection;
        if (!sel) return;

        const tw = state.mapData.tilewidth;
        const th = state.mapData.tileheight;
        const mapW = state.mapData.width;
        const editedImg = await loadImage(dataUrl);

        // Collect which tilesets need updating: { firstgid -> { tsInfo, canvas (mutable copy) } }
        const tilesetCanvases = new Map<number, { tsInfo: TilesetImageInfo; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();

        const getOrCreateCanvas = (fgid: number) => {
          if (tilesetCanvases.has(fgid)) return tilesetCanvases.get(fgid)!;
          const tsInfo = state.tilesetImages[fgid];
          if (!tsInfo) return null;
          const canvas = document.createElement('canvas');
          canvas.width = tsInfo.img.naturalWidth || tsInfo.img.width;
          canvas.height = tsInfo.img.naturalHeight || tsInfo.img.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(tsInfo.img, 0, 0);
          const entry = { tsInfo, canvas, ctx };
          tilesetCanvases.set(fgid, entry);
          return entry;
        };

        // For each tile in the edited region, find its GID on the active layer,
        // locate it in the tileset, and overwrite that tile's pixels
        const activeLayer = state.mapData.layers[state.activeLayerIndex];
        if (!activeLayer?.data) return;

        const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];

        for (let r = 0; r < Math.max(newRows, origRows); r++) {
          for (let c = 0; c < Math.max(newCols, origCols); c++) {
            const mapX = sel.x + c;
            const mapY = sel.y + r;
            if (mapX < 0 || mapX >= mapW || mapY < 0 || mapY >= state.mapData.height) continue;
            const mapIdx = mapY * mapW + mapX;

            if (r >= newRows || c >= newCols) {
              // Tile was deleted in pixel editor → clear on map
              if (activeLayer.data[mapIdx] !== 0) {
                changes.push({ index: mapIdx, oldGid: activeLayer.data[mapIdx], newGid: 0 });
              }
              continue;
            }

            const gid = activeLayer.data[mapIdx];
            if (gid === 0) continue; // empty tile, skip

            // Find which tileset this GID belongs to
            let tsFgid = 0;
            for (const ts of state.mapData.tilesets) {
              if (gid >= ts.firstgid && gid < ts.firstgid + ts.tilecount) {
                tsFgid = ts.firstgid;
                break;
              }
            }
            if (tsFgid === 0) continue;

            const entry = getOrCreateCanvas(tsFgid);
            if (!entry) continue;

            // Calculate tile position within the tileset image
            const localId = gid - tsFgid;
            const tsCol = localId % entry.tsInfo.columns;
            const tsRow = Math.floor(localId / entry.tsInfo.columns);

            // Copy the edited tile pixel data into the tileset canvas
            entry.ctx.clearRect(tsCol * tw, tsRow * th, tw, th);
            entry.ctx.drawImage(
              editedImg,
              c * tw, r * th, tw, th,  // source rect from edited image
              tsCol * tw, tsRow * th, tw, th,  // dest rect in tileset
            );
          }
        }

        // Apply GID changes (deleted tiles)
        if (changes.length > 0) {
          dispatch({ type: 'PAINT_TILE', layerIndex: state.activeLayerIndex, changes });
        }

        // Update all modified tileset images
        for (const [fgid, entry] of tilesetCanvases) {
          const fullDataUrl = entry.canvas.toDataURL('image/png');
          const newImg = await loadImage(fullDataUrl);
          dispatch({
            type: 'UPDATE_TILESET_IMAGE',
            firstgid: fgid,
            imageInfo: { ...entry.tsInfo, img: newImg },
            imageDataUrl: fullDataUrl,
          });
        }
        return;
      }

      // Normal tileset region overwrite
      const tsInfo = state.tilesetImages[firstgid];
      if (!tsInfo) return;

      const region = state.selectedRegion;
      if (!region) return;

      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = tsInfo.img.naturalWidth;
      fullCanvas.height = tsInfo.img.naturalHeight;
      const ctx = fullCanvas.getContext('2d')!;
      ctx.drawImage(tsInfo.img, 0, 0);

      const editedImg = await loadImage(dataUrl);
      ctx.clearRect(
        region.col * tsInfo.tilewidth,
        region.row * tsInfo.tileheight,
        origCols * tsInfo.tilewidth,
        origRows * tsInfo.tileheight,
      );
      ctx.drawImage(
        editedImg,
        region.col * tsInfo.tilewidth,
        region.row * tsInfo.tileheight,
      );

      const fullDataUrl = fullCanvas.toDataURL('image/png');
      const newImg = await loadImage(fullDataUrl);

      dispatch({
        type: 'UPDATE_TILESET_IMAGE',
        firstgid,
        imageInfo: { ...tsInfo, img: newImg },
        imageDataUrl: fullDataUrl,
      });
    },
    [state.tilesetImages, state.selectedRegion, state.selection, state.mapData, state.activeLayerIndex, dispatch],
  );

  // === Reorder Tilesets ===

  const handleReorderTileset = useCallback(
    (fromFirstgid: number, toFirstgid: number) => {
      dispatch({ type: 'REORDER_TILESETS', fromFirstgid, toFirstgid });
    },
    [dispatch],
  );

  // === Used GIDs (for detecting unused tilesets) ===

  const usedGids = useMemo(() => {
    const gids = new Set<number>();
    if (!state.mapData) return gids;
    for (const layer of state.mapData.layers) {
      if (layer.type === 'tilelayer' && layer.data) {
        for (const gid of layer.data) {
          if (gid > 0) gids.add(gid);
        }
      }
    }
    return gids;
  }, [state.mapData]);

  // === Clean Up Unused Tilesets ===

  const handleCleanUpUnused = useCallback(() => {
    if (!state.mapData) return;
    const unusedFirstgids: number[] = [];
    for (const ts of state.mapData.tilesets) {
      if (ts.name === BUILTIN_TILESET_NAME) continue;
      const maxGid = ts.firstgid + ts.tilecount - 1;
      let isUsed = false;
      for (let gid = ts.firstgid; gid <= maxGid; gid++) {
        if (usedGids.has(gid)) {
          isUsed = true;
          break;
        }
      }
      if (!isUsed) unusedFirstgids.push(ts.firstgid);
    }
    if (unusedFirstgids.length === 0) return;
    const names = unusedFirstgids
      .map((fgid) => state.mapData!.tilesets.find((t) => t.firstgid === fgid)?.name ?? `firstgid=${fgid}`)
      .join(', ');
    if (!window.confirm(`Remove ${unusedFirstgids.length} unused tileset(s)?\n${names}`)) return;
    dispatch({ type: 'REMOVE_UNUSED_TILESETS', firstgids: unusedFirstgids });
  }, [state.mapData, usedGids, dispatch]);

  // === Sorted tileset list for palette ===

  const sortedTilesets = useMemo(() => {
    if (!state.mapData) {
      return Object.values(state.tilesetImages).sort(
        (a, b) => a.firstgid - b.firstgid,
      );
    }
    // Follow mapData.tilesets order (supports drag reorder)
    return state.mapData.tilesets
      .map((ts) => state.tilesetImages[ts.firstgid])
      .filter(Boolean);
  }, [state.tilesetImages, state.mapData]);

  // === Selection Operations ===

  const handleCopy = useCallback(() => {
    if (!state.mapData || !state.selection) return;
    const layer = state.mapData.layers[state.activeLayerIndex];
    if (!layer || layer.type !== 'tilelayer' || !layer.data) return;
    const sel = state.selection;
    const mapW = state.mapData.width;
    const gids: number[][] = [];
    for (let dy = 0; dy < sel.height; dy++) {
      const row: number[] = [];
      for (let dx = 0; dx < sel.width; dx++) {
        const tx = sel.x + dx;
        const ty = sel.y + dy;
        if (tx >= 0 && tx < mapW && ty >= 0 && ty < state.mapData.height) {
          row.push(layer.data[ty * mapW + tx]);
        } else {
          row.push(0);
        }
      }
      gids.push(row);
    }
    dispatch({
      type: 'SET_CLIPBOARD',
      clipboard: { width: sel.width, height: sel.height, gids, layerIndex: state.activeLayerIndex },
    });
  }, [state.mapData, state.selection, state.activeLayerIndex, dispatch]);

  const handlePaste = useCallback(() => {
    if (!state.clipboard) return;
    // Switch to select tool; the next click on canvas will place the clipboard
    dispatch({ type: 'SET_TOOL', tool: 'select' });
  }, [state.clipboard, dispatch]);

  const handleCut = useCallback(() => {
    handleCopy();
    dispatch({ type: 'DELETE_SELECTION' });
  }, [handleCopy, dispatch]);

  const handleDeleteSelection = useCallback(() => {
    if (!state.selection) return;
    dispatch({ type: 'DELETE_SELECTION' });
  }, [state.selection, dispatch]);

  const handleClearSelection = useCallback(() => {
    dispatch({ type: 'CLEAR_SELECTION' });
  }, [dispatch]);

  const fetchStamps = useCallback(async () => {
    if (!state.projectId) return;
    try {
      const res = await fetch(`/api/projects/${state.projectId}`);
      if (res.ok) {
        const data = await res.json();
        setStamps((data.stamps ?? []).map((s: any) => ({
          id: s.id,
          name: s.name,
          cols: s.cols,
          rows: s.rows,
          thumbnail: s.thumbnail ?? null,
          layerNames: s.layerNames ?? [],
        })));
      }
    } catch { /* ignore */ }
  }, [state.projectId]);

  // Create stamp from tileset palette selection
  const handleCreateStampFromTileset = useCallback(async () => {
    const region = state.selectedRegion;
    if (!region || !state.mapData) return;
    const tsInfo = state.tilesetImages[region.firstgid];
    if (!tsInfo) return;

    const tw = tsInfo.tilewidth;
    const th = tsInfo.tileheight;
    const cols = region.width;
    const rows = region.height;

    // Render the selected tiles to a canvas for thumbnail
    const canvas = document.createElement('canvas');
    canvas.width = cols * tw;
    canvas.height = rows * th;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Build GID data and draw tiles
    const data: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const localId = (region.row + r) * tsInfo.columns + (region.col + c);
        const gid = region.firstgid + localId;
        data.push(gid);
        // Draw tile
        const srcX = (localId % tsInfo.columns) * tw;
        const srcY = Math.floor(localId / tsInfo.columns) * th;
        ctx.drawImage(tsInfo.img, srcX, srcY, tw, th, c * tw, r * th, tw, th);
      }
    }

    const thumbnail = canvas.toDataURL('image/png');

    // Build tileset image for stamp
    const tsCanvas = document.createElement('canvas');
    tsCanvas.width = tsInfo.img.naturalWidth || tsInfo.img.width;
    tsCanvas.height = tsInfo.img.naturalHeight || tsInfo.img.height;
    tsCanvas.getContext('2d')!.drawImage(tsInfo.img, 0, 0);
    const tsImage = tsCanvas.toDataURL('image/png');

    const stampLayer = { name: 'Floor', type: 'tilelayer', depth: 0, data };
    const stampTileset = {
      name: tsInfo.name, firstgid: region.firstgid,
      tilewidth: tw, tileheight: th,
      columns: tsInfo.columns, tilecount: tsInfo.tilecount, image: tsImage,
    };

    const name = `Stamp ${cols}x${rows}`;
    const body = {
      name, cols, rows, tileWidth: tw, tileHeight: th,
      layers: [stampLayer], tilesets: [stampTileset], thumbnail,
    };

    try {
      const res = await fetch('/api/stamps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const created = await res.json();
        if (state.projectId && created.id) {
          await linkStamp(state.projectId, created.id);
        }
        await fetchStamps();
      }
    } catch { /* ignore */ }
  }, [state.selectedRegion, state.tilesetImages, state.mapData, state.projectId, linkStamp, fetchStamps]);

  // === Stamp Functions ===

  const stampThumbnailRef = useRef<string | null>(null);
  const stampSelectionRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const handleSaveStamp = useCallback(async (name: string) => {
    const sel = stampSelectionRef.current ?? state.selection;
    if (!state.mapData || !sel) return;
    setSavingStamp(true);
    try {
      const tw = state.mapData.tilewidth;
      const th = state.mapData.tileheight;
      const mapW = state.mapData.width;

      const stampLayers: Array<{ name: string; type: string; depth: number; data: number[] }> = [];
      const usedGids = new Set<number>();

      for (const layer of state.mapData.layers) {
        if (layer.type !== 'tilelayer' || !layer.data) continue;
        if (layer.name.toLowerCase() === 'collision') continue;

        const data: number[] = [];
        const depthProp = layer.properties?.find((p: any) => p.name === 'depth');
        const depthVal = depthProp ? Number(depthProp.value) || 0 : 0;

        for (let row = 0; row < sel.height; row++) {
          for (let col = 0; col < sel.width; col++) {
            const mapCol = sel.x + col;
            const mapRow = sel.y + row;
            const gid = (mapCol >= 0 && mapCol < mapW && mapRow >= 0 && mapRow < state.mapData!.height)
              ? layer.data[mapRow * mapW + mapCol]
              : 0;
            data.push(gid);
            if (gid !== 0) usedGids.add(gid);
          }
        }

        if (data.some((g) => g !== 0)) {
          stampLayers.push({ name: layer.name, type: layer.type, depth: depthVal, data });
        }
      }

      if (stampLayers.length === 0) { setSavingStamp(false); setShowSaveStamp(false); return; }

      const stampTilesets: Array<{ name: string; firstgid: number; tilewidth: number; tileheight: number; columns: number; tilecount: number; image: string }> = [];
      for (const ts of state.mapData.tilesets) {
        const maxGid = ts.firstgid + ts.tilecount - 1;
        let used = false;
        for (const gid of usedGids) {
          if (gid >= ts.firstgid && gid <= maxGid) { used = true; break; }
        }
        if (!used) continue;

        const imgInfo = state.tilesetImages[ts.firstgid];
        if (!imgInfo) continue;

        const canvas = document.createElement('canvas');
        canvas.width = imgInfo.img.naturalWidth || imgInfo.img.width;
        canvas.height = imgInfo.img.naturalHeight || imgInfo.img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(imgInfo.img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');

        stampTilesets.push({
          name: ts.name, firstgid: ts.firstgid, tilewidth: ts.tilewidth,
          tileheight: ts.tileheight, columns: ts.columns, tilecount: ts.tilecount, image: dataUrl,
        });
      }

      const thumbnail = stampThumbnailRef.current;

      const body = {
        name, cols: sel.width, rows: sel.height,
        tileWidth: tw, tileHeight: th,
        layers: stampLayers, tilesets: stampTilesets, thumbnail,
      };

      const res = await fetch('/api/stamps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const created = await res.json();
        // Link to project
        if (state.projectId && created.id) {
          await linkStamp(state.projectId, created.id);
        }
        await fetchStamps();
      }
    } finally {
      setSavingStamp(false);
      setShowSaveStamp(false);
      stampThumbnailRef.current = null;
      stampSelectionRef.current = null;
    }
  }, [state.mapData, state.selection, state.tilesetImages, state.projectId, fetchStamps, linkStamp]);

  const handleSelectStamp = useCallback(async (id: string) => {
    if (activeStamp?.id === id) { setActiveStamp(null); return; }
    try {
      const res = await fetch(`/api/stamps/${id}`);
      if (res.ok) {
        const data = await res.json();
        // Ensure layers/tilesets are parsed (SQLite returns JSON as string)
        if (typeof data.layers === 'string') data.layers = JSON.parse(data.layers);
        if (typeof data.tilesets === 'string') data.tilesets = JSON.parse(data.tilesets);
        setActiveStamp(data);
        dispatch({ type: 'SET_TOOL', tool: 'select' });
      }
    } catch { /* ignore */ }
  }, [activeStamp, dispatch]);

  const handleDeleteStamp = useCallback(async (id: string) => {
    await fetch(`/api/stamps/${id}`, { method: 'DELETE' });
    if (activeStamp?.id === id) setActiveStamp(null);
    fetchStamps();
  }, [activeStamp, fetchStamps]);

  const handleEditStamp = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/stamps/${id}`);
      if (res.ok) {
        const data = await res.json();
        setEditingStamp(data);
        setShowStampEditor(true);
      }
    } catch { /* ignore */ }
  }, []);

  const handleSaveStampEdit = useCallback(async (updated: { name?: string; cols?: number; rows?: number; layers: any[]; tilesets: any[]; thumbnail: string | null }) => {
    if (!editingStamp) return;
    try {
      const res = await fetch(`/api/stamps/${editingStamp.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (res.ok) {
        await fetchStamps();
        setShowStampEditor(false);
        setEditingStamp(null);
      }
    } catch { /* ignore */ }
  }, [editingStamp, fetchStamps]);

  const handlePlaceStamp = useCallback(async (targetX: number, targetY: number) => {
    if (!activeStamp || !state.mapData) return;

    const stampLayers = typeof activeStamp.layers === 'string' ? JSON.parse(activeStamp.layers) : activeStamp.layers;
    const stampTilesets = typeof activeStamp.tilesets === 'string' ? JSON.parse(activeStamp.tilesets) : activeStamp.tilesets;

    // Load stamp tileset images from base64
    const stampTilesetImages = new Map<number, HTMLImageElement>();
    for (const st of stampTilesets) {
      if (!st.image) continue;
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); img.src = st.image; });
      stampTilesetImages.set(st.firstgid, img);
    }

    // Pixel-match: compare actual tile pixels to find correct map GIDs
    const remap = buildPixelMatchRemap(stampTilesets, stampTilesetImages, state.tilesetImages);

    const mapW = state.mapData.width;
    const mapH = state.mapData.height;
    const stampLayerChanges: Array<{ layerIndex: number; changes: Array<{ index: number; oldGid: number; newGid: number }> }> = [];

    for (const sl of stampLayers) {
      const layerIdx = findLayerByName(state.mapData.layers, sl.name);
      if (layerIdx === -1) continue;

      const layer = state.mapData.layers[layerIdx];
      if (!layer || !layer.data) continue;

      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];
      for (let row = 0; row < activeStamp.rows; row++) {
        for (let col = 0; col < activeStamp.cols; col++) {
          const stampGid = sl.data[row * activeStamp.cols + col];
          if (stampGid === 0) continue;
          const mapGid = remap.get(stampGid);
          if (mapGid === undefined) continue; // no match found — skip
          const mapCol = targetX + col;
          const mapRow = targetY + row;
          if (mapCol < 0 || mapCol >= mapW || mapRow < 0 || mapRow >= mapH) continue;
          const mapIdx = mapRow * mapW + mapCol;
          const oldGid = layer.data[mapIdx];
          if (oldGid !== mapGid) changes.push({ index: mapIdx, oldGid, newGid: mapGid });
        }
      }
      if (changes.length > 0) stampLayerChanges.push({ layerIndex: layerIdx, changes });
    }

    if (stampLayerChanges.length > 0) {
      dispatch({ type: 'PLACE_STAMP', stampLayers: stampLayerChanges });
    }
  }, [activeStamp, state.mapData, state.tilesetImages, dispatch]);

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
    onToolSelect: () => dispatch({ type: 'SET_TOOL', tool: 'select' }),
    onToolPan: () => dispatch({ type: 'SET_TOOL', tool: 'pan' }),
    onToggleGrid: () => dispatch({ type: 'TOGGLE_GRID' }),
    onZoomIn: () => dispatch({ type: 'SET_ZOOM', zoom: Math.round((state.zoom + 0.1) * 10) / 10 }),
    onZoomOut: () => dispatch({ type: 'SET_ZOOM', zoom: Math.round((state.zoom - 0.1) * 10) / 10 }),
    onUndo: () => dispatch({ type: 'UNDO' }),
    onRedo: () => dispatch({ type: 'REDO' }),
    onNewMap: () => {
      if (confirmIfDirty()) router.push('/map-editor');
    },
    onSave: handleSave,
    onLoad: () => {
      if (confirmIfDirty()) router.push('/map-editor');
    },
    onImportTileset: () => handleQuickImportTileset(),
    onHelp: () => setShowHelp((prev) => !prev),
    onDeleteLayer: () => handleDeleteLayer(),
    onSpaceDown: handleSpaceDown,
    onSpaceUp: handleSpaceUp,
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: handlePaste,
    onDeleteSelection: handleDeleteSelection,
    onClearSelection: handleClearSelection,
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
      const maxWidth = Math.floor(window.innerWidth / 2);
      setPanelWidth(Math.max(200, Math.min(maxWidth, startWidth + delta)));
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth]);

  // === Viewport size tracking for minimap ===
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const update = () => setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handlePanTo = useCallback(
    (panX: number, panY: number) => {
      dispatch({ type: 'SET_PAN', panX, panY });
    },
    [dispatch],
  );

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
  const toolName = state.tool === 'paint' ? 'Paint' : state.tool === 'erase' ? 'Erase' : state.tool === 'select' ? 'Select' : 'Pan';

  // === Save As ===

  const handleSaveAs = useCallback(async () => {
    if (!state.mapData || !state.projectId) return;
    const newName = prompt(t('mapEditor.project.projectName'), state.projectName);
    if (!newName?.trim()) return;

    try {
      // Create new project as copy
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          tiledJson: state.mapData,
          settings: {},
        }),
      });
      if (!res.ok) return;
      const created = await res.json();

      // Update local state to point to new project
      dispatch({ type: 'SET_MAP', mapData: state.mapData, projectName: newName.trim(), projectId: created.id });
      dispatch({ type: 'MARK_CLEAN' });
    } catch (err) {
      console.error('Save As failed:', err);
    }
  }, [state.mapData, state.projectId, state.projectName, dispatch, t]);

  // === Render ===

  if (!projectLoaded && !initialProjectId) {
    return (
      <ProjectBrowser
        onOpenProject={(id, userId) => {
          router.push(`/map-editor/${userId}/${id}`);
        }}
        onCreateProject={async (name, cols, rows, tw, th) => {
          const result = await createProject(name, cols, rows, tw, th);
          router.push(`/map-editor/${result.createdBy}/${result.id}`);
        }}
      />
    );
  }

  if (!projectLoaded) {
    return (
      <div className="h-screen bg-gray-900 flex items-center justify-center text-gray-500">
        Loading project...
      </div>
    );
  }

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
          if (confirmIfDirty()) router.push('/map-editor');
        }}
        onLoad={() => {
          if (confirmIfDirty()) router.push('/map-editor');
        }}
        onSaveToDeskRPG={handleSave}
        onExportTMJ={handleExportTMJ}
        onExportTMX={handleExportTMX}
        onExportPNG={handleExportPNG}
        onZoomIn={() => dispatch({ type: 'SET_ZOOM', zoom: Math.round((state.zoom + 0.1) * 10) / 10 })}
        onZoomOut={() => dispatch({ type: 'SET_ZOOM', zoom: Math.round((state.zoom - 0.1) * 10) / 10 })}
        onToggleGrid={() => dispatch({ type: 'TOGGLE_GRID' })}
        onToggleCollision={() => dispatch({ type: 'TOGGLE_COLLISION' })}
        onUndo={() => dispatch({ type: 'UNDO' })}
        onRedo={() => dispatch({ type: 'REDO' })}
        onHelp={() => setShowHelp(true)}
        onGoBack={() => router.push('/map-editor')}
        sectionVisibility={sectionVisibility}
        onToggleSection={(id) => setSectionVisibility((prev) => ({ ...prev, [id]: !prev[id] }))}
        onSaveAs={handleSaveAs}
      />

      {/* Main area: panel + canvas */}
      <div className="flex-1 flex min-h-0">
        {/* Left Panel */}
        <div
          className={`bg-surface border-r border-border flex-shrink-0 overflow-y-auto relative ${isDroppingTileset ? 'ring-2 ring-primary-light ring-inset' : ''}`}
          style={{ width: panelWidth }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setIsDroppingTileset(true);
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setIsDroppingTileset(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDroppingTileset(false);
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
              setDroppedTilesetFile(file);
              setShowImportTileset(true);
            }
          }}
        >
          {sectionOrder.filter((id) => sectionVisibility[id] !== false).map((sectionId) => {
            const isCollapsed = !!collapsedSections[sectionId];
            const isDragOver = dragOverSection === sectionId;
            const sectionLabel = sectionId === 'layers' ? t('mapEditor.layers.title') : sectionId === 'minimap' ? t('mapEditor.minimap.title') : sectionId === 'stamps' ? t('mapEditor.stamps.title') : t('mapEditor.tilesets.title');

            // Section header (shared for all sections)
            const header = (
              <div
                key={sectionId}
                draggable={true}
                onDragStart={() => { dragSectionRef.current = sectionId; }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragSectionRef.current && dragSectionRef.current !== sectionId) {
                    setDragOverSection(sectionId);
                  }
                }}
                onDrop={() => {
                  if (dragSectionRef.current && dragSectionRef.current !== sectionId) {
                    setSectionOrder((prev) => {
                      const arr = [...prev];
                      const fromIdx = arr.indexOf(dragSectionRef.current!);
                      const toIdx = arr.indexOf(sectionId);
                      arr.splice(fromIdx, 1);
                      arr.splice(toIdx, 0, dragSectionRef.current!);
                      return arr;
                    });
                  }
                  dragSectionRef.current = null;
                  setDragOverSection(null);
                }}
                onDragEnd={() => { dragSectionRef.current = null; setDragOverSection(null); }}
                className={`flex items-center justify-between px-3 py-1.5 border-b border-border cursor-grab select-none flex-shrink-0 ${
                  isDragOver ? 'border-t-2 border-t-primary-light' : ''
                }`}
              >
                <button
                  className="flex items-center gap-1 text-caption font-semibold text-text-secondary hover:text-text"
                  onClick={() => setCollapsedSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }))}
                >
                  <span className="text-micro" style={{ display: 'inline-block', width: '12px', textAlign: 'center' }}>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  {sectionLabel}
                </button>
                {/* Section-specific header actions */}
                {sectionId === 'layers' && !isCollapsed && (
                  <Tooltip label={t('mapEditor.layers.addLayerTooltip')}>
                    <button
                      className="text-text-secondary hover:text-text p-0.5 rounded hover:bg-surface-raised transition-colors"
                      onClick={handleAddLayer}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                )}
                {sectionId === 'tilesets' && !isCollapsed && (
                  <div className="flex items-center gap-0.5">
                    {state.selectedRegion && (
                      <Tooltip label={t('mapEditor.tilesets.createStampFromSelection')}>
                        <button
                          className="text-text-secondary hover:text-text p-0.5 rounded hover:bg-surface-raised transition-colors"
                          onClick={handleCreateStampFromTileset}
                        >
                          <Stamp className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip label={t('mapEditor.tilesets.importTilesetTooltip')} shortcut="I">
                      <button
                        className="text-text-secondary hover:text-text p-0.5 rounded hover:bg-surface-raised transition-colors"
                        onClick={() => handleQuickImportTileset()}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            );

            if (isCollapsed) return header;

            // Section content
            if (sectionId === 'layers') {
              return (
                <div key={sectionId}>
                  {header}
                  <div>
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
                        onSetLayerDepth={(index, depth) =>
                          dispatch({ type: 'SET_LAYER_DEPTH', index, depth })
                        }
                        onAddLayer={handleAddLayer}
                        onToggleVisibility={handleToggleLayerVisibility}
                        layerOverlayMap={layerOverlayMap}
                        onToggleLayerOverlay={(idx) => setLayerOverlayMap((prev) => ({ ...prev, [idx]: !(prev[idx] ?? true) }))}
                        hideHeader
                      />
                    )}
                  </div>
                </div>
              );
            }

            if (sectionId === 'stamps') {
              return (
                <div key={sectionId}>
                  {header}
                  {!isCollapsed && (
                    <StampPanel
                      stamps={stamps}
                      activeStampId={activeStamp?.id ?? null}
                      onSelectStamp={handleSelectStamp}
                      onDeleteStamp={handleDeleteStamp}
                      onEditStamp={handleEditStamp}
                      hideHeader
                      projectId={state.projectId}
                      onAddToProject={async (stampId) => {
                        if (state.projectId) {
                          await linkStamp(state.projectId, stampId);
                          // Refresh project stamps
                          try {
                            const res = await fetch(`/api/projects/${state.projectId}`);
                            if (res.ok) {
                              const data = await res.json();
                              setStamps(data.stamps.map((s: any) => ({
                                id: s.id,
                                name: s.name,
                                cols: s.cols,
                                rows: s.rows,
                                thumbnail: s.thumbnail ?? undefined,
                                layerNames: s.layerNames ?? [],
                              })));
                            }
                          } catch {}
                        }
                      }}
                    />
                  )}
                </div>
              );
            }

            if (sectionId === 'minimap') {
              return (
                <div key={sectionId}>
                  {header}
                  <Minimap
                    state={state}
                    findTileset={findTileset}
                    viewportWidth={viewportSize.width}
                    viewportHeight={viewportSize.height}
                    onPanTo={handlePanTo}
                    hideHeader
                  />
                </div>
              );
            }

            if (sectionId === 'tilesets') {
              return (
                <div key={sectionId}>
                  {header}
                  <div>
                    <TilePalette
                      tilesets={sortedTilesets}
                      selectedRegion={state.selectedRegion}
                      onSelectRegion={handleSelectRegion}
                      onImportTileset={() => handleQuickImportTileset()}
                      onDeleteTileset={handleDeleteTileset}
                      onRenameTileset={(firstgid, name) => dispatch({ type: 'RENAME_TILESET', firstgid, name })}
                      onEditPixels={handleEditPixels}
                      onReorderTileset={handleReorderTileset}
                      hideHeader
                    />
                  </div>
                </div>
              );
            }

            return null;
          })}
        </div>

        {/* Resize Handle */}
        <div
          className="w-1 cursor-col-resize bg-border hover:bg-primary-light/50 transition-colors flex-shrink-0"
          onMouseDown={handleResizeMouseDown}
        />

        {/* Canvas Area */}
        <div ref={canvasAreaRef} className="flex-1 min-w-0 min-h-0">
          {state.mapData ? (
            <MapCanvas
              state={state}
              dispatch={dispatch}
              findTileset={findTileset}
              onStatusUpdate={setStatusInfo}
              layerOverlayMap={layerOverlayMap}
              onEditSelectionPixels={handleEditSelectionPixels}
              onCopySelection={handleCopy}
              onSaveAsStamp={(thumbnail: string | null) => {
                stampThumbnailRef.current = thumbnail;
                stampSelectionRef.current = state.selection ? { ...state.selection } : null;
                setShowSaveStamp(true);
              }}
              activeStamp={activeStamp}
              onPlaceStamp={handlePlaceStamp}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-dim text-body">
              {t('mapEditor.emptyState')}
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="h-6 flex items-center gap-4 px-3 bg-surface border-t border-border text-micro text-text-dim select-none flex-shrink-0">
        {statusInfo && (
          <span>
            {t('mapEditor.statusBar.tile')} ({statusInfo.tileX}, {statusInfo.tileY})
          </span>
        )}
        <span>{t('mapEditor.statusBar.layer')} {activeLayerName}</span>
        <span>{t('mapEditor.statusBar.tool')} {toolName}</span>
        {statusInfo && statusInfo.gid > 0 && <span>GID: {statusInfo.gid}</span>}
        <span className="ml-auto">
          {state.mapData
            ? `${state.mapData.width}x${state.mapData.height} (${state.mapData.tilewidth}px)`
            : t('mapEditor.statusBar.noMap')}
        </span>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={tilesetFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleTilesetFileSelected}
      />

      {/* Modals */}
      <ImportTilesetModal
        open={showImportTileset}
        onClose={() => { setShowImportTileset(false); setDroppedTilesetFile(null); }}
        existingTilesets={state.mapData?.tilesets ?? []}
        onImport={handleImportTileset}
        initialFile={droppedTilesetFile}
        projectId={state.projectId}
        onLinkTileset={async (tilesetId, firstgid) => {
          if (state.projectId) await linkTileset(state.projectId, tilesetId, firstgid);
        }}
      />

      <HelpModal
        open={showHelp}
        onClose={() => setShowHelp(false)}
      />

      <SaveStampModal
        open={showSaveStamp}
        onClose={() => setShowSaveStamp(false)}
        onSave={handleSaveStamp}
        saving={savingStamp}
      />

      {showStampEditor && editingStamp && (
        <StampEditorModal
          open={showStampEditor}
          onClose={() => { setShowStampEditor(false); setEditingStamp(null); }}
          stamp={editingStamp}
          onSave={handleSaveStampEdit}
          onDelete={async (stampId) => {
            await handleDeleteStamp(stampId);
            setShowStampEditor(false);
            setEditingStamp(null);
          }}
          onOpenPixelEditor={(imageDataUrl, cols, rows, tileWidth, tileHeight, onResult) => {
            pixelEditorStampCallbackRef.current = onResult;
            setSelectionPixelData({ dataUrl: imageDataUrl, tileWidth, tileHeight, cols, rows });
            setShowPixelEditor(true);
          }}
        />
      )}

      {showPixelEditor && (selectionPixelData || (state.selectedRegion && state.tilesetImages[state.selectedRegion.firstgid])) && (
        <PixelEditorModal
          open={showPixelEditor}
          onClose={() => { setShowPixelEditor(false); setSelectionPixelData(null); }}
          region={selectionPixelData ? null : state.selectedRegion}
          tilesetInfo={selectionPixelData ? null : (state.selectedRegion ? state.tilesetImages[state.selectedRegion.firstgid] : null)}
          onSaveAsNew={handlePixelSaveAsNew}
          onOverwrite={handlePixelOverwrite}
          initialImageDataUrl={selectionPixelData?.dataUrl}
          initialTileWidth={selectionPixelData?.tileWidth}
          initialTileHeight={selectionPixelData?.tileHeight}
          initialCols={selectionPixelData?.cols}
          initialRows={selectionPixelData?.rows}
          onApply={pixelEditorStampCallbackRef.current ? (dataUrl: string, newCols: number, newRows: number) => {
            pixelEditorStampCallbackRef.current?.(dataUrl, newCols, newRows);
            pixelEditorStampCallbackRef.current = null;
            setShowPixelEditor(false);
            setSelectionPixelData(null);
          } : undefined}
          onSaveAsStamp={state.mapData ? async (thumbnail, cols, rows, tileWidth, tileHeight) => {
            // Two paths: map selection or tileset palette selection
            const sel = stampSelectionRef.current ?? state.selection;
            const region = state.selectedRegion;

            if (!state.mapData) return;

            let stampLayers: Array<{ name: string; type: string; depth: number; data: number[] }> = [];
            const usedGids = new Set<number>();

            if (sel) {
              // Map selection path — use map GIDs from all layers
              const tw = state.mapData.tilewidth;
              const th = state.mapData.tileheight;
              const mapW = state.mapData.width;
              for (const layer of state.mapData.layers) {
                if (layer.type !== 'tilelayer' || !layer.data) continue;
                if (layer.name.toLowerCase() === 'collision') continue;
                const depthProp = layer.properties?.find((p: any) => p.name === 'depth');
                const depthVal = depthProp ? Number(depthProp.value) || 0 : 0;
                const data: number[] = [];
                for (let row = 0; row < sel.height; row++) {
                  for (let col = 0; col < sel.width; col++) {
                    const mapCol = sel.x + col;
                    const mapRow = sel.y + row;
                    const gid = (mapCol >= 0 && mapCol < mapW && mapRow >= 0 && mapRow < state.mapData!.height)
                      ? layer.data[mapRow * mapW + mapCol] : 0;
                    data.push(gid);
                    if (gid !== 0) usedGids.add(gid);
                  }
                }
                if (data.some((g) => g !== 0)) {
                  stampLayers.push({ name: layer.name, type: layer.type, depth: depthVal, data });
                }
              }
            } else if (region) {
              // Tileset palette selection path — build a single-layer stamp from selected tiles
              const data: number[] = [];
              for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                  const localId = (region.row + r) * (state.tilesetImages[region.firstgid]?.columns ?? 1) + (region.col + c);
                  const gid = region.firstgid + localId;
                  data.push(gid);
                  usedGids.add(gid);
                }
              }
              stampLayers = [{ name: 'Floor', type: 'tilelayer', depth: 0, data }];
            }

            if (stampLayers.length === 0) return;
            const stampTilesets: Array<{ name: string; firstgid: number; tilewidth: number; tileheight: number; columns: number; tilecount: number; image: string }> = [];
            for (const ts of state.mapData.tilesets) {
              const maxGid = ts.firstgid + ts.tilecount - 1;
              if (![...usedGids].some((g) => g >= ts.firstgid && g <= maxGid)) continue;
              const imgInfo = state.tilesetImages[ts.firstgid];
              if (!imgInfo) continue;
              const canvas = document.createElement('canvas');
              canvas.width = imgInfo.img.naturalWidth || imgInfo.img.width;
              canvas.height = imgInfo.img.naturalHeight || imgInfo.img.height;
              const ctx = canvas.getContext('2d')!;
              ctx.drawImage(imgInfo.img, 0, 0);
              stampTilesets.push({
                name: ts.name, firstgid: ts.firstgid, tilewidth: ts.tilewidth,
                tileheight: ts.tileheight, columns: ts.columns, tilecount: ts.tilecount, image: canvas.toDataURL('image/png'),
              });
            }
            const layerName = state.mapData.layers[state.activeLayerIndex]?.name || 'stamp';
            const stampCols = sel ? sel.width : cols;
            const stampRows = sel ? sel.height : rows;
            const stampTw = sel ? state.mapData.tilewidth : tileWidth;
            const stampTh = sel ? state.mapData.tileheight : tileHeight;
            const res = await fetch('/api/stamps', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: `${layerName}-stamp`, cols: stampCols, rows: stampRows, tileWidth: stampTw, tileHeight: stampTh, layers: stampLayers, tilesets: stampTilesets, thumbnail }),
            });
            if (res.ok) await fetchStamps();
          } : undefined}
        />
      )}
    </div>
  );
}
