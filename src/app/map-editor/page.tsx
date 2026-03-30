"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Download, Trash2, Copy, Search, ArrowLeft, Pencil, Plus } from "lucide-react";
import { useT } from "@/lib/i18n";
import ProjectBrowser from "@/components/map-editor/ProjectBrowser";

export default function MapEditorPage() {
  return (
    <Suspense fallback={<div className="theme-web min-h-screen flex items-center justify-center bg-bg text-text">Loading...</div>}>
      <MapEditorListPage />
    </Suspense>
  );
}

interface TemplateSummary {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  cols: number;
  rows: number;
  tags: string | null;
  createdAt: string;
  tiledJson?: unknown;
}

function MapEditorListPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromCreate = searchParams.get("from") === "create";
  const characterId = searchParams.get("characterId");

  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [creatingFrom, setCreatingFrom] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then(async (data) => {
        const list = data.templates || [];
        setTemplates(list);

        try {
          const { generateMapThumbnail, generateTiledThumbnail } = await import("@/lib/map-thumbnail");
          const thumbs: Record<string, string> = {};
          for (const t of list) {
            try {
              const res = await fetch(`/api/map-templates/${t.id}`);
              const detail = await res.json();
              const tmpl = detail.template;

              if (tmpl.tiledJson) {
                const tiled = typeof tmpl.tiledJson === "string" ? JSON.parse(tmpl.tiledJson) : tmpl.tiledJson;
                thumbs[t.id] = generateTiledThumbnail(tiled, 6);
              } else if (tmpl.layers) {
                const layers = typeof tmpl.layers === "string" ? JSON.parse(tmpl.layers) : tmpl.layers;
                const objects = typeof tmpl.objects === "string" ? JSON.parse(tmpl.objects) : (tmpl.objects || []);
                thumbs[t.id] = generateMapThumbnail(layers, objects, tmpl.cols, tmpl.rows, 6);
              }
            } catch { /* skip */ }
          }
          setThumbnails(thumbs);
        } catch { /* skip */ }
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredTemplates = templates.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.tags?.toLowerCase().includes(q) ?? false);
  });

  const handleEditTemplate = async (templateId: string) => {
    if (creatingFrom) return;
    setCreatingFrom(templateId);
    try {
      // Fetch template detail to get tiledJson
      const res = await fetch(`/api/map-templates/${templateId}`);
      if (!res.ok) throw new Error("Failed to fetch template");
      const { template } = await res.json();

      const tiledJson = typeof template.tiledJson === "string"
        ? JSON.parse(template.tiledJson)
        : template.tiledJson;

      // Create a new project from this template
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: template.name,
          tiledJson,
          settings: { cols: template.cols, rows: template.rows },
        }),
      });
      if (!createRes.ok) throw new Error("Failed to create project");
      const project = await createRes.json();

      router.push(`/map-editor/${project.createdBy ?? project.created_by}/${project.id}`);
    } catch (err) {
      console.error("Failed to create project from template:", err);
      alert("Failed to open template for editing.");
      setCreatingFrom(null);
    }
  };

  const handleDownload = async (id: string) => {
    const res = await fetch(`/api/map-templates/${id}/download`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = res.headers.get("content-disposition");
    const filename = disposition?.match(/filename="(.+)"/)?.[1] || "map.tmj";
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDuplicate = async (id: string) => {
    const res = await fetch(`/api/map-templates/${id}`);
    if (!res.ok) return;
    const { template } = await res.json();

    const createRes = await fetch("/api/map-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${template.name} (copy)`,
        icon: template.icon,
        description: template.description,
        cols: template.cols,
        rows: template.rows,
        layers: template.layers,
        objects: template.objects,
        tiledJson: template.tiledJson,
        spawnCol: template.spawnCol,
        spawnRow: template.spawnRow,
        tags: template.tags,
      }),
    });

    if (createRes.ok) {
      const { template: newTemplate } = await createRes.json();
      setTemplates((prev) => [newTemplate, ...prev]);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/map-templates/${id}`, { method: "DELETE" });
    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    }
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text">
      {/* Project Browser Section */}
      <ProjectBrowser
        onOpenProject={(id, userId) => router.push(`/map-editor/${userId}/${id}`)}
        onCreateProject={async (name, cols, rows, tw, th) => {
          const { createDefaultMap } = await import("@/components/map-editor/hooks/useMapEditor");
          const mapData = createDefaultMap(name, cols, rows, tw);
          const res = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, tiledJson: mapData, settings: { cols, rows, tileWidth: tw, tileHeight: th } }),
          });
          if (res.ok) {
            const project = await res.json();
            router.push(`/map-editor/${project.createdBy ?? project.created_by}/${project.id}`);
          }
        }}
      />

      {/* Map Templates Section */}
      <div className="px-6 pb-8">
        {fromCreate && (
          <Link
            href={`/channels/create?characterId=${characterId || ""}`}
            className="flex items-center gap-2 mb-4 px-4 py-2 bg-surface border border-border rounded-lg text-sm text-text-muted hover:text-text hover:border-primary-light transition"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("mapEditor.template.backToCreate")}
          </Link>
        )}

        <div className="flex items-center justify-between mb-4 border-b border-gray-700 pb-3">
          <h2 className="text-xl font-bold">{t("mapEditor.template.title")}</h2>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("mapEditor.template.search")}
            className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>

        {loading ? (
          <div className="text-gray-500">Loading...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-gray-500 text-center py-12">
            {search ? t("mapEditor.template.noResults") : t("mapEditor.template.noTemplates")}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredTemplates.map((tmpl) => (
              <div key={tmpl.id} className="group relative bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 cursor-pointer transition-colors overflow-hidden"
                onClick={() => handleEditTemplate(tmpl.id)}>
                <div className="aspect-video bg-gray-900 flex items-center justify-center">
                  {thumbnails[tmpl.id] ? (
                    <img src={thumbnails[tmpl.id]} alt={tmpl.name} className="w-full h-full object-contain" style={{ imageRendering: "pixelated" }} />
                  ) : (
                    <div className="text-gray-600 text-xs">No preview</div>
                  )}
                </div>
                <div className="p-3">
                  <div className="flex items-center gap-1">
                    <span className="text-sm">{tmpl.icon}</span>
                    <span className="text-sm font-medium truncate">{tmpl.name}</span>
                  </div>
                  {tmpl.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{tmpl.description}</p>}
                  <div className="text-xs text-gray-600 mt-1">{tmpl.cols}×{tmpl.rows}</div>
                </div>
                {creatingFrom === tmpl.id && (
                  <div className="absolute inset-0 bg-gray-900/80 flex items-center justify-center">
                    <span className="text-sm text-blue-400">{t("mapEditor.template.creating")}</span>
                  </div>
                )}
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button className="p-1.5 bg-gray-700/80 rounded hover:bg-gray-600 text-gray-300"
                    onClick={(e) => { e.stopPropagation(); handleDownload(tmpl.id); }} title=".tmj">
                    <Download size={14} />
                  </button>
                  <button className="p-1.5 bg-gray-700/80 rounded hover:bg-gray-600 text-gray-300"
                    onClick={(e) => { e.stopPropagation(); handleDuplicate(tmpl.id); }} title={t("mapEditor.project.duplicate")}>
                    <Copy size={14} />
                  </button>
                  <button className="p-1.5 bg-gray-700/80 rounded hover:bg-red-600 text-gray-300"
                    onClick={(e) => { e.stopPropagation(); handleDelete(tmpl.id, tmpl.name); }} title={t("common.delete")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
