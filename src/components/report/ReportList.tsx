"use client";

import type { ReportItem } from "@/game/report-queue";
import { useLocale, useT } from "@/lib/i18n";

/**
 * The **remaining report list** that opens when the report badge is clicked. Previously
 * the badge jumped straight to the first report's kanban, so there was no way to know
 * which reports were left (especially a dismissed one that would never come back).
 *
 * "Open" confirms only that one report. A dismissed report gets a "Recall" action.
 */
export default function ReportList({
  items,
  dismissedIds,
  onOpen,
  onRecall,
}: {
  items: readonly ReportItem[];
  dismissedIds: ReadonlySet<string>;
  onOpen: (item: ReportItem) => void;
  onRecall: (item: ReportItem) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div
      role="dialog"
      aria-label={t("report.list.title")}
      data-testid="report-list"
      /* Only the topmost layer consumes Esc — without this marker, the Esc that closes
         this list also closes the NPC chat dialog behind it, dismissing the report
         (observed on staging 2026-09-21). */
      data-modal-overlay=""
      className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border border-border bg-surface p-2 shadow-lg"
    >
      <p className="px-1 pb-1 text-caption font-semibold text-text-secondary">
        {t("report.list.title")}
      </p>
      {items.length === 0 ? (
        <p data-testid="report-list-empty" className="px-1 py-2 text-caption text-text-muted">
          {t("report.list.empty")}
        </p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {items.map((item) => {
            const dismissed = dismissedIds.has(item.messageId);
            return (
              <li
                key={item.messageId}
                data-testid="report-list-item"
                data-report-id={item.messageId}
                className="rounded px-1 py-1.5 text-caption hover:bg-surface-raised"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-text">{item.npcName}</span>
                  <span className="text-text-muted">
                    {new Date(item.createdAt).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {dismissed && (
                    <span className="text-text-muted">· {t("report.list.dismissed")}</span>
                  )}
                </div>
                <p className="truncate text-text-secondary" title={item.cardTitle}>
                  {item.cardTitle}
                </p>
                <div className="mt-1 flex gap-3">
                  <button
                    type="button"
                    data-testid="report-list-open"
                    onClick={() => onOpen(item)}
                    className="font-medium text-npc hover:underline"
                  >
                    {t("report.list.open")}
                  </button>
                  {dismissed && (
                    <button
                      type="button"
                      data-testid="report-list-recall"
                      onClick={() => onRecall(item)}
                      className="font-medium text-text-secondary hover:underline"
                    >
                      {t("report.list.recall")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
