"use client";

import { useT } from "@/lib/i18n";
import type { KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";
import { segmentWidths, type StatusSegment } from "@/lib/kanban-view-state";

/**
 * Bundle progress — a status-distribution segment bar.
 *
 * This is a **different metric** from card progress (child completion count), so it looks
 * different too. The card side is a single-color bar; this one splits into cells per status.
 * If there are no countable cards (`counted === 0`), nothing is drawn — an empty 0% bar reads as
 * "nobody has done any work."
 */
const SEGMENT_CLASS: Record<KanbanTaskStatus, string> = {
  triage: "bg-text-dim",
  todo: "bg-text-muted",
  scheduled: "bg-info",
  ready: "bg-primary-light",
  running: "bg-primary",
  blocked: "bg-danger",
  review: "bg-meeting",
  done: "bg-success",
  // Excluded from the denominator, so it never actually gets drawn, but this lets the color table cover the whole status set.
  archived: "bg-surface-raised",
};

export default function KanbanStatusBar({
  segments,
  counted,
}: {
  segments: readonly StatusSegment[];
  counted: number;
}) {
  const t = useT();
  const widths = segmentWidths(segments, counted);
  if (widths.length === 0) return null;

  const label = widths.map((s) => `${t(`kanban.column.${s.status}`)} ${s.count}`).join(", ");

  return (
    <div
      className="flex h-1.5 w-full max-w-[180px] overflow-hidden rounded-full bg-surface-raised"
      role="img"
      aria-label={label}
      title={label}
    >
      {widths.map((s) => (
        <div
          key={s.status}
          className={SEGMENT_CLASS[s.status]}
          style={{ width: `${s.percent}%` }}
        />
      ))}
    </div>
  );
}
