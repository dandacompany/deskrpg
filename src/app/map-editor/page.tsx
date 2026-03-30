"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Download, Trash2, Copy, Search, ArrowLeft, Pencil, Plus } from "lucide-react";
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

      router.push(`/map-editor/${project.id}`);
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
        onOpenProject={(id) => router.push(`/map-editor/${id}`)}
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
            router.push(`/map-editor/${project.id}`);
          }
        }}
      />

      {/* Map Templates Section */}
      <div className="max-w-6xl mx-auto px-6 pb-8">
        {fromCreate && (
          <Link
            href={`/channels/create?characterId=${characterId || ""}`}
            className="flex items-center gap-2 mb-4 px-4 py-2 bg-surface border border-border rounded-lg text-sm text-text-muted hover:text-text hover:border-primary-light transition"
          >
            <ArrowLeft className="w-4 h-4" />
            채널 만들기로 돌아가기
          </Link>
        )}

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Map Templates</h2>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-dim" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..."
            className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary-light" />
        </div>

        {loading ? (
          <div className="text-text-muted">Loading...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-text-muted text-center py-12">
            {search ? "No matching templates." : "No templates yet."}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map((t) => (
              <div key={t.id} className="bg-surface border border-border rounded-lg p-4 hover:border-primary-light transition">
                {thumbnails[t.id] && (
                  <img src={thumbnails[t.id]} alt={t.name} className="w-full rounded mb-2 border border-border" style={{ imageRendering: "pixelated" }} />
                )}
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <span className="text-xl mr-2">{t.icon}</span>
                    <span className="font-semibold">{t.name}</span>
                  </div>
                  <span className="text-xs text-text-dim">{t.cols}x{t.rows}</span>
                </div>
                {t.description && <p className="text-sm text-text-muted mb-2">{t.description}</p>}
                {t.tags && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {t.tags.split(",").map((tag) => (
                      <span key={tag} className="text-[10px] bg-surface-raised px-1.5 py-0.5 rounded text-text-dim">{tag.trim()}</span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-2">
                  {fromCreate && (
                    <Link
                      href={`/channels/create?characterId=${characterId || ""}&templateId=${t.id}`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-primary hover:bg-primary-hover text-white font-semibold">
                      선택
                    </Link>
                  )}
                  <button
                    onClick={() => handleEditTemplate(t.id)}
                    disabled={creatingFrom === t.id}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light disabled:opacity-50">
                    <Pencil className="w-3 h-3" /> {creatingFrom === t.id ? "Creating..." : "Edit"}
                  </button>
                  <button onClick={() => handleDownload(t.id)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light">
                    <Download className="w-3 h-3" /> .tmj
                  </button>
                  <button onClick={() => handleDuplicate(t.id)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light">
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                  <button onClick={() => handleDelete(t.id, t.name)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-danger text-danger">
                    <Trash2 className="w-3 h-3" /> Delete
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
