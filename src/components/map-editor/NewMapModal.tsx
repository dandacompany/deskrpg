'use client';

import { useState, useEffect } from 'react';
import { Button, Modal, Input } from '@/components/ui';
import { createDefaultMap } from './hooks/useMapEditor';
import type { TiledMap } from './hooks/useMapEditor';

export interface NewMapModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (mapData: TiledMap, projectName: string) => void;
}

export default function NewMapModal({ open, onClose, onSubmit }: NewMapModalProps) {
  const [name, setName] = useState('Untitled Map');
  const [width, setWidth] = useState(20);
  const [height, setHeight] = useState(15);
  const [tileSize, setTileSize] = useState(32);

  // Reset defaults when modal opens
  useEffect(() => {
    if (open) {
      setName('Untitled Map');
      setWidth(20);
      setHeight(15);
      setTileSize(32);
    }
  }, [open]);

  const handleCreate = () => {
    const clampedW = Math.max(10, Math.min(40, width));
    const clampedH = Math.max(8, Math.min(30, height));
    const mapData = createDefaultMap(name, clampedW, clampedH, tileSize);
    onSubmit(mapData, name);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="New Map" size="sm">
      <Modal.Body>
        <div className="space-y-3">
          <div>
            <label className="text-caption text-text-secondary block mb-1">Project Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Map name" />
          </div>
          <div>
            <label className="text-caption text-text-secondary block mb-1">Width (10-40 tiles)</label>
            <Input
              type="number"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              min={10}
              max={40}
            />
          </div>
          <div>
            <label className="text-caption text-text-secondary block mb-1">Height (8-30 tiles)</label>
            <Input
              type="number"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              min={8}
              max={30}
            />
          </div>
          <div>
            <label className="text-caption text-text-secondary block mb-1">Tile Size (px)</label>
            <Input
              type="number"
              value={tileSize}
              onChange={(e) => setTileSize(Math.max(8, Number(e.target.value)))}
              min={8}
            />
          </div>
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleCreate}>
          Create
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
