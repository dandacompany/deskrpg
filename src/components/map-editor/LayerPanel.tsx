'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui';
import { Eye, EyeOff, GripVertical, User } from 'lucide-react';
import {
  isCoreLayer,
  getDeskRPGRole,
  getLayerColor,
  getLayerDepth,
  getDepthLabel,
  CHARACTER_DEPTH_THRESHOLD,
} from './hooks/useMapEditor';
import Tooltip from './Tooltip';
import { useT } from '@/lib/i18n';
import type { TiledLayer } from './hooks/useMapEditor';

export interface LayerPanelProps {
  layers: TiledLayer[];
  activeLayerIndex: number;
  onSelectLayer: (index: number) => void;
  onRenameLayer: (index: number, name: string) => void;
  onDeleteLayer: (index: number) => void;
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onSetLayerDepth?: (index: number, depth: number | string) => void;
  onAddLayer: () => void;
  onToggleVisibility: (index: number) => void;
  layerOverlayMap?: Record<number, boolean>;
  onToggleLayerOverlay?: (index: number) => void;
  hideHeader?: boolean;
}

/** A single sorted entry mapping visual position to original array index */
interface SortedEntry {
  layer: TiledLayer;
  originalIndex: number;
  depth: number;
}

function LayerItem({
  layer,
  originalIndex,
  isActive,
  allLayers,
  depthLabel,
  onSelect,
  onRename,
  onDelete,
  onToggleVisibility,
  showOverlay = true,
  onToggleOverlay,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  layer: TiledLayer;
  originalIndex: number;
  isActive: boolean;
  allLayers: TiledLayer[];
  depthLabel: string;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleVisibility: () => void;
  showOverlay?: boolean;
  onToggleOverlay?: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(layer.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isCore = isCoreLayer(layer);
  const role = getDeskRPGRole(layer, originalIndex, allLayers);
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

  const tooltipLabel = role
    ? `${layer.type === 'tilelayer' ? t('mapEditor.layers.tileLayerType') : t('mapEditor.layers.objectLayerType')} · ${t(role.descKey)}`
    : layer.type === 'tilelayer' ? t('mapEditor.layers.tileLayerType') : t('mapEditor.layers.objectLayerType');

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={`
        group flex items-center gap-1 px-1 py-1.5 rounded-md cursor-pointer transition-colors
        ${isActive ? 'border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'}
      `.trim().replace(/\s+/g, ' ')}
      style={{ backgroundColor: isActive ? layerColor.overlay : undefined }}
      onClick={onSelect}
    >
      {/* Drag handle */}
      <span className="flex-shrink-0 cursor-grab active:cursor-grabbing text-text-dim hover:text-text-secondary">
        <GripVertical className="w-3.5 h-3.5" />
      </span>

      {/* Visibility toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility();
        }}
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-surface-raised transition-colors"
      >
        {layer.visible ? (
          <Eye className="w-3.5 h-3.5 text-primary-light" />
        ) : (
          <EyeOff className="w-3.5 h-3.5 text-text-dim" />
        )}
      </button>

      {/* Layer name with tooltip */}
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
          <Tooltip label={tooltipLabel} shortcut={depthLabel}>
            <span
              className="text-caption text-text truncate block"
              onDoubleClick={handleDoubleClick}
            >
              {layer.name}
            </span>
          </Tooltip>
        )}
      </div>

      {/* Color chip */}
      <Tooltip label={showOverlay ? t('mapEditor.layers.hideOverlay') : t('mapEditor.layers.showOverlay')}>
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
          title={t('mapEditor.layers.deleteLayer')}
        >
          &times;
        </button>
      )}
    </div>
  );
}

