"use client";

import { useEffect, useState } from "react";
import { Trash2, ExternalLink, Plus } from "lucide-react";
import Link from "next/link";
import { useT } from "@/lib/i18n";

interface TemplateSummary {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  cols: number;
  rows: number;
  tags: string | null;
  thumbnail?: string | null;
}

interface MapTemplateGridProps {
  /** Currently selected template id (selection mode) */
  selectedId?: string;
  /** Called when a template card is clicked */
  onSelect?: (id: string) => void;
  /** Show delete + map-editor link buttons on hover (optional) */
  showActions?: boolean;
  /** Link context for the "open in map editor" button and "add map" button */
  mapEditorQuery?: string;
}

export default function MapTemplateGrid({
  selectedId,
  onSelect,
  showActions = false,
  mapEditorQuery = "",
}: MapTemplateGridProps) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then(async (data) => {
        const list: TemplateSummary[] = data.templates || [];
        setTemplates(list);

        // Use stored thumbnails first
        const thumbs: Record<string, string> = {};
        for (const t of list) {
          if (t.thumbnail) thumbs[t.id] = t.thumbnail;
        }
        setThumbnails(thumbs);

        // Generate thumbnails for templates without a stored one
        const needsGeneration = list.filter((t) => !t.thumbnail);
        if (needsGeneration.length === 0) {
          setLoading(false);
          return;
        }

        try {
          const { generateMapThumbnail, generateTiledThumbnail } = await import(
            "@/lib/map-thumbnail"
          );
          for (const t of needsGeneration) {
            try {
              const res = await fetch(`/api/map-templates/${t.id}`);
              const detail = await res.json();
              const tmpl = detail.template;

              let thumb: string | null = null;
              if (tmpl.tiledJson) {
                thumb = generateTiledThumbnail(tmpl.tiledJson, 6);
              } else if (tmpl.layers) {
                thumb = generateMapThumbnail(tmpl.layers, tmpl.objects || [], tmpl.cols, tmpl.rows, 6);
              }
              if (thumb) {
                setThumbnails((prev) => ({ ...prev, [t.id]: thumb! }));
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleDelete = (e: React.MouseEvent, tpl: TemplateSummary) => {
    e.stopPropagation();
    if (!confirm(t("mapEditor.template.deleteConfirm", { name: tpl.name }))) return;
    fetch(`/api/map-templates/${tpl.id}`, { method: "DELETE" }).then((res) => {
      if (res.ok) {
        setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
        setThumbnails((prev) => {
          const next = { ...prev };
          delete next[tpl.id];
          return next;
        });
      }
    });
  };

  if (loading && templates.length === 0) {
    return <div className="text-text-muted text-sm py-4">{t("common.loading")}</div>;
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {templates.map((tpl) => {
        const isSelected = selectedId === tpl.id;
        return (
          <div
            key={tpl.id}
            className={`relative rounded-lg border overflow-hidden cursor-pointer group transition-colors ${
              isSelected
                ? "border-primary-light bg-primary-muted"
                : "border-border bg-surface hover:border-primary-light/50"
            }`}
            onClick={() => onSelect?.(tpl.id)}
          >
            {/* Thumbnail */}
            <div className="aspect-video bg-gray-900 flex items-center justify-center">
              {thumbnails[tpl.id] ? (
                <img
                  src={thumbnails[tpl.id]}
                  alt={tpl.name}
                  className="w-full h-full object-contain"
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <div className="text-gray-600 text-xs">{t("common.noPreview")}</div>
              )}
            </div>

            {/* Info */}
            <div className="px-2 py-2">
              <div className="font-semibold text-sm text-white truncate">{tpl.name}</div>
              <div className="text-xs text-text-muted mt-0.5">{tpl.cols}×{tpl.rows}</div>
            </div>

            {/* Action buttons (hover) */}
            {showActions && (
              <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Link
                  href={`/map-editor${mapEditorQuery}`}
                  onClick={(e) => e.stopPropagation()}
                  className="p-1 rounded bg-gray-800/90 border border-gray-600 hover:border-primary-light"
                  title={t("mapEditor.template.openInEditor")}
                >
                  <ExternalLink className="w-3 h-3 text-gray-300" />
                </Link>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, tpl)}
                  className="p-1 rounded bg-gray-800/90 border border-gray-600 hover:border-red-500 text-red-400"
                  title={t("common.delete")}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Add map — same size as template cards, always last */}
      <Link
        href={`/map-editor${mapEditorQuery}`}
        className="rounded-lg border border-dashed border-border bg-surface hover:border-primary-light hover:bg-surface-raised transition-colors flex flex-col items-center justify-center gap-1 text-text-muted hover:text-text"
      >
        {/* Match the aspect-video + info area height of template cards */}
        <div className="aspect-video w-full flex items-center justify-center flex-col gap-1">
          <Plus className="w-6 h-6" />
          <span className="text-sm font-semibold">{t("mapEditor.template.addMap")}</span>
        </div>
        {/* Spacer matching the info row height so the card is the same total height */}
        <div className="w-full px-2 py-2 opacity-0 select-none text-sm">‎</div>
      </Link>
    </div>
  );
}
