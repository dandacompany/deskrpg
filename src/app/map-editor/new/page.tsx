"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  generateBlankMap,
  MAP_SIZE_MIN_COLS,
  MAP_SIZE_MAX_COLS,
  MAP_SIZE_MIN_ROWS,
  MAP_SIZE_MAX_ROWS,
} from "@/lib/map-editor-utils";

export default function MapEditorNewPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🗺️");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [cols, setCols] = useState(15);
  const [rows, setRows] = useState(11);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError("");

    const { mapData, spawnCol, spawnRow } = generateBlankMap(cols, rows);

    try {
      const res = await fetch("/api/map-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          icon,
          description: description.trim() || null,
          tags: tags.trim() || null,
          cols,
          rows,
          layers: mapData.layers,
          objects: mapData.objects,
          spawnCol,
          spawnRow,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Create failed");
        setSubmitting(false);
        return;
      }
      router.push(`/map-editor/${data.template.id}`);
    } catch {
      setError("Failed to create template");
      setSubmitting(false);
    }
  };

  return (
    <div className="theme-web min-h-screen bg-bg text-text p-8">
      <div className="max-w-md mx-auto">
        <h1 className="text-3xl font-bold mb-6">New Map Template</h1>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              placeholder="My Office Map"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Icon</label>
            <input
              type="text"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={10}
              className="w-20 px-3 py-2 bg-surface border border-border rounded text-text text-center text-xl focus:outline-none focus:ring-2 focus:ring-primary-light"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light resize-none"
              placeholder="A description of the map"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">Tags</label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              maxLength={500}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              placeholder="office, meeting-room, lobby (comma separated)"
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-semibold mb-1">
                Width (cols)
              </label>
              <input
                type="number"
                value={cols}
                onChange={(e) =>
                  setCols(
                    Math.max(
                      MAP_SIZE_MIN_COLS,
                      Math.min(MAP_SIZE_MAX_COLS, Number(e.target.value))
                    )
                  )
                }
                min={MAP_SIZE_MIN_COLS}
                max={MAP_SIZE_MAX_COLS}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              />
              <span className="text-xs text-text-dim">
                {MAP_SIZE_MIN_COLS}–{MAP_SIZE_MAX_COLS}
              </span>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-semibold mb-1">
                Height (rows)
              </label>
              <input
                type="number"
                value={rows}
                onChange={(e) =>
                  setRows(
                    Math.max(
                      MAP_SIZE_MIN_ROWS,
                      Math.min(MAP_SIZE_MAX_ROWS, Number(e.target.value))
                    )
                  )
                }
                min={MAP_SIZE_MIN_ROWS}
                max={MAP_SIZE_MAX_ROWS}
                className="w-full px-3 py-2 bg-surface border border-border rounded text-text focus:outline-none focus:ring-2 focus:ring-primary-light"
              />
              <span className="text-xs text-text-dim">
                {MAP_SIZE_MIN_ROWS}–{MAP_SIZE_MAX_ROWS}
              </span>
            </div>
          </div>
          {error && <p className="text-danger text-sm">{error}</p>}
          <div className="flex items-center gap-4 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2 bg-primary hover:bg-primary-hover rounded font-semibold disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create & Edit"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/map-editor")}
              className="text-text-muted hover:text-text text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
