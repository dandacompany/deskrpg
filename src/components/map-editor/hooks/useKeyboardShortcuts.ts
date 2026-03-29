'use client';

import { useEffect } from 'react';

interface ShortcutCallbacks {
  onToolPaint: () => void;
  onToolErase: () => void;
  onToolSelect: () => void;
  onToggleGrid: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onNewMap: () => void;
  onSave: () => void;
  onLoad: () => void;
  onImportTileset: () => void;
  onHelp: () => void;
  onDeleteLayer: () => void;
  onSpaceDown: () => void;
  onSpaceUp: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDeleteSelection: () => void;
  onClearSelection: () => void;
}

function isModalOpen(): boolean {
  return document.querySelector('[data-modal-overlay]') !== null;
}

function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useKeyboardShortcuts(callbacks: ShortcutCallbacks): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInputTarget(e.target)) return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl shortcuts — always handled (not blocked by modal)
      if (ctrl) {
        const key = e.key.toLowerCase();
        // Cmd/Ctrl+Shift+Z = Redo (must check before Cmd+Z = Undo)
        if (e.shiftKey && key === 'z') {
          e.preventDefault();
          callbacks.onRedo();
          return;
        }
        switch (key) {
          case 'z':
            e.preventDefault();
            callbacks.onUndo();
            return;
          case 'y':
            e.preventDefault();
            callbacks.onRedo();
            return;
          case 'n':
            e.preventDefault();
            callbacks.onNewMap();
            return;
          case 's':
            e.preventDefault();
            callbacks.onSave();
            return;
          case 'o':
            e.preventDefault();
            callbacks.onLoad();
            return;
          case 'c':
            e.preventDefault();
            callbacks.onCopy();
            return;
          case 'v':
            e.preventDefault();
            callbacks.onPaste();
            return;
        }
        return;
      }

      // Non-Ctrl shortcuts — skip when a modal is open
      if (isModalOpen()) return;

      switch (e.key) {
        case 'b':
        case 'B':
          callbacks.onToolPaint();
          break;
        case 'e':
        case 'E':
          callbacks.onToolErase();
          break;
        case 's':
        case 'S':
          callbacks.onToolSelect();
          break;
        case 'g':
        case 'G':
          callbacks.onToggleGrid();
          break;
        case '+':
        case '=':
          callbacks.onZoomIn();
          break;
        case '-':
          callbacks.onZoomOut();
          break;
        case 'i':
        case 'I':
          callbacks.onImportTileset();
          break;
        case '?':
          callbacks.onHelp();
          break;
        case 'Delete':
          callbacks.onDeleteLayer();
          break;
        case 'Backspace':
          callbacks.onDeleteSelection();
          break;
        case 'Escape':
          callbacks.onClearSelection();
          break;
        case ' ':
          e.preventDefault();
          callbacks.onSpaceDown();
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isInputTarget(e.target)) return;
      if (e.key === ' ') {
        callbacks.onSpaceUp();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [callbacks]);
}
