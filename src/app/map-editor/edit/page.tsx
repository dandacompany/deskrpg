'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useT } from '@/lib/i18n';
import MapEditorLayout from '@/components/map-editor/MapEditorLayout';

function EditorContent() {
  const params = useSearchParams();
  const templateId = params.get('templateId');
  const from = params.get('from');
  const characterId = params.get('characterId');

  return (
    <MapEditorLayout
      initialTemplateId={templateId}
      fromCreate={from === 'create'}
      characterId={characterId}
    />
  );
}

export default function MapEditorEditPage() {
  const t = useT();
  return (
    <Suspense fallback={
      <div className="h-screen bg-bg flex items-center justify-center text-text-muted text-body">
        {t('common.loading')}
      </div>
    }>
      <EditorContent />
    </Suspense>
  );
}
