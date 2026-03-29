'use client';

import { Button } from '@/components/ui';
import type { Tool } from './hooks/useMapEditor';

export interface ToolbarProps {
  activeTool: Tool;
  zoom: number;
  showGrid: boolean;
  showCollision: boolean;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  onToolChange: (tool: Tool) => void;
  onNewMap: () => void;
  onLoad: () => void;
  onSaveToDeskRPG: () => void;
  onExportTMJ: () => void;
  onExportTMX: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleGrid: () => void;
  onToggleCollision: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onHelp: () => void;
}

function ToolGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-2 border-r border-border last:border-r-0">
      {children}
    </div>
  );
}

export default function Toolbar({
  activeTool,
  zoom,
  showGrid,
  showCollision,
  canUndo,
  canRedo,
  dirty,
  onToolChange,
  onNewMap,
  onLoad,
  onSaveToDeskRPG,
  onExportTMJ,
  onExportTMX,
  onZoomIn,
  onZoomOut,
  onToggleGrid,
  onToggleCollision,
  onUndo,
  onRedo,
  onHelp,
}: ToolbarProps) {
  const toolBtn = (tool: Tool, label: string, shortcut: string) => (
    <Button
      variant={activeTool === tool ? 'primary' : 'ghost'}
      size="sm"
      onClick={() => onToolChange(tool)}
      title={`${label} (${shortcut})`}
    >
      {label} <span className="text-micro opacity-60">{shortcut}</span>
    </Button>
  );

  return (
    <div className="flex items-center h-10 bg-surface border-b border-border px-1 select-none flex-shrink-0">
      {/* Tools */}
      <ToolGroup>
        {toolBtn('paint', 'Paint', 'B')}
        {toolBtn('erase', 'Erase', 'E')}
        {toolBtn('pan', 'Pan', '⎵')}
      </ToolGroup>

      {/* File Operations */}
      <ToolGroup>
        <Button variant="ghost" size="sm" onClick={onNewMap} title="New Map (Ctrl+N)">
          New
        </Button>
        <Button variant="ghost" size="sm" onClick={onLoad} title="Load (Ctrl+O)">
          Load
        </Button>
        <Button variant="primary" size="sm" onClick={onSaveToDeskRPG} title="Save to DeskRPG (Ctrl+S)">
          {dirty ? '● Save' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onExportTMJ} title="Export .tmj">
          TMJ
        </Button>
        <Button variant="ghost" size="sm" onClick={onExportTMX} title="Export .tmx">
          TMX
        </Button>
      </ToolGroup>

      {/* Zoom Controls */}
      <ToolGroup>
        <Button variant="ghost" size="sm" onClick={onZoomOut} title="Zoom Out (-)">
          −
        </Button>
        <span className="text-caption text-text-secondary w-12 text-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="ghost" size="sm" onClick={onZoomIn} title="Zoom In (+)">
          +
        </Button>
      </ToolGroup>

      {/* Toggles */}
      <ToolGroup>
        <label className="flex items-center gap-1.5 cursor-pointer text-caption text-text-secondary hover:text-text transition-colors">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={onToggleGrid}
            className="accent-primary-light w-3 h-3"
          />
          Grid
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-caption text-text-secondary hover:text-text transition-colors">
          <input
            type="checkbox"
            checked={showCollision}
            onChange={onToggleCollision}
            className="accent-danger w-3 h-3"
          />
          Collision
        </label>
      </ToolGroup>

      {/* Undo / Redo */}
      <ToolGroup>
        <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          ↩
        </Button>
        <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
          ↪
        </Button>
      </ToolGroup>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Help */}
      <div className="px-2">
        <Button variant="ghost" size="sm" onClick={onHelp} title="Keyboard Shortcuts (?)">
          ?
        </Button>
      </div>
    </div>
  );
}
