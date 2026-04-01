'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui';
import { Undo2, Redo2, HelpCircle, ChevronDown, Paintbrush, Eraser, MousePointer2, Move, Home, Globe, Save, ArrowLeft } from 'lucide-react';
import Tooltip from './Tooltip';
import type { Tool } from './hooks/useMapEditor';
import { useT, useLocale, LOCALES } from '@/lib/i18n';

export interface ToolbarProps {
  activeTool: Tool;
  zoom: number;
  showGrid: boolean;
  showCollision: boolean;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  projectName?: string;
  onProjectNameChange?: (name: string) => void;
  onToolChange: (tool: Tool) => void;
  onNewMap: () => void;
  onLoad: () => void;
  onSaveToDeskRPG: () => void;
  onSaveAs?: () => void;
  onExportTMJ: () => void;
  onExportTMX: () => void;
  onExportPNG: () => void;
  onSaveAsTemplate?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleGrid: () => void;
  onToggleCollision: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onHelp: () => void;
  onGoBack: () => void;
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
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = () => setOpen(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
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

function DropdownSubmenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="w-full flex items-center justify-between px-3 py-1.5 text-caption text-text-secondary hover:bg-surface-raised hover:text-text transition-colors cursor-default">
        <span>{label}</span>
        <ChevronDown className="w-3 h-3 -rotate-90" />
      </div>
      {open && (
        <div className="absolute left-full top-0 ml-0.5 bg-surface border border-border rounded-lg shadow-xl z-50 min-w-[130px] py-1">
          {children}
        </div>
      )}
    </div>
  );
}

