'use client';

import { useReducer, useCallback } from 'react';

// === Types ===

export interface TiledTileset {
  firstgid: number;
  name: string;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  columns: number;
  image: string;
  imagewidth: number;
  imageheight: number;
  tiles?: Array<{
    id: number;
    properties?: Array<{ name: string; type: string; value: unknown }>;
    objectgroup?: unknown;
  }>;
}

export interface TiledLayer {
  id: number;
  name: string;
  type: 'tilelayer' | 'objectgroup';
  width?: number;
  height?: number;
  data?: number[];
  objects?: TiledObject[];
  opacity: number;
  visible: boolean;
  x: number;
  y: number;
  draworder?: string;
  properties?: Array<{ name: string; type: string; value: unknown }>;
}

export interface TiledObject {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  orientation: string;
  renderorder: string;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
  nextlayerid: number;
  nextobjectid: number;
  infinite: boolean;
  type: string;
  version: string;
  tiledversion: string;
  compressionlevel: number;
}

export interface TileRegion {
  firstgid: number;
  col: number;
  row: number;
  width: number;
  height: number;
  gids: number[][];
}

export interface TilesetImageInfo {
  img: HTMLImageElement;
  firstgid: number;
  columns: number;
  tilewidth: number;
  tileheight: number;
  tilecount: number;
  name: string;
}

export interface UndoAction {
  layerIndex: number;
  changes: Array<{ index: number; oldGid: number; newGid: number }>;
}

export type Tool = 'paint' | 'erase' | 'pan' | 'select';

export interface EditorState {
  projectName: string;
  dirty: boolean;
  templateId: string | null;
  mapData: TiledMap | null;
  tilesetImages: Record<number, TilesetImageInfo>;
  activeLayerIndex: number;
  tool: Tool;
  selectedTileGid: number;
  selectedRegion: TileRegion | null;
  zoom: number;
  panX: number;
  panY: number;
  undoStack: UndoAction[];
  redoStack: UndoAction[];
  sortedGids: number[];
  showGrid: boolean;
  showCollision: boolean;
  selection: { x: number; y: number; width: number; height: number } | null;
  clipboard: { width: number; height: number; gids: number[][]; layerIndex: number } | null;
}

// === Core DeskRPG Layer Names ===
export const CORE_LAYERS = ['floor', 'walls', 'foreground', 'collision', 'objects'];

export function isCoreLayer(layer: TiledLayer): boolean {
  return CORE_LAYERS.includes((layer.name || '').toLowerCase());
}

export function getDeskRPGRole(layer: TiledLayer, idx: number, layers: TiledLayer[]) {
  const n = (layer.name || '').toLowerCase();
  if (n === 'collision') return { label: 'COL', desc: 'Collision (hidden in game)', color: 'bg-danger/20 text-danger' };
  if (n === 'floor') return { label: 'D:0', desc: 'Floor (depth 0)', color: 'bg-success/20 text-success' };
  if (n === 'walls') return { label: 'D:1', desc: 'Walls (depth 1)', color: 'bg-info/20 text-info' };
  if (n === 'foreground' || n === 'above' || n === 'overlay') return { label: 'D:10K', desc: 'Foreground (depth 10000)', color: 'bg-npc/20 text-npc' };
  if (layer.type === 'objectgroup') return { label: 'OBJ', desc: 'Objects (y-sort)', color: 'bg-meeting/20 text-meeting' };
  return null;
}

// === Collision Tileset Generator ===
export const BUILTIN_TILESET_NAME = 'color-palette';

const PALETTE_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#ffffff', '#d1d5db', '#9ca3af', '#6b7280',
  '#374151', '#1f2937', '#000000', '#00000000',
];

