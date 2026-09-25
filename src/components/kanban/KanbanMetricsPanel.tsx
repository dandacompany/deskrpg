"use client";

import { useT } from "@/lib/i18n";
import { hasEnoughSamples, MIN_RATE_SAMPLES, type OperationalMetrics } from "@/lib/kanban-metrics";

import { formatElapsed } from "./kanban-view-model";

/**
 * Operational metrics — a summary line layered on top of the performance timeline.
 *
 * Of the five cells, **only "cards needing attention" calls for action right now.** The rest are
 * after-the-fact stats, so this stays first to keep the reading order from running backwards.
 *
 * These values aren't stored, so a mistake only needs a calculation fix. Never showing a ratio as
 * a percentage when the sample size is small is this screen's rule — writing 1 out of 2 as "50%"
 * would read as a trend that isn't there.
 */
export default function KanbanMetricsPanel({ metrics }: { metrics: OperationalMetrics }) {
  const t = useT();
  const {
    attention,
    duration,
    handedOff,
    outcomes,
    successRate,
    terminalRuns,
    throughput,
    openRuns,
  } = metrics;

  return (
    <section
      aria-label={t("kanban.metrics.title")}
      className="mb-3 flex flex-wrap gap-2 text-[11px]"
    >
      <Cell
        label={t("kanban.metrics.attention")}
        value={String(attention.total)}
        emphasis={attention.total > 0}
        detail={
          attention.total > 0
            ? [
                attention.awaiting_approval > 0
                  ? t("kanban.metrics.attention.approval", {
                      count: attention.awaiting_approval,
                    })
                  : null,
                attention.review > 0
                  ? t("kanban.metrics.attention.review", { count: attention.review })
                  : null,
                attention.blocked > 0
                  ? t("kanban.metrics.attention.blocked", { count: attention.blocked })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : null
        }
      />

      <Cell label={t("kanban.metrics.throughput")} value={String(throughput)} />

      {handedOff > 0 && (
        <Cell metric="handedOff" label={t("kanban.metrics.handedOff")} value={String(handedOff)} />
      )}

      <Cell
        label={t("kanban.metrics.successRate")}
        // When the sample size is small, show the raw count instead of a ratio.
        value={
          successRate === null
            ? t("kanban.metrics.noData")
            : hasEnoughSamples(terminalRuns)
              ? `${Math.round(successRate * 100)}%`
              : t("kanban.metrics.fewSamples", {
                  count: Math.round(successRate * terminalRuns),
                  total: terminalRuns,
                })
        }
        detail={terminalRuns > 0 ? t("kanban.metrics.samples", { count: terminalRuns }) : null}
      />

      <Cell
        label={t("kanban.metrics.median")}
        value={
          duration.medianMs === null
            ? t("kanban.metrics.noData")
            : formatElapsed(Math.round(duration.medianMs / 1000))
        }
        // Showing only the median without the sample count would read like a trend.
        detail={t("kanban.metrics.samples", { count: duration.samples })}
      />

      {openRuns > 0 && <Cell label={t("kanban.metrics.openRuns")} value={String(openRuns)} />}

      {outcomes.length > 0 && (
        <div className="flex min-w-[140px] flex-col rounded-md border border-border bg-surface px-2 py-1">
          <span className="text-text-muted">{t("kanban.metrics.outcomes")}</span>
          <ul className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
            {outcomes.map((entry) => (
              <li key={entry.outcome} className="text-text-secondary">
                {outcomeLabel(t, entry.outcome)} <span className="text-text">{entry.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Hermes outcome values the locale files know are translated; anything newer keeps its raw name
 * so it is never hidden or renamed as the core adds vocabulary.
 */
function outcomeLabel(t: ReturnType<typeof useT>, outcome: string): string {
  const key = `kanban.outcome.${outcome}`;
  const label = t(key);
  return label === key ? outcome : label;
}

function Cell({
  metric,
  label,
  value,
  detail,
  emphasis = false,
}: {
  metric?: string;
  label: string;
  value: string;
  detail?: string | null;
  emphasis?: boolean;
}) {
  return (
    <div
      data-metric={metric}
      className={`flex min-w-[96px] flex-col rounded-md border px-2 py-1 ${
        emphasis ? "border-danger bg-danger-bg" : "border-border bg-surface"
      }`}
    >
      <span className="text-text-muted">{label}</span>
      <span className={`text-sm font-semibold ${emphasis ? "text-danger" : "text-text"}`}>
        {value}
      </span>
      {detail && <span className="text-text-dim">{detail}</span>}
    </div>
  );
}

export { MIN_RATE_SAMPLES };
