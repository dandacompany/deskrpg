"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Plus, X } from "lucide-react";

interface TaskCreateFormProps {
  onSubmit: (title: string, summary: string) => void;
  onCancel: () => void;
}

export default function TaskCreateForm({ onSubmit, onCancel }: TaskCreateFormProps) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onSubmit(trimmed, summary.trim());
    setTitle("");
    setSummary("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="bg-surface-raised rounded-lg p-2.5 border border-border">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("task.titlePlaceholder")}
        maxLength={200}
        className="w-full bg-surface text-text text-[14px] rounded px-2 py-1.5 border border-border focus:outline-none focus:border-primary mb-1.5"
        autoFocus
      />
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("task.summaryPlaceholder")}
        rows={2}
        className="w-full bg-surface text-text text-[12px] rounded px-2 py-1.5 border border-border focus:outline-none focus:border-primary resize-none mb-1.5"
      />
      <div className="flex gap-1.5 justify-end">
        <button
          onClick={onCancel}
          className="px-2 py-1 text-[12px] text-text-muted hover:text-text rounded"
        >
          <X className="w-4 h-4 inline" />
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim()}
          className="px-2.5 py-1 text-[12px] bg-primary text-white rounded hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <Plus className="w-4 h-4" />
          {t("task.createNew")}
        </button>
      </div>
    </div>
  );
}
