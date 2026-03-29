'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button, Modal, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { createDefaultMap } from './hooks/useMapEditor';
import type { TiledMap } from './hooks/useMapEditor';

export interface NewMapModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (mapData: TiledMap, projectName: string) => void;
}

const TILE_SIZE = 32;
const MAX_COLS = 40;
const MAX_ROWS = 30;

const TEMPLATES = [
  { labelKey: 'mapEditor.newMap.templateSmall', width: 20, height: 15, desc: '640×480 px' },
  { labelKey: 'mapEditor.newMap.templateMedium', width: 30, height: 22, desc: '960×704 px' },
  { labelKey: 'mapEditor.newMap.templateLarge', width: 40, height: 30, desc: '1280×960 px' },
] as const;

// Grid cell size for the visual picker
const CELL = 12;
const GRID_COLS = MAX_COLS;
const GRID_ROWS = MAX_ROWS;

export default function NewMapModal({ open, onClose, onSubmit }: NewMapModalProps) {
  const t = useT();
  const [name, setName] = useState('Untitled Map');
  const [width, setWidth] = useState(20);
  const [height, setHeight] = useState(15);
  const [hoverW, setHoverW] = useState(0);
  const [hoverH, setHoverH] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setName('Untitled Map');
      setWidth(20);
      setHeight(15);
      setHoverW(0);
      setHoverH(0);
      setIsDragging(false);
    }
  }, [open]);

  const handleCreate = () => {
    const clampedW = Math.max(1, Math.min(MAX_COLS, width));
    const clampedH = Math.max(1, Math.min(MAX_ROWS, height));
    const mapData = createDefaultMap(name, clampedW, clampedH, TILE_SIZE);
    onSubmit(mapData, name);
    onClose();
  };

  const selectTemplate = (t: typeof TEMPLATES[number]) => {
    setWidth(t.width);
    setHeight(t.height);
  };

  // Grid coordinate from mouse
  const getGridCoord = useCallback((e: React.MouseEvent) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const col = Math.max(1, Math.min(GRID_COLS, Math.ceil((e.clientX - rect.left) / CELL)));
    const row = Math.max(1, Math.min(GRID_ROWS, Math.ceil((e.clientY - rect.top) / CELL)));
    return { col, row };
  }, []);

  const handleGridMouseDown = useCallback((e: React.MouseEvent) => {
    const coord = getGridCoord(e);
    if (!coord) return;
    setIsDragging(true);
    setWidth(coord.col);
    setHeight(coord.row);
  }, [getGridCoord]);

  const handleGridMouseMove = useCallback((e: React.MouseEvent) => {
    const coord = getGridCoord(e);
    if (!coord) return;
    setHoverW(coord.col);
    setHoverH(coord.row);
    if (isDragging) {
      setWidth(coord.col);
      setHeight(coord.row);
    }
  }, [getGridCoord, isDragging]);

  const handleGridMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleGridMouseLeave = useCallback(() => {
    setHoverW(0);
    setHoverH(0);
    setIsDragging(false);
  }, []);

  const displayW = isDragging ? width : (hoverW || width);
  const displayH = isDragging ? height : (hoverH || height);

  return (
    <Modal open={open} onClose={onClose} title={t("mapEditor.newMap.title")} size="md">
      <Modal.Body>
        <div className="space-y-4">
          {/* Project Name */}
          <div>
            <label className="text-caption text-text-secondary block mb-1">{t("mapEditor.newMap.projectName")}</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mapEditor.newMap.namePlaceholder")} />
          </div>

          {/* Templates */}
          <div>
            <label className="text-caption text-text-secondary block mb-2">{t("mapEditor.newMap.template")}</label>
            <div className="flex gap-2">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.labelKey}
                  onClick={() => selectTemplate(tpl)}
                  className={`flex-1 px-3 py-2 rounded-lg border text-center transition-colors ${
                    width === tpl.width && height === tpl.height
                      ? 'border-primary-light bg-primary-muted text-text'
                      : 'border-border bg-surface-raised text-text-secondary hover:border-text-dim'
                  }`}
                >
                  <div className="text-caption font-semibold">{t(tpl.labelKey)}</div>
                  <div className="text-micro text-text-dim">{tpl.width}×{tpl.height}</div>
                  <div className="text-micro text-text-dim">{tpl.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom size: Grid picker + number inputs */}
          <div>
            <label className="text-caption text-text-secondary block mb-2">
              {t("mapEditor.newMap.customSize")} — <span className="text-text">{displayW} × {displayH}</span>
              <span className="text-text-dim ml-2">({displayW * TILE_SIZE}×{displayH * TILE_SIZE} px)</span>
            </label>

            {/* Grid visual picker */}
            <div
              ref={gridRef}
              className="relative border border-border rounded bg-bg-deep cursor-crosshair select-none overflow-hidden"
              style={{ width: GRID_COLS * CELL, height: GRID_ROWS * CELL }}
              onMouseDown={handleGridMouseDown}
              onMouseMove={handleGridMouseMove}
              onMouseUp={handleGridMouseUp}
              onMouseLeave={handleGridMouseLeave}
            >
              {/* Selected area */}
              <div
                className="absolute top-0 left-0 bg-primary/20 border border-primary-light/50"
                style={{ width: width * CELL, height: height * CELL }}
              />
              {/* Hover preview */}
              {hoverW > 0 && !isDragging && (
                <div
                  className="absolute top-0 left-0 border border-dashed border-text-dim/40"
                  style={{ width: hoverW * CELL, height: hoverH * CELL }}
                />
              )}
              {/* Grid lines (every 5) */}
              {Array.from({ length: Math.floor(GRID_COLS / 5) }, (_, i) => (
                <div
                  key={`v${i}`}
                  className="absolute top-0 bottom-0 border-l border-border/30"
                  style={{ left: (i + 1) * 5 * CELL }}
                />
              ))}
              {Array.from({ length: Math.floor(GRID_ROWS / 5) }, (_, i) => (
                <div
                  key={`h${i}`}
                  className="absolute left-0 right-0 border-t border-border/30"
                  style={{ top: (i + 1) * 5 * CELL }}
                />
              ))}
              {/* Size label in center of selected area */}
              <div
                className="absolute flex items-center justify-center pointer-events-none"
                style={{ width: width * CELL, height: height * CELL }}
              >
                <span className="text-micro text-primary-light font-semibold bg-bg/80 px-1 rounded">
                  {width}×{height}
                </span>
              </div>
            </div>

            {/* Number inputs */}
            <div className="flex gap-3 mt-2">
              <div className="flex-1">
                <label className="text-micro text-text-dim block mb-0.5">{t("mapEditor.newMap.width")}</label>
                <Input
                  type="number"
                  value={width}
                  onChange={(e) => setWidth(Math.max(1, Math.min(MAX_COLS, Number(e.target.value))))}
                  min={1}
                  max={MAX_COLS}
                />
              </div>
              <div className="flex-1">
                <label className="text-micro text-text-dim block mb-0.5">{t("mapEditor.newMap.height")}</label>
                <Input
                  type="number"
                  value={height}
                  onChange={(e) => setHeight(Math.max(1, Math.min(MAX_ROWS, Number(e.target.value))))}
                  min={1}
                  max={MAX_ROWS}
                />
              </div>
            </div>
          </div>
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={handleCreate}>
          {t("common.create")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
