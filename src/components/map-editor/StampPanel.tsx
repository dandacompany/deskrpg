'use client';

import { useState, useEffect, useCallback } from 'react';
import { Pencil, X, Grid3x3, List, Search, Plus } from 'lucide-react';
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
  projectId?: string | null;
  onAddToProject?: (stampId: string) => void;
}

export default function StampPanel({
  stamps,
  activeStampId,
  onSelectStamp,
  onEditStamp,
  onDeleteStamp,
  hideHeader,
  projectId,
  onAddToProject,
}: StampPanelProps) {
  const t = useT();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'project' | 'myStamps' | 'builtIn'>('project');
  const [libraryStamps, setLibraryStamps] = useState<StampListItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const fetchLibrary = useCallback(async (builtIn: boolean) => {
    setLibraryLoading(true);
    try {
      const res = await fetch(`/api/stamps?builtIn=${builtIn}`);
      if (res.ok) {
        const data = await res.json();
        setLibraryStamps(data);
      }
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'myStamps') fetchLibrary(false);
    else if (activeTab === 'builtIn') fetchLibrary(true);
  }, [activeTab, fetchLibrary]);

  const displayStamps = activeTab === 'project' ? stamps : libraryStamps;
  const showAddButton = activeTab !== 'project';

  const filtered = search
    ? displayStamps.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : displayStamps;

  return (
    <div className="flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 mb-2">
        {(['project', 'myStamps', 'builtIn'] as const).map((tab) => (
          <button
            key={tab}
            className={`flex-1 px-2 py-1.5 text-xs ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-400'
                : 'text-gray-400 hover:text-white'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'project' && t('mapEditor.assets.tabProject')}
            {tab === 'myStamps' && t('mapEditor.assets.tabMyStamps')}
            {tab === 'builtIn' && t('mapEditor.assets.tabBuiltIn')}
          </button>
        ))}
      </div>

      {/* Empty state for project tab */}
      {activeTab === 'project' && stamps.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <p className="text-caption text-text-dim">{t('mapEditor.stamps.noStamps')}</p>
          <p className="text-micro text-text-dim mt-1">{t('mapEditor.stamps.noStampsHint')}</p>
        </div>
      ) : (
        <>
          {/* Toolbar: search + view toggle */}
          <div className="px-1.5 pt-1.5 pb-1 flex items-center gap-1">
            <div className="flex-1 relative">
              <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-text-dim" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common.search')}
                className="w-full h-6 pl-5 pr-1.5 text-micro bg-surface-raised border border-border rounded text-text placeholder:text-text-dim outline-none focus:border-primary-light/50"
              />
            </div>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded transition-colors ${viewMode === 'grid' ? 'text-primary-light bg-primary-light/10' : 'text-text-dim hover:text-text'}`}
            >
              <Grid3x3 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'text-primary-light bg-primary-light/10' : 'text-text-dim hover:text-text'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Stamp items */}
          <div className="px-1.5 pb-1.5 overflow-y-auto" style={{ maxHeight: '240px' }}>
            {libraryLoading ? (
              <div className="py-3 text-center text-micro text-text-dim">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="py-3 text-center text-micro text-text-dim">{t('mapEditor.stamps.noResults')}</div>
            ) : viewMode === 'grid' ? (
              /* Grid view */
              <div className="flex flex-wrap gap-1">
                {filtered.map((stamp) => {
                  const isActive = stamp.id === activeStampId;
                  if (showAddButton) {
                    return (
                      <div key={stamp.id} className="relative group">
                        <Tooltip label={stamp.name}>
                          <div
                            className="w-12 h-12 rounded cursor-pointer overflow-hidden flex items-center justify-center transition-all bg-surface-raised hover:ring-1 hover:ring-border"
                            onClick={() => {
                              onAddToProject?.(stamp.id);
                              setActiveTab('project');
                            }}
                          >
                            {stamp.thumbnail ? (
                              <img src={stamp.thumbnail} alt={stamp.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                            ) : (
                              <span className="text-micro text-text-dim">{stamp.cols}×{stamp.rows}</span>
                            )}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Plus className="w-4 h-4 text-white" />
                            </div>
                          </div>
                        </Tooltip>
                      </div>
                    );
                  }
                  return (
                    <div key={stamp.id} className="relative group">
                      <Tooltip label={stamp.name}>
                        <div
                          className={`w-12 h-12 rounded cursor-pointer overflow-hidden flex items-center justify-center transition-all ${
                            isActive ? 'ring-2 ring-primary-light bg-primary-light/10' : 'bg-surface-raised hover:ring-1 hover:ring-border'
                          }`}
                          onClick={() => onSelectStamp(stamp.id)}
                        >
                          {stamp.thumbnail ? (
                            <img src={stamp.thumbnail} alt={stamp.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                          ) : (
                            <span className="text-micro text-text-dim">{stamp.cols}×{stamp.rows}</span>
                          )}
                        </div>
                      </Tooltip>
                      {/* Hover actions */}
                      <div className="absolute -top-1 -right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {onEditStamp && (
                          <button onClick={(e) => { e.stopPropagation(); onEditStamp(stamp.id); }}
                            className="w-4 h-4 rounded-full bg-surface border border-border text-text-dim hover:text-primary-light flex items-center justify-center shadow-sm">
                            <Pencil className="w-2.5 h-2.5" />
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); onDeleteStamp(stamp.id); }}
                          className="w-4 h-4 rounded-full bg-surface border border-border text-text-dim hover:text-danger flex items-center justify-center shadow-sm">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* List view */
              <div className="space-y-0.5">
                {filtered.map((stamp) => {
                  const isActive = stamp.id === activeStampId;
                  if (showAddButton) {
                    return (
                      <div
                        key={stamp.id}
                        className="group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-surface-raised border border-transparent"
                        onClick={() => {
                          onAddToProject?.(stamp.id);
                          setActiveTab('project');
                        }}
                      >
                        <div className="w-10 h-10 bg-surface-raised rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
                          {stamp.thumbnail ? (
                            <img src={stamp.thumbnail} alt={stamp.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                          ) : (
                            <span className="text-micro text-text-dim">{stamp.cols}×{stamp.rows}</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-caption text-text truncate">{stamp.name}</div>
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            {stamp.layerNames.map((ln) => (
                              <span key={ln} className="text-micro px-1 py-0.5 rounded text-white leading-none" style={{ backgroundColor: getBadgeColor(ln), fontSize: '9px' }}>
                                {ln}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 text-text-dim hover:text-primary-light">
                          <Plus className="w-3.5 h-3.5" />
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={stamp.id}
                      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                        isActive ? 'bg-primary-light/10 border border-primary-light/30' : 'hover:bg-surface-raised border border-transparent'
                      }`}
                      onClick={() => onSelectStamp(stamp.id)}
                    >
                      <div className="w-10 h-10 bg-surface-raised rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
                        {stamp.thumbnail ? (
                          <img src={stamp.thumbnail} alt={stamp.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                        ) : (
                          <span className="text-micro text-text-dim">{stamp.cols}×{stamp.rows}</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-caption text-text truncate">{stamp.name}</div>
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {stamp.layerNames.map((ln) => (
                            <span key={ln} className="text-micro px-1 py-0.5 rounded text-white leading-none" style={{ backgroundColor: getBadgeColor(ln), fontSize: '9px' }}>
                              {ln}
                            </span>
                          ))}
                        </div>
                      </div>
                      {onEditStamp && (
                        <button onClick={(e) => { e.stopPropagation(); onEditStamp(stamp.id); }}
                          className="text-text-dim hover:text-primary-light opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); onDeleteStamp(stamp.id); }}
                        className="text-text-dim hover:text-danger opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