export function generateBuiltinTilesetDataUrl(tileSize: number = 32): string {
  const cols = PALETTE_COLORS.length;
  const rows = 1;
  const canvas = document.createElement('canvas');
  canvas.width = tileSize * cols;
  canvas.height = tileSize * rows;
  const ctx = canvas.getContext('2d')!;

  PALETTE_COLORS.forEach((color, i) => {
    const x = (i % cols) * tileSize;
    const y = Math.floor(i / cols) * tileSize;
    if (color === '#00000000') {
      // Transparent tile — leave empty
      return;
    }
    ctx.fillStyle = color;
    ctx.fillRect(x, y, tileSize, tileSize);
  });

  return canvas.toDataURL('image/png');
}

export function getBuiltinTilesetInfo(tileSize: number = 32) {
  const cols = PALETTE_COLORS.length;
  const count = PALETTE_COLORS.length;
  const rows = 1;
  return { columns: cols, tilecount: count, rows, imagewidth: cols * tileSize, imageheight: rows * tileSize };
}

// === Default Map (DeskRPG Policy) ===
export function createDefaultMap(name: string, width: number, height: number, tileSize: number): TiledMap {
  const empty = new Array(width * height).fill(0);
  return {
    compressionlevel: -1,
    width, height,
    tilewidth: tileSize,
    tileheight: tileSize,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    type: 'map',
    version: '1.10',
    tiledversion: '1.11.2',
    nextlayerid: 7,
    nextobjectid: 2,
    tilesets: [],
    layers: [
      { id: 1, name: 'Floor', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data: [...empty], properties: [{ name: 'depth', type: 'int', value: 0 }] },
      { id: 2, name: 'Walls', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data: [...empty], properties: [{ name: 'depth', type: 'int', value: 1 }] },
      { id: 3, name: 'Foreground', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data: [...empty], properties: [{ name: 'depth', type: 'int', value: 10000 }] },
      { id: 4, name: 'Collision', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 0.5, visible: true, data: [...empty], properties: [{ name: 'depth', type: 'int', value: -1 }] },
      { id: 5, name: 'Objects', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown', objects: [{ id: 1, name: 'spawn', type: 'spawn', x: Math.floor(width / 2) * tileSize, y: Math.floor(height / 2) * tileSize, width: tileSize, height: tileSize, visible: true }], properties: [{ name: 'depth', type: 'string', value: 'y-sort' }] },
    ],
  };
}

// === Reducer Actions ===
type EditorAction =
  | { type: 'SET_MAP'; mapData: TiledMap; projectName?: string; templateId?: string | null }
  | { type: 'SET_TOOL'; tool: Tool }
  | { type: 'SET_ACTIVE_LAYER'; index: number }
  | { type: 'SET_SELECTED_TILE'; gid: number; region?: TileRegion | null }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'SET_PAN'; panX: number; panY: number }
  | { type: 'TOGGLE_GRID' }
  | { type: 'TOGGLE_COLLISION' }
  | { type: 'PAINT_TILE'; layerIndex: number; changes: Array<{ index: number; oldGid: number; newGid: number }> }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'ADD_LAYER'; layer: TiledLayer }
  | { type: 'DELETE_LAYER'; index: number }
  | { type: 'RENAME_LAYER'; index: number; name: string }
  | { type: 'TOGGLE_LAYER_VISIBILITY'; index: number }
  | { type: 'REORDER_LAYERS'; fromIndex: number; toIndex: number }
  | { type: 'ADD_TILESET'; tileset: TiledTileset; imageInfo: TilesetImageInfo }
  | { type: 'DELETE_TILESET'; firstgid: number }
  | { type: 'UPDATE_TILESET_IMAGE'; firstgid: number; imageInfo: TilesetImageInfo; imageDataUrl: string }
  | { type: 'MARK_CLEAN' }
  | { type: 'SET_PROJECT_NAME'; name: string }
  | { type: 'SET_SELECTION'; selection: { x: number; y: number; width: number; height: number } | null }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_CLIPBOARD'; clipboard: { width: number; height: number; gids: number[][]; layerIndex: number } }
  | { type: 'DELETE_SELECTION' }
  | { type: 'PASTE_CLIPBOARD'; x: number; y: number }
  | { type: 'MOVE_TILES'; fromX: number; fromY: number; toX: number; toY: number; width: number; height: number }
  | { type: 'RENAME_TILESET'; firstgid: number; name: string }
  | { type: 'REORDER_TILESETS'; fromFirstgid: number; toFirstgid: number }
  | { type: 'REMOVE_UNUSED_TILESETS'; firstgids: number[] };

