"use client";

/**
 * The owner's target-date input for the open project. The timeline draws the date as the end of
 * that day (`targetMarker` in `timeline-layout.ts`), so only the calendar day is sent.
 */

import { useState } from "react";
import { CalendarClock, X } from "lucide-react";

import { useT } from "@/lib/i18n";

import { KanbanApiError } from "./kanban-api";
import type { ProjectOption } from "./ProjectPicker";

export function ProjectTargetDate({
  project,
  canManage,
  onSave,
}: {
  /** The project whose board is open. null while the list is loading. */
  project: ProjectOption | null;
  /** Channel owner — the project PATCH answers 403 to anyone else. */
  canManage: boolean;
  onSave(projectId: string, targetDate: string | null): Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canManage || !project) return null;

  const saved = project.targetDate ?? "";
  const save = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(project.id, next);
    } catch (err) {
      setError(
        err instanceof KanbanApiError && err.code === "invalid_target_date"
          ? t("kanban.project.targetDateInvalid")
          : t("kanban.project.targetDateFailed", {
              error: err instanceof Error ? err.message : String(err),
            }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1 text-xs text-text-secondary">
      <label className="flex items-center gap-1">
        <CalendarClock className="w-3.5 h-3.5" aria-hidden />
        <span className="sr-only">{t("kanban.project.targetDate")}</span>
        <input
          type="date"
          data-project-target-date
          // Controlled by the saved value: a refused date snaps back instead of lingering unsaved.
          value={saved}
          disabled={busy}
          title={t("kanban.project.targetDate")}
          onChange={(e) => {
            const next = e.target.value;
            if (next === saved) return;
            void save(next === "" ? null : next);
          }}
          className="bg-surface-raised text-text-primary rounded-md px-2 py-1 disabled:opacity-50"
        />
      </label>
      {saved ? (
        <button
          type="button"
          data-project-target-date-clear
          disabled={busy}
          aria-label={t("kanban.project.targetDateClear")}
          title={t("kanban.project.targetDateClear")}
          onClick={() => void save(null)}
          className="p-1 rounded-md hover:bg-surface-raised disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" aria-hidden />
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-danger max-w-[220px]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
