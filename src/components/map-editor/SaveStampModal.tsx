'use client';

import { useState, useRef, useEffect } from 'react';
import { Button, Modal } from '@/components/ui';
import { useT } from '@/lib/i18n';

interface SaveStampModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  saving?: boolean;
}

export default function SaveStampModal({ open, onClose, onSave, saving }: SaveStampModalProps) {
  const t = useT();
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <Modal open={open} onClose={onClose} title={t('mapEditor.stamps.saveTitle')}>
      <Modal.Body>
        <div className="space-y-3">
          <p className="text-caption text-text-secondary">
            {t('mapEditor.stamps.saveDescription')}
          </p>
          <div>
            <label className="block text-caption text-text-secondary mb-1">{t('mapEditor.stamps.stampName')}</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder={t('mapEditor.stamps.stampNamePlaceholder')}
              className="w-full bg-surface text-caption text-text px-3 py-2 rounded border border-border outline-none focus:border-primary-light"
              maxLength={200}
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={!name.trim() || saving}
        >
          {saving ? t('mapEditor.stamps.saving') : t('mapEditor.stamps.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
