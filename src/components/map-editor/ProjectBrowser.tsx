"use client";

import { useState, useEffect, useCallback } from "react";
import { useT } from "@/lib/i18n";
import { Plus, Copy, Trash2, Search } from "lucide-react";
import NewProjectModal from "./NewProjectModal";

interface ProjectItem {
  id: string;
  name: string;
  thumbnail: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type SortKey = "name" | "updatedAt" | "createdAt";

interface ProjectBrowserProps {
  onOpenProject: (projectId: string) => void;
  onCreateProject: (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => void;
}

export default function ProjectBrowser({ onOpenProject, onCreateProject }: ProjectBrowserProps) {
  const t = useT();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("updatedAt");
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects");
      if (res.ok) setProjects(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const filtered = projects
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "updatedAt") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const handleDuplicate = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await fetch(`/api/projects/${id}/duplicate`, { method: "POST" });
    fetchProjects();
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm(t("mapEditor.project.confirmDelete"))) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    fetchProjects();
  };

  const handleCreate = (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => {
    setShowNewProject(false);
    onCreateProject(name, cols, rows, tileWidth, tileHeight);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
        <h1 className="text-xl font-bold">{t("mapEditor.project.browserTitle")}</h1>
        <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm"
          onClick={() => setShowNewProject(true)}>
          <Plus size={16} />
          {t("mapEditor.project.newProject")}
        </button>
      </div>

      {/* Search + Sort */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500"
            placeholder={t("mapEditor.project.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300"
          value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
          <option value="updatedAt">{t("mapEditor.project.sortRecent")}</option>
          <option value="name">{t("mapEditor.project.sortName")}</option>
          <option value="createdAt">{t("mapEditor.project.sortCreated")}</option>
        </select>
      </div>

      {/* Project Grid */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500">
            <p className="text-lg">{t("mapEditor.project.noProjects")}</p>
            <p className="text-sm mt-1">{t("mapEditor.project.noProjectsHint")}</p>
            <button className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 text-sm"
              onClick={() => setShowNewProject(true)}>
              <Plus size={16} />
              {t("mapEditor.project.newProject")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map((project) => (
              <div key={project.id} className="group relative bg-gray-800 rounded-lg border border-gray-700 hover:border-blue-500 cursor-pointer transition-colors overflow-hidden"
                onClick={() => onOpenProject(project.id)}>
                <div className="aspect-video bg-gray-900 flex items-center justify-center">
                  {project.thumbnail ? (
                    <img src={project.thumbnail} alt={project.name} className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-gray-600 text-xs">No preview</div>
                  )}
                </div>
                <div className="p-3">
                  <div className="text-sm font-medium truncate">{project.name}</div>
                  <div className="text-xs text-gray-500 mt-1">
                    {t("mapEditor.project.modified")}: {formatDate(project.updatedAt)}
                  </div>
                </div>
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button className="p-1.5 bg-gray-700/80 rounded hover:bg-gray-600 text-gray-300"
                    onClick={(e) => handleDuplicate(e, project.id)} title={t("mapEditor.project.duplicate")}>
                    <Copy size={14} />
                  </button>
                  <button className="p-1.5 bg-gray-700/80 rounded hover:bg-red-600 text-gray-300"
                    onClick={(e) => handleDelete(e, project.id)} title={t("common.delete")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <NewProjectModal open={showNewProject} onClose={() => setShowNewProject(false)} onSubmit={handleCreate} />
    </div>
  );
}
