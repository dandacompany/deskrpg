"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Edit, Trash2, Copy, Download, Upload, Search } from "lucide-react";

interface TemplateSummary {
  id: string;
  name: string;
  icon: string;
  description: string | null;
  cols: number;
  rows: number;
  tags: string | null;
  createdAt: string;
}

export default function MapEditorListPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredTemplates = templates.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.tags?.toLowerCase().includes(q) ?? false);
  });

  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then(async (data) => {
        const list = data.templates || [];
        setTemplates(list);

        // Generate thumbnails for each template
        const { generateMapThumbnail } = await import("@/lib/map-thumbnail");
        const thumbs: Record<string, string> = {};

        for (const t of list) {
          try {
            const res = await fetch(`/api/map-templates/${t.id}`);
            const detail = await res.json();
            const template = detail.template;
            const layers = typeof template.layers === "string" ? JSON.parse(template.layers) : template.layers;
            const objects = typeof template.objects === "string" ? JSON.parse(template.objects) : template.objects;
            thumbs[t.id] = generateMapThumbnail(layers, objects, template.cols, template.rows, 6);
          } catch {
            // Skip thumbnail on error
          }
        }
        setThumbnails(thumbs);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/map-templates/${id}`, { method: "DELETE" });
    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    }
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
        spawnCol: template.spawnCol,
        spawnRow: template.spawnRow,
      }),
    });

    if (createRes.ok) {
      const { template: newTemplate } = await createRes.json();
      setTemplates((prev) => [newTemplate, ...prev]);
    }
  };

  const handleExport = async (id: string, name: string) => {
    const res = await fetch(`/api/map-templates/${id}`);
    if (!res.ok) return;
    const { template } = await res.json();

    const layers = typeof template.layers === "string" ? JSON.parse(template.layers) : template.layers;
    const objects = typeof template.objects === "string" ? JSON.parse(template.objects) : template.objects;

    const exportData = {
      name: template.name,
      icon: template.icon,
      description: template.description,
      cols: template.cols,
      rows: template.rows,
      layers,
      objects,
      spawnCol: template.spawnCol,
      spawnRow: template.spawnRow,
      tags: template.tags || null,
      exportedAt: new Date().toISOString(),
      format: "deskrpg-map-v1",
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9가-힣_-]/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.name || !data.layers?.floor || !data.layers?.walls || !data.cols || !data.rows) {
        alert("Invalid map file format");
        return;
      }

      const res = await fetch("/api/map-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name,
          icon: data.icon || "🗺️",
          description: data.description || null,
          cols: data.cols,
          rows: data.rows,
          layers: data.layers,
          objects: data.objects || [],
          spawnCol: data.spawnCol ?? Math.floor(data.cols / 2),
          spawnRow: data.spawnRow ?? (data.rows - 2),
          tags: data.tags || null,
        }),
      });

      if (res.ok) {
        const { template } = await res.json();
        setTemplates((prev) => [template, ...prev]);
        try {
          const { generateMapThumbnail } = await import("@/lib/map-thumbnail");
          const thumb = generateMapThumbnail(data.layers, data.objects || [], data.cols, data.rows, 6);
          setThumbnails((prev) => ({ ...prev, [template.id]: thumb }));
        } catch { /* skip */ }
      } else {
        const err = await res.json();
        alert(err.error || "Import failed");
      }
    } catch {
      alert("Failed to parse JSON file");
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Map Templates</h1>
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-surface-raised border border-border hover:border-primary-light rounded font-semibold text-sm"
            >
              <Upload className="w-4 h-4" /> Import
            </button>
            <Link
              href="/map-editor/new"
              className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold text-sm"
            >
              <Plus className="w-4 h-4" /> New Map
            </Link>
          </div>
        </div>

        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 bg-surface border border-border rounded text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              placeholder="Search by name or tag..."
            />
          </div>
        </div>

        {loading ? (
          <div className="text-text-muted">Loading...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-text-muted text-center py-12">
            {search ? "No templates match your search." : "No map templates yet. Create your first one!"}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredTemplates.map((t) => (
              <div
                key={t.id}
                className="bg-surface border border-border rounded-lg p-4 hover:border-primary-light transition"
              >
                {thumbnails[t.id] && (
                  <img src={thumbnails[t.id]} alt={t.name}
                    className="w-full rounded mb-2 border border-border"
                    style={{ imageRendering: "pixelated" }} />
                )}
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <span className="text-xl mr-2">{t.icon}</span>
                    <span className="font-semibold">{t.name}</span>
                  </div>
                  <span className="text-xs text-text-dim">
                    {t.cols}x{t.rows}
                  </span>
                </div>
                {t.description && (
                  <p className="text-sm text-text-muted mb-2">
                    {t.description}
                  </p>
                )}
                {t.tags && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {t.tags.split(",").map((tag, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded text-[10px] bg-surface-raised border border-border text-text-muted">
                        {tag.trim()}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-auto">
                  <button
                    onClick={() => router.push(`/map-editor/${t.id}`)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light"
                  >
                    <Edit className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={() => handleDuplicate(t.id)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                  <button
                    onClick={() => handleExport(t.id, t.name)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-primary-light"
                  >
                    <Download className="w-3 h-3" /> Export
                  </button>
                  <button
                    onClick={() => handleDelete(t.id, t.name)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded text-xs bg-surface-raised border border-border hover:border-danger text-danger"
                  >
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
