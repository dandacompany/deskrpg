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
import { Plus } from 'lucide-react';
import { useT } from '@/lib/i18n';
import Tooltip from './Tooltip';
import Toolbar from './Toolbar';
import LayerPanel from './LayerPanel';
import TilePalette from './TilePalette';
import Minimap from './Minimap';
import { MapCanvas } from './MapCanvas';
import HelpModal from './HelpModal';
import NewMapModal from './NewMapModal';
import ImportTilesetModal from './ImportTilesetModal';
import PixelEditorModal from './PixelEditorModal';
import type { ImportTilesetResult } from './ImportTilesetModal';
import { buildProjectZip, loadProjectZip } from '@/lib/map-project';
import { exportTmx } from '@/lib/tmx-exporter';
import StampPanel from './StampPanel';
import SaveStampModal from './SaveStampModal';
import type { StampListItem, StampData } from '@/lib/stamp-utils';
import { buildGidRemapTable, findLayerByName } from '@/lib/stamp-utils';


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
  const t = useT();
  const { state, dispatch, findTileset } = useMapEditor();

  // Modal visibility
  const [showNewMap, setShowNewMap] = useState(false);
  const [showImportTileset, setShowImportTileset] = useState(false);
  const [droppedTilesetFile, setDroppedTilesetFile] = useState<File | null>(null);
  const [isDroppingTileset, setIsDroppingTileset] = useState(false);
  const [layerOverlayMap, setLayerOverlayMap] = useState<Record<number, boolean>>({});
  const [showHelp, setShowHelp] = useState(false);
  const [showPixelEditor, setShowPixelEditor] = useState(false);
  const [stamps, setStamps] = useState<StampListItem[]>([]);
  const [activeStamp, setActiveStamp] = useState<StampData | null>(null);
  const [showSaveStamp, setShowSaveStamp] = useState(false);
  const [savingStamp, setSavingStamp] = useState(false);

  // Pan (space-held) state
  const [spaceHeld, setSpaceHeld] = useState(false);
  const previousToolRef = useRef(state.tool);

  // Resizable panel
  const [panelWidth, setPanelWidth] = useState(300);

  // Left panel section order & collapsed state
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => {
    try { const v = localStorage.getItem('mapEditor.sectionOrder'); return v ? JSON.parse(v) : ['layers', 'tilesets', 'stamps', 'minimap']; } catch { return ['layers', 'tilesets', 'stamps', 'minimap']; }
  });
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem('mapEditor.collapsedSections'); return v ? JSON.parse(v) : {}; } catch { return {}; }
  });
  const [sectionVisibility, setSectionVisibility] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem('mapEditor.sectionVisibility'); return v ? JSON.parse(v) : { layers: true, tilesets: true, stamps: true, minimap: true }; } catch { return { layers: true, tilesets: true, stamps: true, minimap: true }; }
  });
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tilesetFileInputRef = useRef<HTMLInputElement>(null);

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

  // === File Operations ===

  const handleNewMap = useCallback(
    (mapData: TiledMap, projectName: string) => {
      dispatch({ type: 'SET_MAP', mapData, projectName, templateId: null });
      // Add collision tileset after setting map
      addBuiltinTileset(mapData);
    },
    [dispatch, addBuiltinTileset],
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

  const handleEditPixels = useCallback(
    (firstgid: number, region: TileRegion) => {
      if (!state.tilesetImages[firstgid]) return;
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
    async (firstgid: number, dataUrl: string) => {
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
        region.width * tsInfo.tilewidth,
        region.height * tsInfo.tileheight,
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
    [state.tilesetImages, state.selectedRegion, dispatch],
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

  const handleDeleteSelection = useCallback(() => {
    if (!state.selection) return;
    dispatch({ type: 'DELETE_SELECTION' });
  }, [state.selection, dispatch]);

  const handleClearSelection = useCallback(() => {
    dispatch({ type: 'CLEAR_SELECTION' });
  }, [dispatch]);

  // === Stamp Functions ===

  const stampThumbnailRef = useRef<string | null>(null);

  const fetchStamps = useCallback(async () => {
    try {
      const res = await fetch('/api/stamps');
      if (res.ok) setStamps(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStamps(); }, [fetchStamps]);

  const handleSaveStamp = useCallback(async (name: string) => {
    if (!state.mapData || !state.selection) return;
    setSavingStamp(true);
    try {
      const sel = state.selection;
      const tw = state.mapData.tilewidth;
      const th = state.mapData.tileheight;
      const mapW = state.mapData.width;

      const stampLayers: Array<{ name: string; type: string; depth: number; data: number[] }> = [];
      const usedGids = new Set<number>();

      for (const layer of state.mapData.layers) {
        if (layer.type !== 'tilelayer' || !layer.data || !layer.visible) continue;

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
      if (res.ok) await fetchStamps();
    } finally {
      setSavingStamp(false);
      setShowSaveStamp(false);
      stampThumbnailRef.current = null;
    }
  }, [state.mapData, state.selection, state.tilesetImages, fetchStamps]);

  const handleSelectStamp = useCallback(async (id: string) => {
    if (activeStamp?.id === id) { setActiveStamp(null); return; }
    try {
      const res = await fetch(`/api/stamps/${id}`);
      if (res.ok) {
        const data = await res.json();
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

  const handlePlaceStamp = useCallback(async (targetX: number, targetY: number) => {
    if (!activeStamp || !state.mapData) return;

    const mapTilesetFirstgids: Record<string, number> = {};

    for (const st of activeStamp.tilesets) {
      const existing = state.mapData.tilesets.find((t) => t.name === st.name);
      if (existing) {
        mapTilesetFirstgids[st.name] = existing.firstgid;
      } else {
        let newFirstgid = 1;
        for (const ts of state.mapData.tilesets) {
          const end = ts.firstgid + ts.tilecount;
          if (end > newFirstgid) newFirstgid = end;
        }
        mapTilesetFirstgids[st.name] = newFirstgid;

        const img = new Image();
        await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = st.image; });

        dispatch({
          type: 'ADD_TILESET',
          tileset: {
            firstgid: newFirstgid, name: st.name, tilewidth: st.tilewidth,
            tileheight: st.tileheight, tilecount: st.tilecount, columns: st.columns,
            image: st.image, imagewidth: st.columns * st.tilewidth,
            imageheight: Math.ceil(st.tilecount / st.columns) * st.tileheight,
          },
          imageInfo: {
            img, firstgid: newFirstgid, columns: st.columns,
            tilewidth: st.tilewidth, tileheight: st.tileheight,
            tilecount: st.tilecount, name: st.name,
          },
        });
      }
    }

    const remap = buildGidRemapTable(activeStamp.tilesets, mapTilesetFirstgids);
    const mapW = state.mapData.width;
    const mapH = state.mapData.height;
    const stampLayerChanges: Array<{ layerIndex: number; changes: Array<{ index: number; oldGid: number; newGid: number }> }> = [];

    for (const sl of activeStamp.layers) {
      let layerIdx = findLayerByName(state.mapData.layers, sl.name);

      if (layerIdx === -1) {
        const newLayer = {
          id: state.mapData.nextlayerid,
          name: sl.name, type: sl.type as 'tilelayer',
          data: new Array(mapW * mapH).fill(0),
          width: mapW, height: mapH,
          opacity: sl.name.toLowerCase() === 'collision' ? 0.5 : 1,
          visible: sl.name.toLowerCase() !== 'collision',
          x: 0, y: 0,
          properties: sl.depth !== 0 ? [{ name: 'depth', type: 'int' as const, value: sl.depth }] : undefined,
        };
        dispatch({ type: 'ADD_LAYER', layer: newLayer as any });
        layerIdx = state.mapData.layers.length;
      }

      const layer = state.mapData.layers[layerIdx];
      if (!layer || !layer.data) continue;

      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];
      for (let row = 0; row < activeStamp.rows; row++) {
        for (let col = 0; col < activeStamp.cols; col++) {
          const stampGid = sl.data[row * activeStamp.cols + col];
          if (stampGid === 0) continue;
          const mapCol = targetX + col;
          const mapRow = targetY + row;
          if (mapCol < 0 || mapCol >= mapW || mapRow < 0 || mapRow >= mapH) continue;
          const mapIdx = mapRow * mapW + mapCol;
          const oldGid = layer.data[mapIdx];
          const newGid = remap.get(stampGid) ?? stampGid;
          if (oldGid !== newGid) changes.push({ index: mapIdx, oldGid, newGid });
        }
      }
      if (changes.length > 0) stampLayerChanges.push({ layerIndex: layerIdx, changes });
    }

    if (stampLayerChanges.length > 0) {
      dispatch({ type: 'PLACE_STAMP', stampLayers: stampLayerChanges });
    }
  }, [activeStamp, state.mapData, dispatch]);

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
      if (confirmIfDirty()) setShowNewMap(true);
    },
    onSave: handleSaveToDeskRPG,
    onLoad: handleLoad,
    onImportTileset: () => handleQuickImportTileset(),
    onHelp: () => setShowHelp((prev) => !prev),
    onDeleteLayer: () => handleDeleteLayer(),
    onSpaceDown: handleSpaceDown,
    onSpaceUp: handleSpaceUp,
    onCopy: handleCopy,
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
            const sectionLabel = sectionId === 'layers' ? t('mapEditor.layers.title') : sectionId === 'minimap' ? t('mapEditor.minimap.title') : sectionId === 'stamps' ? 'Stamps' : t('mapEditor.tilesets.title');

            // Section header (shared for all sections)
            const header = (
              <div
                key={sectionId}
                draggable
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
                  <Tooltip label={t('mapEditor.tilesets.importTilesetTooltip')} shortcut="I">
                    <button
                      className="text-text-secondary hover:text-text p-0.5 rounded hover:bg-surface-raised transition-colors"
                      onClick={() => handleQuickImportTileset()}
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
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
                      hideHeader
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
              onSaveAsStamp={(thumbnail: string | null) => {
                stampThumbnailRef.current = thumbnail;
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
        ref={fileInputRef}
        type="file"
        accept=".tmj,.tmx,.json,.zip"
        className="hidden"
        onChange={handleFileSelected}
      />
      <input
        ref={tilesetFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleTilesetFileSelected}
      />

      {/* Modals */}
      <NewMapModal
        open={showNewMap}
        onClose={() => setShowNewMap(false)}
        onSubmit={handleNewMap}
      />

      <ImportTilesetModal
        open={showImportTileset}
        onClose={() => { setShowImportTileset(false); setDroppedTilesetFile(null); }}
        existingTilesets={state.mapData?.tilesets ?? []}
        onImport={handleImportTileset}
        initialFile={droppedTilesetFile}
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

      {showPixelEditor && state.selectedRegion && state.tilesetImages[state.selectedRegion.firstgid] && (
        <PixelEditorModal
          open={showPixelEditor}
          onClose={() => setShowPixelEditor(false)}
          region={state.selectedRegion}
          tilesetInfo={state.tilesetImages[state.selectedRegion.firstgid]}
          onSaveAsNew={handlePixelSaveAsNew}
          onOverwrite={handlePixelOverwrite}
        />
      )}
    </div>
  );
}
