'use client';

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui';
import { Info, Eye, EyeOff } from 'lucide-react';
import { isCoreLayer, getDeskRPGRole, getLayerColor } from './hooks/useMapEditor';
import Tooltip from './Tooltip';
import type { TiledLayer } from './hooks/useMapEditor';

export interface LayerPanelProps {
  layers: TiledLayer[];
  activeLayerIndex: number;
  onSelectLayer: (index: number) => void;
  onRenameLayer: (index: number, name: string) => void;
  onDeleteLayer: (index: number) => void;
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onAddLayer: () => void;
  onToggleVisibility: (index: number) => void;
  layerOverlayMap?: Record<number, boolean>;
  onToggleLayerOverlay?: (index: number) => void;
  hideHeader?: boolean;
}

function LayerItem({
  layer,
  index,
  isActive,
  allLayers,
  onSelect,
  onRename,
  onDelete,
  onToggleVisibility,
  showOverlay = true,
  onToggleOverlay,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  layer: TiledLayer;
  index: number;
  isActive: boolean;
  allLayers: TiledLayer[];
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleVisibility: () => void;
  showOverlay?: boolean;
  onToggleOverlay?: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(layer.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isCore = isCoreLayer(layer);
  const role = getDeskRPGRole(layer, index, allLayers);

  const layerColor = getLayerColor(layer);

  const handleDoubleClick = useCallback(() => {
    setEditName(layer.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [layer.name]);

  const commitRename = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== layer.name) {
      onRename(trimmed);
    }
    setEditing(false);
  }, [editName, layer.name, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') commitRename();
      if (e.key === 'Escape') setEditing(false);
    },
    [commitRename],
  );

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`
        group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors
        ${isActive ? 'border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'}
      `.trim().replace(/\s+/g, ' ')}
      style={{ backgroundColor: isActive ? layerColor.overlay : undefined }}
      onClick={onSelect}
    >
      {/* Visibility toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility();
        }}
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-surface-raised transition-colors"
        title={layer.visible ? 'Hide layer' : 'Show layer'}
      >
        {layer.visible ? (
          <Eye className="w-3.5 h-3.5 text-primary-light" />
        ) : (
          <EyeOff className="w-3.5 h-3.5 text-text-dim" />
        )}
      </button>

      {/* Layer name */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-surface text-caption text-text px-1 py-0.5 rounded border border-border outline-none focus:border-primary-light"
          />
        ) : (
          <span
            className="text-caption text-text truncate block"
            onDoubleClick={handleDoubleClick}
            title="Double-click to rename"
          >
            {layer.name}
          </span>
        )}
      </div>

      {/* Info tooltip — right after name */}
      {role && (
        <Tooltip label={`${layer.type === 'tilelayer' ? 'Tile' : 'Object'} · ${role.desc}`} shortcut={role.label}>
          <span className="cursor-default flex-shrink-0">
            <Info className="w-3.5 h-3.5 text-text-dim hover:text-text-secondary" />
          </span>
        </Tooltip>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Color chip — click to toggle overlay (right side) */}
      <Tooltip label={showOverlay ? 'Hide layer overlay' : 'Show layer overlay'}>
        <button
          className="w-2.5 h-2.5 rounded-sm flex-shrink-0 transition-opacity"
          style={{
            backgroundColor: layerColor.solid,
            opacity: showOverlay ? 1 : 0.25,
          }}
          onClick={(e) => { e.stopPropagation(); onToggleOverlay?.(); }}
        />
      </Tooltip>

      {/* Delete button (hidden for core layers) */}
      {!isCore && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-text-dim hover:text-danger text-body opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
          title="Delete layer"
        >
          &times;
        </button>
      )}
    </div>
  );
}

export default function LayerPanel({
  layers,
  activeLayerIndex,
  onSelectLayer,
  onRenameLayer,
  onDeleteLayer,
  onReorderLayers,
  onAddLayer,
  onToggleVisibility,
  layerOverlayMap,
  onToggleLayerOverlay,
  hideHeader,
}: LayerPanelProps) {
  const dragIndexRef = useRef<number | null>(null);

  const handleDragStart = useCallback((index: number) => (e: React.DragEvent) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (toIndex: number) => (e: React.DragEvent) => {
      e.preventDefault();
      const fromIndex = dragIndexRef.current;
      if (fromIndex !== null && fromIndex !== toIndex) {
        onReorderLayers(fromIndex, toIndex);
      }
      dragIndexRef.current = null;
    },
    [onReorderLayers],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
          <span className="text-title text-text">Layers</span>
          <Button variant="ghost" size="sm" onClick={onAddLayer} title="Add Layer">
            + Layer
          </Button>
        </div>
      )}

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
        {layers.map((layer, index) => (
          <LayerItem
            key={layer.id}
            layer={layer}
            index={index}
            isActive={index === activeLayerIndex}
            allLayers={layers}
            onSelect={() => onSelectLayer(index)}
            onRename={(name) => onRenameLayer(index, name)}
            onDelete={() => onDeleteLayer(index)}
            onToggleVisibility={() => onToggleVisibility(index)}
            showOverlay={layerOverlayMap?.[index] ?? true}
            onToggleOverlay={() => onToggleLayerOverlay?.(index)}
            onDragStart={handleDragStart(index)}
            onDragOver={handleDragOver}
            onDrop={handleDrop(index)}
          />
        ))}
      </div>
    </div>
  );
}