function LocaleDropdown() {
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = () => setOpen(false);
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const current = LOCALES.find((l) => l.code === locale);

  return (
    <div ref={ref} className="relative">
      <Tooltip label={current?.label ?? 'Language'}>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          <Globe className="w-4 h-4" />
        </Button>
      </Tooltip>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl z-50 min-w-[120px] py-1">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code); setOpen(false); }}
              className={`w-full flex items-center px-3 py-1.5 text-caption transition-colors ${
                l.code === locale
                  ? 'text-primary-light bg-surface-raised'
                  : 'text-text-secondary hover:bg-surface-raised hover:text-text'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
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
  projectName,
  onProjectNameChange,
  onToolChange,
  onNewMap,
  onLoad,
  onSaveToDeskRPG,
  onSaveAs,
  onExportTMJ,
  onExportTMX,
  onExportPNG,
  onSaveAsTemplate,
  onZoomIn,
  onZoomOut,
  onToggleGrid,
  onToggleCollision,
  onUndo,
  onRedo,
  onHelp,
  onGoBack,
  sectionVisibility,
  onToggleSection,
}: ToolbarProps) {
  const t = useT();
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const startEditName = () => {
    if (!onProjectNameChange || !projectName) return;
    setEditNameValue(projectName);
    setEditingName(true);
  };

  const commitEditName = () => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== projectName) {
      onProjectNameChange?.(trimmed);
    }
    setEditingName(false);
  };

  const cancelEditName = () => {
    setEditingName(false);
  };

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  const tools: Array<{ tool: Tool; icon: React.ReactNode; label: string; shortcut: string }> = [
    { tool: 'paint', icon: <Paintbrush className="w-4 h-4" />, label: t('mapEditor.toolbar.paint'), shortcut: 'B' },
    { tool: 'erase', icon: <Eraser className="w-4 h-4" />, label: t('mapEditor.toolbar.erase'), shortcut: 'E' },
    { tool: 'select', icon: <MousePointer2 className="w-4 h-4" />, label: t('mapEditor.toolbar.select'), shortcut: 'S' },
    { tool: 'pan', icon: <Move className="w-4 h-4" />, label: t('mapEditor.toolbar.pan'), shortcut: 'P' },
  ];

  return (
    <div className="flex items-center h-10 bg-surface border-b border-border px-1 select-none flex-shrink-0">
      {/* Title */}
      <div className="px-3 flex items-center gap-2">
        <span className="text-body font-bold text-primary-light tracking-wide select-none">{t('mapEditor.toolbar.title')}</span>
        {projectName && (
          editingName ? (
            <input
              ref={nameInputRef}
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              onBlur={commitEditName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitEditName(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelEditName(); }
              }}
              className="text-sm font-medium text-white bg-surface border border-primary-light/50 rounded px-1.5 py-0 h-6 outline-none focus:border-primary-light min-w-0 w-40"
              style={{ maxWidth: 240 }}
            />
          ) : (
            <>
              <span className="text-text-muted text-sm select-none">·</span>
              <span
                className="text-sm font-medium text-text-muted hover:text-white cursor-pointer select-none transition-colors"
                onDoubleClick={startEditName}
                title={t("common.renameOnDoubleClick")}
              >
                {projectName}{dirty ? ' *' : ''}
              </span>
            </>
          )
        )}
      </div>

      {/* File Menu */}
      <ToolGroup>
        <Dropdown label={t('mapEditor.toolbar.file')}>
          <DropdownItem onClick={onNewMap} shortcut="⌘N">{t('mapEditor.project.newProject')}</DropdownItem>
          <DropdownItem onClick={onLoad} shortcut="⌘O">{t('mapEditor.project.openProject')}</DropdownItem>
          <DropdownItem onClick={onSaveToDeskRPG} shortcut="⌘S">{t('common.save')}</DropdownItem>
          <DropdownItem onClick={() => { onSaveAs?.(); }}>{t('mapEditor.project.saveAs')}</DropdownItem>
          <DropdownSeparator />
          <DropdownSubmenu label={t('mapEditor.toolbar.export')}>
            <DropdownItem onClick={onExportTMJ}>{t('mapEditor.toolbar.exportTmj')}</DropdownItem>
            <DropdownItem onClick={onExportTMX}>{t('mapEditor.toolbar.exportTmx')}</DropdownItem>
            <DropdownItem onClick={onExportPNG}>{t('mapEditor.toolbar.exportPng')}</DropdownItem>
          </DropdownSubmenu>
          {onSaveAsTemplate && (
            <>
              <DropdownSeparator />
              <DropdownItem onClick={onSaveAsTemplate}>{t('mapEditor.toolbar.saveAsTemplate')}</DropdownItem>
            </>
          )}
          <DropdownSeparator />
          <DropdownItem onClick={onGoBack}>{t('mapEditor.toolbar.backToDeskRPG')}</DropdownItem>
        </Dropdown>

        {/* View Menu */}
        <Dropdown label={t('mapEditor.toolbar.view')}>
          <DropdownToggle checked={showGrid} onChange={onToggleGrid}>{t('mapEditor.toolbar.grid')}</DropdownToggle>
          <DropdownToggle checked={showCollision} onChange={onToggleCollision}>{t('mapEditor.toolbar.collision')}</DropdownToggle>
          <DropdownSeparator />
          <DropdownToggle checked={sectionVisibility['layers'] !== false} onChange={() => onToggleSection('layers')}>{t('mapEditor.toolbar.layersPanel')}</DropdownToggle>
          <DropdownToggle checked={sectionVisibility['tilesets'] !== false} onChange={() => onToggleSection('tilesets')}>{t('mapEditor.toolbar.tilesetsPanel')}</DropdownToggle>
          <DropdownToggle checked={sectionVisibility['stamps'] !== false} onChange={() => onToggleSection('stamps')}>{t('mapEditor.toolbar.stampsPanel')}</DropdownToggle>
          <DropdownToggle checked={sectionVisibility['minimap'] !== false} onChange={() => onToggleSection('minimap')}>{t('mapEditor.toolbar.minimapPanel')}</DropdownToggle>
        </Dropdown>
      </ToolGroup>

      {/* Tools */}
      <ToolGroup>
        {tools.map(({ tool, icon, label, shortcut }) => (
          <Tooltip key={tool} label={label} shortcut={shortcut}>
            <Button
              variant={activeTool === tool ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => onToolChange(tool)}
            >
              {icon}
            </Button>
          </Tooltip>
        ))}
      </ToolGroup>

      {/* Zoom Controls */}
      <ToolGroup>
        <Tooltip label={t('mapEditor.toolbar.zoomOut')} shortcut="−">
          <Button variant="ghost" size="sm" onClick={onZoomOut}>−</Button>
        </Tooltip>
        <span className="text-caption text-text-secondary w-12 text-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip label={t('mapEditor.toolbar.zoomIn')} shortcut="+">
          <Button variant="ghost" size="sm" onClick={onZoomIn}>+</Button>
        </Tooltip>
      </ToolGroup>

      {/* Undo / Redo */}
      <ToolGroup>
        <Tooltip label={t('mapEditor.toolbar.undo')} shortcut="⌘Z">
          <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo}>
            <Undo2 className="w-4 h-4" />
          </Button>
        </Tooltip>
        <Tooltip label={t('mapEditor.toolbar.redo')} shortcut="⌘⇧Z">
          <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo}>
            <Redo2 className="w-4 h-4" />
          </Button>
        </Tooltip>
      </ToolGroup>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Save, Help, Language & Back */}
      <div className="px-2 flex items-center gap-1">
        <Tooltip label={`${t('common.save')} (⌘S)`}>
          <div className="relative">
            <Button variant="ghost" size="sm" onClick={onSaveToDeskRPG}>
              <Save className="w-4 h-4" />
            </Button>
            {dirty && (
              <span className="absolute top-0.5 left-0.5 w-2 h-2 rounded-full bg-primary" />
            )}
          </div>
        </Tooltip>
        <Tooltip label={t('mapEditor.toolbar.keyboardShortcuts')} shortcut="?">
          <Button variant="ghost" size="sm" onClick={onHelp}>
            <HelpCircle className="w-4 h-4" />
          </Button>
        </Tooltip>
        <LocaleDropdown />
        <Tooltip label={t('mapEditor.toolbar.backToDeskRPG')}>
          <Button variant="ghost" size="sm" onClick={onGoBack}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
