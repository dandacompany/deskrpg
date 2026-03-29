'use client';

import { Pencil, X } from 'lucide-react';
import Tooltip from './Tooltip';
import { LAYER_COLORS } from './hooks/useMapEditor';
import { useT } from '@/lib/i18n';
import type { StampListItem } from '@/lib/stamp-utils';

function getBadgeColor(layerName: string): string {
  const key = layerName.toLowerCase() as keyof typeof LAYER_COLORS;
  return LAYER_COLORS[key]?.solid ?? '#6b7280';
}

export interface StampPanelProps {
  stamps: StampListItem[];
  activeStampId: string | null;
  onSelectStamp: (id: string) => void;
  onEditStamp?: (id: string) => void;
  onDeleteStamp: (id: string) => void;
  hideHeader?: boolean;
}

export default function StampPanel({
  stamps,
  activeStampId,
  onSelectStamp,
  onEditStamp,
  onDeleteStamp,
  hideHeader,
}: StampPanelProps) {
  const t = useT();
  if (stamps.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <p className="text-caption text-text-dim">{t('mapEditor.stamps.noStamps')}</p>
        <p className="text-micro text-text-dim mt-1">
          {t('mapEditor.stamps.noStampsHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-1.5 py-1.5 space-y-0.5">
        {stamps.map((stamp) => {
          const isActive = stamp.id === activeStampId;
          return (
            <div
              key={stamp.id}
              className={`
                group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors
                ${isActive ? 'bg-primary-light/10 border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'}
              `.trim().replace(/\s+/g, ' ')}
              onClick={() => onSelectStamp(stamp.id)}
            >
              {/* Thumbnail */}
              <div className="w-10 h-10 bg-surface-raised rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
                {stamp.thumbnail ? (
                  <img
                    src={stamp.thumbnail}
                    alt={stamp.name}
                    className="w-full h-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                ) : (
                  <span className="text-micro text-text-dim">
                    {stamp.cols}×{stamp.rows}
                  </span>
                )}
              </div>

              {/* Name + layer badges */}
              <div className="flex-1 min-w-0">
                <div className="text-caption text-text truncate">{stamp.name}</div>
                <div className="flex gap-1 mt-0.5 flex-wrap">
                  {stamp.layerNames.map((ln) => (
                    <span
                      key={ln}
                      className="text-micro px-1 py-0.5 rounded text-white leading-none"
                      style={{ backgroundColor: getBadgeColor(ln), fontSize: '9px' }}
                    >
                      {ln}
                    </span>
                  ))}
                </div>
              </div>

              {/* Edit button */}
              {onEditStamp && (
                <Tooltip label={t('mapEditor.stamps.editStamp')}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditStamp(stamp.id);
                    }}
                    className="text-text-dim hover:text-primary-light opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              )}

              {/* Delete button */}
              <Tooltip label={t('mapEditor.stamps.deleteStamp')}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteStamp(stamp.id);
                  }}
                  className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
