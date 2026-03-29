'use client';

import { Modal } from '@/components/ui';

export interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  desc: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: 'File',
    shortcuts: [
      { keys: ['Ctrl', 'N'], desc: 'New map' },
      { keys: ['Ctrl', 'O'], desc: 'Load map / tileset' },
      { keys: ['Ctrl', 'S'], desc: 'Save to DeskRPG' },
    ],
  },
  {
    title: 'Tools',
    shortcuts: [
      { keys: ['B'], desc: 'Paint brush' },
      { keys: ['E'], desc: 'Eraser' },
      { keys: ['Space'], desc: 'Hold to pan' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: ['G'], desc: 'Toggle grid overlay' },
      { keys: ['+'], desc: 'Zoom in' },
      { keys: ['-'], desc: 'Zoom out' },
      { keys: ['0'], desc: 'Reset zoom' },
    ],
  },
  {
    title: 'Edit',
    shortcuts: [
      { keys: ['Ctrl', 'Z'], desc: 'Undo' },
      { keys: ['Ctrl', 'Y'], desc: 'Redo' },
    ],
  },
  {
    title: 'Layers',
    shortcuts: [
      { keys: ['['], desc: 'Select layer above' },
      { keys: [']'], desc: 'Select layer below' },
      { keys: ['Del'], desc: 'Delete selected layer' },
    ],
  },
  {
    title: 'Palette',
    shortcuts: [
      { keys: ['Ctrl', 'I'], desc: 'Import tileset' },
      { keys: ['1-9'], desc: 'Quick select tile by index' },
    ],
  },
  {
    title: 'Character',
    shortcuts: [
      { keys: ['C'], desc: 'Toggle character preview' },
      { keys: ['Arrow keys'], desc: 'Move character (preview mode)' },
    ],
  },
  {
    title: 'DeskRPG Layers',
    shortcuts: [
      { keys: ['Floor'], desc: 'Depth 0 -- ground tiles' },
      { keys: ['Walls'], desc: 'Depth 1 -- wall structures' },
      { keys: ['Foreground'], desc: 'Depth 10000 -- renders above character' },
      { keys: ['Collision'], desc: 'Hidden in game -- blocks movement' },
      { keys: ['Objects'], desc: 'Spawn points & furniture (y-sort)' },
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

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
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
      <span className="text-caption text-text-secondary">{shortcut.desc}</span>
    </div>
  );
}

export default function HelpModal({ open, onClose }: HelpModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard Shortcuts" size="lg">
      <Modal.Body>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-title text-text mb-2 pb-1 border-b border-border">
                {section.title}
              </h3>
              <div className="space-y-0.5">
                {section.shortcuts.map((shortcut, i) => (
                  <ShortcutRow key={i} shortcut={shortcut} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <span className="text-caption text-text-dim mr-auto">
          Press <KeyBadge>?</KeyBadge> anytime to toggle this dialog
        </span>
      </Modal.Footer>
    </Modal>
  );
}
