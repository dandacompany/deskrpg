'use client';

import { Modal } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  descKey: string;
}

interface ShortcutSection {
  titleKey: string;
  shortcuts: Shortcut[];
}

const SECTIONS: ShortcutSection[] = [
  {
    titleKey: 'mapEditor.help.sectionFile',
    shortcuts: [
      { keys: ['Ctrl', 'N'], descKey: 'mapEditor.help.newMap' },
      { keys: ['Ctrl', 'O'], descKey: 'mapEditor.help.loadMap' },
      { keys: ['Ctrl', 'S'], descKey: 'mapEditor.help.saveToDeskrpg' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionTools',
    shortcuts: [
      { keys: ['B'], descKey: 'mapEditor.help.paintBrush' },
      { keys: ['E'], descKey: 'mapEditor.help.eraser' },
      { keys: ['S'], descKey: 'mapEditor.help.selectTool' },
      { keys: ['Space'], descKey: 'mapEditor.help.holdToPan' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionView',
    shortcuts: [
      { keys: ['G'], descKey: 'mapEditor.help.toggleGrid' },
      { keys: ['+'], descKey: 'mapEditor.help.zoomIn' },
      { keys: ['-'], descKey: 'mapEditor.help.zoomOut' },
      { keys: ['0'], descKey: 'mapEditor.help.resetZoom' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionEdit',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], descKey: 'mapEditor.help.undo' },
      { keys: ['Ctrl', 'Y'], descKey: 'mapEditor.help.redo' },
      { keys: ['Ctrl', 'C'], descKey: 'mapEditor.help.copyTiles' },
      { keys: ['Ctrl', 'V'], descKey: 'mapEditor.help.paste' },
      { keys: ['Backspace'], descKey: 'mapEditor.help.deleteSelectedTiles' },
      { keys: ['Escape'], descKey: 'mapEditor.help.clearSelection' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionLayers',
    shortcuts: [
      { keys: ['['], descKey: 'mapEditor.help.selectLayerAbove' },
      { keys: [']'], descKey: 'mapEditor.help.selectLayerBelow' },
      { keys: ['Del'], descKey: 'mapEditor.help.deleteSelectedLayer' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionPalette',
    shortcuts: [
      { keys: ['Ctrl', 'I'], descKey: 'mapEditor.help.importTileset' },
      { keys: ['1-9'], descKey: 'mapEditor.help.quickSelectTile' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionCharacter',
    shortcuts: [
      { keys: ['C'], descKey: 'mapEditor.help.toggleCharacterPreview' },
      { keys: ['Arrow keys'], descKey: 'mapEditor.help.moveCharacter' },
    ],
  },
  {
    titleKey: 'mapEditor.help.sectionDeskrpgLayers',
    shortcuts: [
      { keys: ['Floor'], descKey: 'mapEditor.help.layerFloor' },
      { keys: ['Walls'], descKey: 'mapEditor.help.layerWalls' },
      { keys: ['Foreground'], descKey: 'mapEditor.help.layerForeground' },
      { keys: ['Collision'], descKey: 'mapEditor.help.layerCollision' },
      { keys: ['Objects'], descKey: 'mapEditor.help.layerObjects' },
    ],
  },
];

function KeyBadge({ children }: { children: string }) {
  return (
    <kbd className="inline-block min-w-[1.5rem] px-1.5 py-0.5 text-micro font-mono font-semibold text-center bg-surface-raised text-text-secondary border border-border rounded">
      {children}
    </kbd>
  );
}

function ShortcutRow({ shortcut, t }: { shortcut: Shortcut; t: (key: string) => string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 justify-end">
        {shortcut.keys.map((key, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-text-dim text-micro">+</span>}
            <KeyBadge>{key}</KeyBadge>
          </span>
        ))}
      </div>
      <span className="text-caption text-text-secondary">{t(shortcut.descKey)}</span>
    </div>
  );
}

export default function HelpModal({ open, onClose }: HelpModalProps) {
  const t = useT();

  return (
    <Modal open={open} onClose={onClose} title={t('mapEditor.help.title')} size="lg">
      <Modal.Body>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SECTIONS.map((section) => (
            <div key={section.titleKey}>
              <h3 className="text-title text-text mb-2 pb-1 border-b border-border">
                {t(section.titleKey)}
              </h3>
              <div className="space-y-0.5">
                {section.shortcuts.map((shortcut, i) => (
                  <ShortcutRow key={i} shortcut={shortcut} t={t} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <span className="text-caption text-text-dim mr-auto">
          {t('mapEditor.help.footerHintBefore')} <KeyBadge>?</KeyBadge> {t('mapEditor.help.footerHintAfter')}
        </span>
      </Modal.Footer>
    </Modal>
  );
}
