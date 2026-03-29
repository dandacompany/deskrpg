'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
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
  return (
    <Suspense fallback={
      <div className="h-screen bg-bg flex items-center justify-center text-text-muted text-body">
        Loading editor...
      </div>
    }>
      <EditorContent />
    </Suspense>
  );
}
