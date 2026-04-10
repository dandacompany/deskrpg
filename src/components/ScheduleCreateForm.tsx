"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Plus, X, ChevronDown, ChevronUp } from "lucide-react";

interface ScheduleCreateFormProps {
  onSubmit: (data: { title: string; summary: string; cronExpr: string; timezone: string }) => void;
  onCancel: () => void;
}

const PRESETS = [
  { labelKey: "schedule.presetDaily9", cron: "0 9 * * *" },
  { labelKey: "schedule.presetDaily18", cron: "0 18 * * *" },
  { labelKey: "schedule.presetWeeklyMon", cron: "0 9 * * 1" },
  { labelKey: "schedule.presetHourly", cron: "0 * * * *" },
];

export default function ScheduleCreateForm({ onSubmit, onCancel }: ScheduleCreateFormProps) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);

  const handlePreset = (cron: string) => {
    setCronExpr(cron);
    setCronError(null);
    setShowAdvanced(false);
  };

  const handleCronChange = (value: string) => {
    setCronExpr(value);
    const parts = value.trim().split(/\s+/);
    setCronError(parts.length !== 5 ? t("schedule.cronInvalid") : null);
  };

  const handleSubmit = () => {
    if (!title.trim() || !cronExpr.trim() || cronError) return;
    onSubmit({ title: title.trim(), summary: summary.trim(), cronExpr: cronExpr.trim(), timezone: "Asia/Seoul" });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="bg-surface-raised rounded-lg p-3 border border-border space-y-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("schedule.titlePlaceholder")}
        maxLength={200}
        className="w-full bg-surface text-text text-[15px] rounded px-3 py-2 border border-border focus:outline-none focus:border-primary"
        autoFocus
      />
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("schedule.summaryPlaceholder")}
        rows={2}
        className="w-full bg-surface text-text text-[14px] rounded px-3 py-2 border border-border focus:outline-none focus:border-primary resize-none"
      />

      {/* Preset buttons */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            onClick={() => handlePreset(p.cron)}
            className={`px-2.5 py-1.5 rounded text-[14px] transition ${
              cronExpr === p.cron
                ? "bg-primary/20 text-primary border border-primary/40"
                : "bg-surface text-text-muted border border-border hover:border-primary/30"
            }`}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      {/* Advanced cron input */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1 text-[13px] text-text-muted hover:text-text"
      >
        {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        {t("schedule.advancedCron")}
      </button>
      {showAdvanced && (
        <div>
          <input
            type="text"
            value={cronExpr}
            onChange={(e) => handleCronChange(e.target.value)}
            placeholder="0 9 * * *"
            className={`w-full bg-surface text-text text-[14px] font-mono rounded px-3 py-2 border focus:outline-none ${
              cronError ? "border-danger" : "border-border focus:border-primary"
            }`}
          />
          {cronError && <p className="text-[13px] text-danger mt-1">{cronError}</p>}
          <p className="text-[12px] text-text-dim mt-1">{t("schedule.cronHint")}</p>
        </div>
      )}

      {/* Current cron display */}
      <div className="text-[13px] text-text-muted">
        {t("schedule.currentCron")}: <span className="font-mono text-text">{cronExpr}</span>
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-[14px] text-text-muted hover:text-text rounded">
          <X className="w-4 h-4 inline" />
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || !!cronError}
          className="px-3 py-1.5 text-[14px] bg-primary text-white rounded hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 font-semibold"
        >
          <Plus className="w-4 h-4" />
          {t("schedule.create")}
        </button>
      </div>
    </div>
  );
}
