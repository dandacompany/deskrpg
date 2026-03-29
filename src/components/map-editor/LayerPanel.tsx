'use client';

import { useState, useRef, useCallback } from 'react';
import { Button, Badge } from '@/components/ui';
import { isCoreLayer, getDeskRPGRole } from './hooks/useMapEditor';
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
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(layer.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isCore = isCoreLayer(layer);
  const role = getDeskRPGRole(layer, index, allLayers);

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
        ${isActive ? 'bg-primary-muted border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'}
      `.trim().replace(/\s+/g, ' ')}
      onClick={onSelect}
    >
      {/* Visibility toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility();
        }}
        className="text-body flex-shrink-0 w-4 text-center hover:text-text transition-colors"
        title={layer.visible ? 'Hide layer' : 'Show layer'}
      >
        <span className={layer.visible ? 'text-primary-light' : 'text-text-dim'}>
          {layer.visible ? '\u25C9' : '\u25CB'}
        </span>
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

      {/* Type badge */}
      <Badge variant="default" size="sm">
        {layer.type === 'tilelayer' ? 'tile' : 'obj'}
      </Badge>

      {/* DeskRPG role badge */}
      {role && (
        <span
          className={`text-micro font-bold px-1.5 py-0.5 rounded ${role.color}`}
          title={role.desc}
        >
          {role.label}
        </span>
      )}

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
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-title text-text">Layers</span>
        <Button variant="ghost" size="sm" onClick={onAddLayer} title="Add Layer">
          + Layer
        </Button>
      </div>

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
            onDragStart={handleDragStart(index)}
            onDragOver={handleDragOver}
            onDrop={handleDrop(index)}
          />
        ))}
      </div>
    </div>
  );
}
