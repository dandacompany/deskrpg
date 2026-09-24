"use client";

import type { ReportItem } from "@/game/report-queue";
import { useT } from "@/lib/i18n";

/**
 * The report summary at the top of the dialog opened when a staff member comes to report.
 * The dialog only showed prior conversation, so "what are they reporting" was missing from
 * the screen. The wording uses the same keys as the room notice card.
 */
export default function DialogReportSummary({
  report,
  onOpenCard,
  onOpenCronJob,
}: {
  report: ReportItem;
  onOpenCard?: (cardId: string) => void;
  onOpenCronJob?: (jobId: string) => void;
}) {
  const t = useT();
  const headline =
    report.kind === "cron_failed"
      ? `${t("notice.cronResult", { jobName: report.cardTitle })} · ${t("notice.cronFailed")}`
      : t(
          report.kind === "card_done"
            ? "notice.cardDone"
            : report.kind === "card_blocked"
              ? "notice.cardBlocked"
              : "notice.cardReview",
          { title: report.cardTitle },
        );
  const summary = report.summary.trim();
  const open =
    report.jobId && onOpenCronJob
      ? { label: t("notice.openHistory"), run: () => onOpenCronJob(report.jobId!) }
      : report.cardId && onOpenCard
        ? { label: t("notice.openCard"), run: () => onOpenCard(report.cardId!) }
        : null;
  return (
    <div
      data-testid="dialog-report-summary"
      className="mx-3 mt-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-caption"
    >
      <p className="font-semibold text-text">{headline}</p>
      {summary && summary !== report.cardTitle && (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-text-secondary">{summary}</p>
      )}
      {open && (
        <button
          type="button"
          data-testid="dialog-report-open"
          onClick={open.run}
          className="mt-1.5 text-npc font-medium hover:underline"
        >
          {open.label}
        </button>
      )}
    </div>
  );
}
