"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import Modal from "@/components/ui/Modal";

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, cols: number, rows: number, tileWidth: number, tileHeight: number) => void;
}

const TEMPLATES = [
  { label: "Small", cols: 20, rows: 15, desc: "640×480 px" },
  { label: "Medium", cols: 30, rows: 22, desc: "960×704 px" },
  { label: "Large", cols: 40, rows: 30, desc: "1280×960 px" },
];

export default function NewProjectModal({ open, onClose, onSubmit }: NewProjectModalProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [cols, setCols] = useState(20);
  const [rows, setRows] = useState(15);
  const [tileSize, setTileSize] = useState(32);

  const handleCreate = () => {
    if (!name.trim()) return;
    onSubmit(name.trim(), cols, rows, tileSize, tileSize);
    setName("");
    setCols(20);
    setRows(15);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={t("mapEditor.project.newProject")}>
      <div className="space-y-4 p-4">
        {/* Project Name */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.projectName")}
          </label>
          <input
            className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("mapEditor.newMap.namePlaceholder")}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>

        {/* Template Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.mapSize")}
          </label>
          <div className="flex gap-2">
            {TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.label}
                className={`flex-1 px-3 py-2 rounded text-xs border ${
                  cols === tmpl.cols && rows === tmpl.rows
                    ? "border-blue-500 bg-blue-500/20 text-blue-300"
                    : "border-gray-600 bg-gray-800 text-gray-400 hover:border-gray-500"
                }`}
                onClick={() => { setCols(tmpl.cols); setRows(tmpl.rows); }}
              >
                <div className="font-medium">{tmpl.label}</div>
                <div className="text-gray-500">{tmpl.desc}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-4 mt-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t("mapEditor.newMap.width")}:</span>
              <input type="number" className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs"
                value={cols} onChange={(e) => setCols(Math.max(1, parseInt(e.target.value) || 1))} min={1} max={200} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t("mapEditor.newMap.height")}:</span>
              <input type="number" className="w-16 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs"
                value={rows} onChange={(e) => setRows(Math.max(1, parseInt(e.target.value) || 1))} min={1} max={200} />
            </div>
          </div>
        </div>

        {/* Tile Size */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {t("mapEditor.project.tileSize")}
          </label>
          <div className="flex gap-2">
            {[16, 32, 48, 64].map((size) => (
              <button key={size} className={`px-3 py-1 rounded text-xs border ${
                tileSize === size ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-gray-600 bg-gray-800 text-gray-400 hover:border-gray-500"
              }`} onClick={() => setTileSize(size)}>
                {size}×{size}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button className="px-4 py-2 text-sm text-gray-400 hover:text-white" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
            onClick={handleCreate} disabled={!name.trim()}>
            {t("mapEditor.project.createProject")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