/** Character divider line */
function CharacterDivider({ isDragOver, onDragOver, onDrop }: {
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const t = useT();

  return (
    <div
      className={`
        flex items-center gap-2 px-2 py-1 my-0.5 transition-colors
        ${isDragOver ? 'bg-primary-light/10' : ''}
      `.trim().replace(/\s+/g, ' ')}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex-1 border-t border-border" />
      <div className="flex items-center gap-1 text-micro text-text-dim select-none whitespace-nowrap">
        <User className="w-3 h-3" />
        <span>{t("mapEditor.layers.characterNpcDivider")}</span>
      </div>
      <div className="flex-1 border-t border-border" />
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
  onSetLayerDepth,
  onAddLayer,
  onToggleVisibility,
  layerOverlayMap,
  onToggleLayerOverlay,
  hideHeader,
}: LayerPanelProps) {
  const t = useT();
  const dragVisualIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragOverDivider, setDragOverDivider] = useState(false);

  // Sort layers by depth descending (highest depth at top = renders on top)
  const sortedEntries: SortedEntry[] = useMemo(() => {
    return layers
      .map((layer, originalIndex) => ({
        layer,
        originalIndex,
        depth: getLayerDepth(layer),
      }))
      .sort((a, b) => b.depth - a.depth);
  }, [layers]);

  // Find where the character divider goes (between above-char and below-char layers)
  const dividerVisualIndex = useMemo(() => {
    const idx = sortedEntries.findIndex((e) => e.depth < CHARACTER_DEPTH_THRESHOLD);
    return idx === -1 ? sortedEntries.length : idx;
  }, [sortedEntries]);

  const handleDragStart = useCallback(
    (visualIndex: number) => (e: React.DragEvent) => {
      dragVisualIndexRef.current = visualIndex;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(visualIndex));
    },
    [],
  );

  const handleDragOver = useCallback(
    (visualIndex: number) => (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverIndex(visualIndex);
      setDragOverDivider(false);
    },
    [],
  );

  const handleDragOverDivider = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverDivider(true);
    setDragOverIndex(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragVisualIndexRef.current = null;
    setDragOverIndex(null);
    setDragOverDivider(false);
  }, []);

  const handleDrop = useCallback(
    (toVisualIndex: number) => (e: React.DragEvent) => {
      e.preventDefault();
      const fromVisualIndex = dragVisualIndexRef.current;
      if (fromVisualIndex === null || fromVisualIndex === toVisualIndex) {
        handleDragEnd();
        return;
      }

      const fromOriginal = sortedEntries[fromVisualIndex].originalIndex;
      const toOriginal = sortedEntries[toVisualIndex].originalIndex;
      const fromDepth = sortedEntries[fromVisualIndex].depth;
      const toDepth = sortedEntries[toVisualIndex].depth;

      // Check if crossing the character divider
      const fromAbove = fromDepth >= CHARACTER_DEPTH_THRESHOLD;
      const toAbove = toDepth >= CHARACTER_DEPTH_THRESHOLD;

      if (fromAbove !== toAbove && onSetLayerDepth) {
        // Crossed the divider — update depth
        if (toAbove) {
          // Moving to above character: set depth to 10000 + offset
          onSetLayerDepth(fromOriginal, CHARACTER_DEPTH_THRESHOLD);
        } else {
          // Moving to below character: set depth based on target neighbors
          const neighborDepth = toDepth;
          onSetLayerDepth(fromOriginal, Math.max(0, neighborDepth));
        }
      }

      onReorderLayers(fromOriginal, toOriginal);
      handleDragEnd();
    },
    [sortedEntries, onReorderLayers, onSetLayerDepth, handleDragEnd],
  );

  const handleDropOnDivider = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const fromVisualIndex = dragVisualIndexRef.current;
      if (fromVisualIndex === null) {
        handleDragEnd();
        return;
      }

      const entry = sortedEntries[fromVisualIndex];
      const fromAbove = entry.depth >= CHARACTER_DEPTH_THRESHOLD;

      if (onSetLayerDepth) {
        if (fromAbove) {
          // Was above, dropping on divider = move just below character
          onSetLayerDepth(entry.originalIndex, CHARACTER_DEPTH_THRESHOLD - 1);
        } else {
          // Was below, dropping on divider = move just above character
          onSetLayerDepth(entry.originalIndex, CHARACTER_DEPTH_THRESHOLD);
        }
      }

      handleDragEnd();
    },
    [sortedEntries, onSetLayerDepth, handleDragEnd],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
          <span className="text-title text-text">{t('mapEditor.layers.title')}</span>
          <Button variant="ghost" size="sm" onClick={onAddLayer} title={t('mapEditor.layers.addLayerTooltip')}>
            {t('mapEditor.layers.addLayer')}
          </Button>
        </div>
      )}

      {/* Layer list sorted by depth with character divider */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
        {sortedEntries.map((entry, visualIndex) => {
          const showDividerBefore = visualIndex === dividerVisualIndex;

          return (
            <div key={entry.layer.id}>
              {showDividerBefore && (
                <CharacterDivider
                  isDragOver={dragOverDivider}
                  onDragOver={handleDragOverDivider}
                  onDrop={handleDropOnDivider}
                />
              )}
              <LayerItem
                layer={entry.layer}
                originalIndex={entry.originalIndex}
                isActive={entry.originalIndex === activeLayerIndex}
                allLayers={layers}
                depthLabel={getDepthLabel(entry.layer)}
                onSelect={() => onSelectLayer(entry.originalIndex)}
                onRename={(name) => onRenameLayer(entry.originalIndex, name)}
                onDelete={() => onDeleteLayer(entry.originalIndex)}
                onToggleVisibility={() => onToggleVisibility(entry.originalIndex)}
                showOverlay={layerOverlayMap?.[entry.originalIndex] ?? true}
                onToggleOverlay={() => onToggleLayerOverlay?.(entry.originalIndex)}
                onDragStart={handleDragStart(visualIndex)}
                onDragOver={handleDragOver(visualIndex)}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop(visualIndex)}
              />
            </div>
          );
        })}
        {/* Divider at end if all layers are above character */}
        {dividerVisualIndex === sortedEntries.length && (
          <CharacterDivider
            isDragOver={dragOverDivider}
            onDragOver={handleDragOverDivider}
            onDrop={handleDropOnDivider}
          />
        )}
      </div>
    </div>
  );
}
