'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import MapEditorLayout from '@/components/map-editor/MapEditorLayout';

function EditorContent() {
  const params = useParams();
  const projectId = params.projectId as string;

  return <MapEditorLayout projectId={projectId} />;
}

export default function MapEditorProjectPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen bg-bg flex items-center justify-center text-text-muted text-body">
          Loading editor...
        </div>
      }
    >
      <EditorContent />
    </Suspense>
  );
}
