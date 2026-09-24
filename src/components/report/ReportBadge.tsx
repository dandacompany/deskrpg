"use client";

import { useEffect, useRef, useState } from "react";

import type { ReportItem } from "@/game/report-queue";
import { useT } from "@/lib/i18n";

import ReportList from "./ReportList";

/**
 * The report badge in the header. Clicking it opens the remaining report list (Dante's
 * 2026-09-21 decision, "list + auto re-candidate"). Even confirming the last report while
 * the list is open, it stays in an empty-list state so the user sees the result.
 */
export default function ReportBadge({
  queue,
  current,
  dismissedIds,
  onOpen,
  onRecall,
}: {
  queue: readonly ReportItem[];
  /** The report currently arriving. If null, the first report's title is used. */
  current: ReportItem | null;
  dismissedIds: ReadonlySet<string>;
  onOpen: (item: ReportItem) => void;
  onRecall: (item: ReportItem) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // This list, being the topmost layer, **consumes** Esc. In an actual browser, the list
      // disappears from the DOM before the dialog's listener runs, so relying on the layer
      // marker alone caused the dialog to close along with it (observed in practice).
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (queue.length === 0 && !open) return null;
  const title = (current ?? queue[0])?.cardTitle;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="report-badge"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-danger-bg px-2.5 py-1 text-caption font-semibold text-danger hover:bg-surface-raised"
        title={title}
      >
        <span className="h-2 w-2 rounded-full bg-danger" />
        <span className="header-full-label">
          {t("notice.pendingReports", { count: queue.length })}
        </span>
        <span className="header-mobile-label" aria-hidden="true">
          {queue.length}
        </span>
      </button>
      {open && (
        <ReportList items={queue} dismissedIds={dismissedIds} onOpen={onOpen} onRecall={onRecall} />
      )}
    </div>
  );
}
