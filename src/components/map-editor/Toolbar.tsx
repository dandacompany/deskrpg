'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui';
import { Undo2, Redo2, HelpCircle, ChevronDown } from 'lucide-react';
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
  sectionVisibility: Record<string, boolean>;
  onToggleSection: (id: string) => void;
}

function ToolGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 px-2 border-r border-border last:border-r-0">
      {children}
    </div>
  );
}

function Dropdown({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
        {label}
        <ChevronDown className="w-3 h-3 ml-0.5 opacity-60" />
      </Button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 min-w-[160px] py-1"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  onClick,
  shortcut,
  children,
}: {
  onClick: () => void;
  shortcut?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-raised hover:text-text transition-colors"
    >
      <span>{children}</span>
      {shortcut && <span className="text-micro text-text-dim ml-4">{shortcut}</span>}
    </button>
  );
}

function DropdownToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className="w-full flex items-center justify-between px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-raised hover:text-text transition-colors"
    >
      <span>{children}</span>
      <span className={`text-micro ${checked ? 'text-primary-light' : 'text-text-dim'}`}>
        {checked ? '✓' : ''}
      </span>
    </button>
  );
}

function DropdownSeparator() {
  return <div className="my-1 border-t border-border" />;
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
  sectionVisibility,
  onToggleSection,
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
      {/* File Menu */}
      <ToolGroup>
        <Dropdown label={<>{dirty && <span className="text-warning mr-1">●</span>}File</>}>
          <DropdownItem onClick={onNewMap} shortcut="⌘N">New Map</DropdownItem>
          <DropdownItem onClick={onLoad} shortcut="⌘O">Open</DropdownItem>
          <DropdownItem onClick={onSaveToDeskRPG} shortcut="⌘S">Save</DropdownItem>
          <DropdownSeparator />
          <DropdownItem onClick={onExportTMJ}>Export .tmj</DropdownItem>
          <DropdownItem onClick={onExportTMX}>Export .tmx</DropdownItem>
        </Dropdown>

        {/* View Menu */}
        <Dropdown label="View">
          <DropdownToggle checked={showGrid} onChange={onToggleGrid}>Grid</DropdownToggle>
          <DropdownToggle checked={showCollision} onChange={onToggleCollision}>Collision</DropdownToggle>
          <DropdownSeparator />
          <DropdownToggle checked={sectionVisibility['layers'] !== false} onChange={() => onToggleSection('layers')}>Layers Panel</DropdownToggle>
          <DropdownToggle checked={sectionVisibility['tilesets'] !== false} onChange={() => onToggleSection('tilesets')}>Tilesets Panel</DropdownToggle>
          <DropdownToggle checked={sectionVisibility['minimap'] !== false} onChange={() => onToggleSection('minimap')}>Minimap Panel</DropdownToggle>
        </Dropdown>
      </ToolGroup>

      {/* Tools */}
      <ToolGroup>
        {toolBtn('paint', 'Paint', 'B')}
        {toolBtn('erase', 'Erase', 'E')}
        {toolBtn('select', 'Select', 'S')}
        {toolBtn('pan', 'Pan', 'P')}
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

      {/* Undo / Redo */}
      <ToolGroup>
        <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo} title="Redo (⌘⇧Z)">
          <Redo2 className="w-4 h-4" />
        </Button>
      </ToolGroup>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Help */}
      <div className="px-2">
        <Button variant="ghost" size="sm" onClick={onHelp} title="Keyboard Shortcuts (?)">
          <HelpCircle className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