export type { EditorAction };

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'SET_MAP': {
      const sortedGids = Object.keys(state.tilesetImages).map(Number).sort((a, b) => b - a);
      return {
        ...state,
        mapData: action.mapData,
        projectName: action.projectName ?? state.projectName,
        templateId: action.templateId !== undefined ? action.templateId : state.templateId,
        dirty: false,
        undoStack: [],
        redoStack: [],
        activeLayerIndex: 0,
        sortedGids,
      };
    }
    case 'SET_TOOL':
      return { ...state, tool: action.tool };
    case 'SET_ACTIVE_LAYER':
      return { ...state, activeLayerIndex: action.index };
    case 'SET_SELECTED_TILE':
      return { ...state, selectedTileGid: action.gid, selectedRegion: action.region ?? null };
    case 'SET_ZOOM':
      return { ...state, zoom: Math.max(0.5, Math.min(8, action.zoom)) };
    case 'SET_PAN':
      return { ...state, panX: action.panX, panY: action.panY };
    case 'TOGGLE_GRID':
      return { ...state, showGrid: !state.showGrid };
    case 'TOGGLE_COLLISION':
      return { ...state, showCollision: !state.showCollision };
    case 'PAINT_TILE': {
      if (!state.mapData) return state;
      const newLayers = [...state.mapData.layers];
      const layer = { ...newLayers[action.layerIndex] };
      if (layer.type !== 'tilelayer' || !layer.data) return state;
      const newData = [...layer.data];
      action.changes.forEach(c => { newData[c.index] = c.newGid; });
      layer.data = newData;
      newLayers[action.layerIndex] = layer;
      const undoStack = [...state.undoStack, { layerIndex: action.layerIndex, changes: action.changes }];
      if (undoStack.length > 100) undoStack.shift();
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack,
        redoStack: [],
        dirty: true,
      };
    }
    case 'UNDO': {
      if (state.undoStack.length === 0 || !state.mapData) return state;
      const undoAction = state.undoStack[state.undoStack.length - 1];
      const newLayers = [...state.mapData.layers];
      const layer = { ...newLayers[undoAction.layerIndex] };
      if (layer.type !== 'tilelayer' || !layer.data) return state;
      const newData = [...layer.data];
      undoAction.changes.forEach(c => { newData[c.index] = c.oldGid; });
      layer.data = newData;
      newLayers[undoAction.layerIndex] = layer;
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, undoAction],
        dirty: true,
      };
    }
    case 'REDO': {
      if (state.redoStack.length === 0 || !state.mapData) return state;
      const redoAction = state.redoStack[state.redoStack.length - 1];
      const newLayers = [...state.mapData.layers];
      const layer = { ...newLayers[redoAction.layerIndex] };
      if (layer.type !== 'tilelayer' || !layer.data) return state;
      const newData = [...layer.data];
      redoAction.changes.forEach(c => { newData[c.index] = c.newGid; });
      layer.data = newData;
      newLayers[redoAction.layerIndex] = layer;
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack: [...state.undoStack, redoAction],
        redoStack: state.redoStack.slice(0, -1),
        dirty: true,
      };
    }
    case 'ADD_LAYER': {
      if (!state.mapData) return state;
      return {
        ...state,
        mapData: { ...state.mapData, layers: [...state.mapData.layers, action.layer], nextlayerid: state.mapData.nextlayerid + 1 },
        activeLayerIndex: state.mapData.layers.length,
        dirty: true,
      };
    }
    case 'DELETE_LAYER': {
      if (!state.mapData || state.mapData.layers.length <= 1) return state;
      const newLayers = state.mapData.layers.filter((_, i) => i !== action.index);
      let newActive = state.activeLayerIndex;
      if (newActive >= newLayers.length) newActive = newLayers.length - 1;
      else if (newActive > action.index) newActive--;
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        activeLayerIndex: newActive,
        dirty: true,
      };
    }
    case 'RENAME_LAYER': {
      if (!state.mapData) return state;
      const newLayers = [...state.mapData.layers];
      newLayers[action.index] = { ...newLayers[action.index], name: action.name };
      return { ...state, mapData: { ...state.mapData, layers: newLayers }, dirty: true };
    }
    case 'TOGGLE_LAYER_VISIBILITY': {
      if (!state.mapData) return state;
      const newLayers = [...state.mapData.layers];
      newLayers[action.index] = { ...newLayers[action.index], visible: !newLayers[action.index].visible };
      return { ...state, mapData: { ...state.mapData, layers: newLayers } };
    }
    case 'REORDER_LAYERS': {
      if (!state.mapData) return state;
      const layers = [...state.mapData.layers];
      const [moved] = layers.splice(action.fromIndex, 1);
      const insertAt = action.toIndex > action.fromIndex ? action.toIndex - 1 : action.toIndex;
      layers.splice(insertAt, 0, moved);
      let newActive = state.activeLayerIndex;
      if (state.activeLayerIndex === action.fromIndex) newActive = insertAt;
      return { ...state, mapData: { ...state.mapData, layers }, activeLayerIndex: newActive, dirty: true };
    }
    case 'ADD_TILESET': {
      if (!state.mapData) return state;
      const newTilesetImages = { ...state.tilesetImages, [action.tileset.firstgid]: action.imageInfo };
      const sortedGids = Object.keys(newTilesetImages).map(Number).sort((a, b) => b - a);
      return {
        ...state,
        mapData: { ...state.mapData, tilesets: [...state.mapData.tilesets, action.tileset] },
        tilesetImages: newTilesetImages,
        sortedGids,
        dirty: true,
      };
    }
    case 'DELETE_TILESET': {
      if (!state.mapData) return state;
      const newTilesets = state.mapData.tilesets.filter(ts => ts.firstgid !== action.firstgid);
      const newImages = { ...state.tilesetImages };
      delete newImages[action.firstgid];
      const sortedGids = Object.keys(newImages).map(Number).sort((a, b) => b - a);
      return {
        ...state,
        mapData: { ...state.mapData, tilesets: newTilesets },
        tilesetImages: newImages,
        sortedGids,
        dirty: true,
      };
    }
    case 'UPDATE_TILESET_IMAGE': {
      if (!state.mapData) return state;
      const newTilesetImages = { ...state.tilesetImages, [action.firstgid]: action.imageInfo };
      const newTilesets = state.mapData.tilesets.map((ts) =>
        ts.firstgid === action.firstgid ? { ...ts, image: action.imageDataUrl } : ts,
      );
      return {
        ...state,
        mapData: { ...state.mapData, tilesets: newTilesets },
        tilesetImages: newTilesetImages,
        dirty: true,
      };
    }
    case 'MARK_CLEAN':
      return { ...state, dirty: false };
    case 'SET_PROJECT_NAME':
      return { ...state, projectName: action.name, dirty: true };
    case 'SET_SELECTION':
      return { ...state, selection: action.selection };
    case 'CLEAR_SELECTION':
      return { ...state, selection: null };
    case 'SET_CLIPBOARD':
      return { ...state, clipboard: action.clipboard };
    case 'DELETE_SELECTION': {
      if (!state.mapData || !state.selection) return state;
      const layer = state.mapData.layers[state.activeLayerIndex];
      if (!layer || layer.type !== 'tilelayer' || !layer.data) return state;
      const sel = state.selection;
      const mapW = state.mapData.width;
      const mapH = state.mapData.height;
      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];
      for (let dy = 0; dy < sel.height; dy++) {
        for (let dx = 0; dx < sel.width; dx++) {
          const tx = sel.x + dx;
          const ty = sel.y + dy;
          if (tx < 0 || tx >= mapW || ty < 0 || ty >= mapH) continue;
          const idx = ty * mapW + tx;
          const oldGid = layer.data[idx];
          if (oldGid !== 0) {
            changes.push({ index: idx, oldGid, newGid: 0 });
          }
        }
      }
      if (changes.length === 0) return state;
      const newLayers = [...state.mapData.layers];
      const newLayer = { ...newLayers[state.activeLayerIndex] };
      const newData = [...newLayer.data!];
      changes.forEach(c => { newData[c.index] = c.newGid; });
      newLayer.data = newData;
      newLayers[state.activeLayerIndex] = newLayer;
      const undoStack = [...state.undoStack, { layerIndex: state.activeLayerIndex, changes }];
      if (undoStack.length > 100) undoStack.shift();
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack,
        redoStack: [],
        dirty: true,
        selection: null,
      };
    }
    case 'PASTE_CLIPBOARD': {
      if (!state.mapData || !state.clipboard) return state;
      const layer = state.mapData.layers[state.activeLayerIndex];
      if (!layer || layer.type !== 'tilelayer' || !layer.data) return state;
      const cb = state.clipboard;
      const mapW = state.mapData.width;
      const mapH = state.mapData.height;
      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];
      for (let dy = 0; dy < cb.height; dy++) {
        for (let dx = 0; dx < cb.width; dx++) {
          const tx = action.x + dx;
          const ty = action.y + dy;
          if (tx < 0 || tx >= mapW || ty < 0 || ty >= mapH) continue;
          const idx = ty * mapW + tx;
          const oldGid = layer.data[idx];
          const newGid = cb.gids[dy][dx];
          if (oldGid !== newGid) {
            changes.push({ index: idx, oldGid, newGid });
          }
        }
      }
      if (changes.length === 0) return state;
      const newLayers = [...state.mapData.layers];
      const newLayer = { ...newLayers[state.activeLayerIndex] };
      const newData = [...newLayer.data!];
      changes.forEach(c => { newData[c.index] = c.newGid; });
      newLayer.data = newData;
      newLayers[state.activeLayerIndex] = newLayer;
      const undoStack = [...state.undoStack, { layerIndex: state.activeLayerIndex, changes }];
      if (undoStack.length > 100) undoStack.shift();
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack,
        redoStack: [],
        dirty: true,
      };
    }
    case 'MOVE_TILES': {
      if (!state.mapData) return state;
      const layer = state.mapData.layers[state.activeLayerIndex];
      if (!layer || layer.type !== 'tilelayer' || !layer.data) return state;
      const { fromX, fromY, toX, toY, width, height } = action;
      if (fromX === toX && fromY === toY) return state;
      const mapW = state.mapData.width;
      const mapH = state.mapData.height;
      const changes: Array<{ index: number; oldGid: number; newGid: number }> = [];

      // 1. Read source tiles
      const srcGids: number[][] = [];
      for (let dy = 0; dy < height; dy++) {
        const row: number[] = [];
        for (let dx = 0; dx < width; dx++) {
          const tx = fromX + dx, ty = fromY + dy;
          if (tx >= 0 && tx < mapW && ty >= 0 && ty < mapH) {
            row.push(layer.data[ty * mapW + tx]);
          } else {
            row.push(0);
          }
        }
        srcGids.push(row);
      }

      // 2. Clear source (set to 0)
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const tx = fromX + dx, ty = fromY + dy;
          if (tx >= 0 && tx < mapW && ty >= 0 && ty < mapH) {
            const idx = ty * mapW + tx;
            if (layer.data[idx] !== 0) {
              changes.push({ index: idx, oldGid: layer.data[idx], newGid: 0 });
            }
          }
        }
      }

      // 3. Place at destination
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const tx = toX + dx, ty = toY + dy;
          if (tx >= 0 && tx < mapW && ty >= 0 && ty < mapH) {
            const idx = ty * mapW + tx;
            const newGid = srcGids[dy][dx];
            // Find existing change for this index or use current data
            const existing = changes.find(c => c.index === idx);
            if (existing) {
              existing.newGid = newGid;
            } else if (layer.data[idx] !== newGid) {
              changes.push({ index: idx, oldGid: layer.data[idx], newGid });
            }
          }
        }
      }

      if (changes.length === 0) return state;
      const newLayers = [...state.mapData.layers];
      const newLayer = { ...newLayers[state.activeLayerIndex] };
      const newData = [...newLayer.data!];
      changes.forEach(c => { newData[c.index] = c.newGid; });
      newLayer.data = newData;
      newLayers[state.activeLayerIndex] = newLayer;
      const undoStack = [...state.undoStack, { layerIndex: state.activeLayerIndex, changes }];
      if (undoStack.length > 100) undoStack.shift();
      return {
        ...state,
        mapData: { ...state.mapData, layers: newLayers },
        undoStack,
        redoStack: [],
        dirty: true,
        selection: { x: toX, y: toY, width, height },
      };
    }
    case 'RENAME_TILESET': {
      if (!state.mapData) return state;
      const newTilesets = state.mapData.tilesets.map(ts =>
        ts.firstgid === action.firstgid ? { ...ts, name: action.name } : ts,
      );
      const newImages = { ...state.tilesetImages };
      if (newImages[action.firstgid]) {
        newImages[action.firstgid] = { ...newImages[action.firstgid], name: action.name };
      }
      return { ...state, mapData: { ...state.mapData, tilesets: newTilesets }, tilesetImages: newImages, dirty: true };
    }
    case 'REORDER_TILESETS': {
      if (!state.mapData) return state;
      const tilesets = [...state.mapData.tilesets];
      const fromIndex = tilesets.findIndex(ts => ts.firstgid === action.fromFirstgid);
      const toIndex = tilesets.findIndex(ts => ts.firstgid === action.toFirstgid);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return state;
      const [moved] = tilesets.splice(fromIndex, 1);
      tilesets.splice(toIndex, 0, moved);
      return {
        ...state,
        mapData: { ...state.mapData, tilesets },
        dirty: true,
      };
    }
    case 'REMOVE_UNUSED_TILESETS': {
      if (!state.mapData || action.firstgids.length === 0) return state;
      const removeSet = new Set(action.firstgids);
      const newTilesets = state.mapData.tilesets.filter(ts => !removeSet.has(ts.firstgid));
      const newImages = { ...state.tilesetImages };
      for (const fgid of action.firstgids) {
        delete newImages[fgid];
      }
      const sortedGids = Object.keys(newImages).map(Number).sort((a, b) => b - a);
      return {
        ...state,
        mapData: { ...state.mapData, tilesets: newTilesets },
        tilesetImages: newImages,
        sortedGids,
        dirty: true,
      };
    }
    default:
      return state;
  }
}

const initialState: EditorState = {
  projectName: 'Untitled Map',
  dirty: false,
  templateId: null,
  mapData: null,
  tilesetImages: {},
  activeLayerIndex: 0,
  tool: 'paint',
  selectedTileGid: 0,
  selectedRegion: null,
  zoom: 2,
  panX: 0,
  panY: 0,
  undoStack: [],
  redoStack: [],
  sortedGids: [],
  showGrid: true,
  showCollision: true,
  selection: null,
  clipboard: null,
};

export function useMapEditor() {
  const [state, dispatch] = useReducer(editorReducer, initialState);

  const findTileset = useCallback((gid: number): TilesetImageInfo | null => {
    for (const fgid of state.sortedGids) {
      if (gid >= fgid) return state.tilesetImages[fgid] ?? null;
    }
    return null;
  }, [state.sortedGids, state.tilesetImages]);

  return { state, dispatch, findTileset };
}
