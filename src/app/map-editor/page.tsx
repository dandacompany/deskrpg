"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { Upload, Download, Trash2, Copy, Search, Package } from "lucide-react";

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
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload dialog state
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadIcon, setUploadIcon] = useState("🗺️");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadTags, setUploadTags] = useState("");

  useEffect(() => {
    fetch("/api/map-templates")
      .then((r) => r.json())
      .then(async (data) => {
        const list = data.templates || [];
        setTemplates(list);

        // Generate thumbnails
        try {
          const { generateMapThumbnail } = await import("@/lib/map-thumbnail");
          const thumbs: Record<string, string> = {};
          for (const t of list) {
            try {
              const res = await fetch(`/api/map-templates/${t.id}`);
              const detail = await res.json();
              const tmpl = detail.template;

              // Try Tiled JSON first, fallback to legacy
              if (tmpl.tiledJson) {
                const tiled = typeof tmpl.tiledJson === "string" ? JSON.parse(tmpl.tiledJson) : tmpl.tiledJson;
                // Extract layers from Tiled JSON for thumbnail
                const layers = { floor: [] as number[][], walls: [] as number[][] };
                const tiledLayers = tiled.layers || [];
                for (const layer of tiledLayers) {
                  if (layer.type === "tilelayer" && layer.data) {
                    const w = tiled.width;
                    const rows2d: number[][] = [];
                    for (let r = 0; r < tiled.height; r++) {
                      const row: number[] = [];
                      for (let c = 0; c < w; c++) {
                        // Convert GID to tile index (subtract firstgid, typically 1)
                        const gid = layer.data[r * w + c] || 0;
                        row.push(gid > 0 ? gid - 1 : 0);
                      }
                      rows2d.push(row);
                    }
                    if (layer.name === "floor") layers.floor = rows2d;
                    else if (layer.name === "walls") layers.walls = rows2d;
                  }
                }

                // Extract objects
                const objects: { type: string; col: number; row: number }[] = [];
                for (const layer of tiledLayers) {
                  if (layer.type === "objectgroup") {
                    for (const obj of layer.objects || []) {
                      if (obj.type && obj.type !== "spawn") {
                        objects.push({
                          type: obj.type,
                          col: Math.floor(obj.x / 32),
                          row: Math.floor(obj.y / 32),
                        });
                      }
                    }
                  }
                }

                if (layers.floor.length > 0) {
                  thumbs[t.id] = generateMapThumbnail(layers, objects, tiled.width, tiled.height, 6);
                }
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    setUploadName(file.name.replace(/\.tmj$/i, "").replace(/[-_]/g, " "));
    setUploadIcon("🗺️");
    setUploadDescription("");
    setUploadTags("");
    setShowUploadDialog(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadName.trim()) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("tmjFile", uploadFile);
      formData.append("name", uploadName.trim());
      formData.append("icon", uploadIcon);
      if (uploadDescription.trim()) formData.append("description", uploadDescription.trim());
      if (uploadTags.trim()) formData.append("tags", uploadTags.trim());

      const res = await fetch("/api/map-templates/upload", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const { template } = await res.json();
        setTemplates((prev) => [template, ...prev]);

        // Generate thumbnail for uploaded template
        try {
          const detailRes = await fetch(`/api/map-templates/${template.id}`);
          const detail = await detailRes.json();
          const tmpl = detail.template;
          const { generateMapThumbnail } = await import("@/lib/map-thumbnail");

          if (tmpl.tiledJson) {
            const tiled = typeof tmpl.tiledJson === "string" ? JSON.parse(tmpl.tiledJson) : tmpl.tiledJson;
            const layers = { floor: [] as number[][], walls: [] as number[][] };
            for (const layer of tiled.layers || []) {
              if (layer.type === "tilelayer" && layer.data) {
                const w = tiled.width;
                const rows2d: number[][] = [];
                for (let r = 0; r < tiled.height; r++) {
                  const row: number[] = [];
                  for (let c = 0; c < w; c++) {
                    const gid = layer.data[r * w + c] || 0;
                    row.push(gid > 0 ? gid - 1 : 0);
                  }
                  rows2d.push(row);
                }
                if (layer.name === "floor") layers.floor = rows2d;
                else if (layer.name === "walls") layers.walls = rows2d;
              }
            }
            const objects: { type: string; col: number; row: number }[] = [];
            for (const layer of tiled.layers || []) {
              if (layer.type === "objectgroup") {
                for (const obj of layer.objects || []) {
                  if (obj.type && obj.type !== "spawn") {
                    objects.push({ type: obj.type, col: Math.floor(obj.x / 32), row: Math.floor(obj.y / 32) });
                  }
                }
              }
            }
            if (layers.floor.length > 0) {
              setThumbnails((prev) => ({ ...prev, [template.id]: generateMapThumbnail(layers, objects, tiled.width, tiled.height, 6) }));
            }
          }
        } catch { /* skip thumbnail */ }
      } else {
        const err = await res.json();
        alert(err.error || "Upload failed");
      }
    } catch {
      alert("Upload failed");
    } finally {
      setUploading(false);
      setShowUploadDialog(false);
      setUploadFile(null);
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
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">Map Templates</h1>
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".tmj,.json" onChange={handleFileSelect} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold text-sm disabled:opacity-50">
              <Upload className="w-4 h-4" /> {uploading ? "Uploading..." : "Upload .tmj"}
            </button>
          </div>
        </div>

        {/* Starter Kit */}
        <div className="bg-surface border border-border rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold flex items-center gap-2"><Package className="w-5 h-5" /> Tiled Starter Kit</h2>
              <p className="text-sm text-text-muted mt-1">
                Download the tileset + sample maps for <a href="https://www.mapeditor.org/" target="_blank" rel="noopener" className="text-primary-light hover:underline">Tiled Map Editor</a>.
                Edit maps in Tiled, then upload .tmj files here.
              </p>
            </div>
            <a href="/assets/tiled-kit/README.md" target="_blank"
              className="flex items-center gap-2 px-4 py-2 bg-surface-raised border border-border hover:border-primary-light rounded text-sm font-semibold">
              <Download className="w-4 h-4" /> View Kit
            </a>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-dim" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates..."
            className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary-light" />
        </div>

        {/* Template Grid */}
        {loading ? (
          <div className="text-text-muted">Loading...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-text-muted text-center py-12">
            {search ? "No matching templates." : "No templates yet. Upload a .tmj file or use the starter kit!"}
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
                <div className="flex gap-2 mt-2">
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

      {/* Upload Dialog */}
      {showUploadDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => !uploading && setShowUploadDialog(false)}>
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold mb-4">Upload Map Template</h2>
            <div className="space-y-3">
              <div className="text-sm text-text-muted bg-surface-raised rounded px-3 py-2">
                File: <span className="text-text font-medium">{uploadFile?.name}</span>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Name *</label>
                <input type="text" value={uploadName} onChange={(e) => setUploadName(e.target.value)} maxLength={200}
                  className="w-full px-3 py-2 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary-light"
                  placeholder="My Office Map" autoFocus />
              </div>
              <div className="flex gap-3">
                <div className="w-20">
                  <label className="block text-sm font-semibold mb-1">Icon</label>
                  <input type="text" value={uploadIcon} onChange={(e) => setUploadIcon(e.target.value)} maxLength={10}
                    className="w-full px-3 py-2 bg-bg border border-border rounded text-text text-center text-xl focus:outline-none focus:ring-2 focus:ring-primary-light" />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-semibold mb-1">Tags</label>
                  <input type="text" value={uploadTags} onChange={(e) => setUploadTags(e.target.value)} maxLength={500}
                    className="w-full px-3 py-2 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary-light"
                    placeholder="office, modern" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Description</label>
                <textarea value={uploadDescription} onChange={(e) => setUploadDescription(e.target.value)} maxLength={500} rows={2}
                  className="w-full px-3 py-2 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary-light resize-none"
                  placeholder="A description of the map" />
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={handleUpload} disabled={uploading || !uploadName.trim()}
                  className="flex-1 px-4 py-2 bg-primary hover:bg-primary-hover rounded font-semibold text-sm disabled:opacity-50">
                  {uploading ? "Uploading..." : "Upload"}
                </button>
                <button onClick={() => setShowUploadDialog(false)} disabled={uploading}
                  className="px-4 py-2 bg-surface-raised border border-border rounded text-sm text-text-muted hover:text-text disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
