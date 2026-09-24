/**
 * Operational metrics — **computed** from card/run history. Never stored.
 *
 * The reason not to store them: when the calculation is wrong, fixing it is enough, and no
 * stale value lingers in the DB.
 *
 * The product direction (`docs/product-direction.md`) nails this down — we do not claim
 * productivity from agent count, message count, meeting time, or screen dwell time alone.
 * So a number like "created 30 cards" is not a metric. What's here is three things:
 * **did it finish · why did it fail · does it need attention right now.**
 */

import type { KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import { countNeedsAttention, type AttentionCounts } from "@/lib/needs-attention";
import { taskTimeMs } from "@/lib/plugin-time";

/**
 * The outcome vocabulary for finished runs (Hermes `task_runs.outcome`).
 *
 * Only `completed` counts as success. The rest are not lumped together as one "failure" —
 * `gave_up` and `crashed` call for different human action, and merging them loses what
 * needs to be fixed.
 */
export const RUN_SUCCESS_OUTCOME = "completed";

export type OutcomeCount = { outcome: string; count: number };

export type DurationStats = {
  /** Median (ms). A mean gets dragged around by a single crash. null if there are no samples. */
  medianMs: number | null;
  /** **Always report the sample count alongside it.** Showing the median of 3 runs as a trend reads a pattern that isn't there. */
  samples: number;
};

export type OperationalMetrics = {
  window: { fromMs: number; toMs: number };
  /** **Number of cards** with at least one completed run in this window. The same card counts once even if it ran several times. */
  throughput: number;
  /** Success rate among finished runs (0-1). null if there are no finished runs — writing 0% would be a lie. */
  successRate: number | null;
  /** Count of finished runs. Both the denominator for `successRate` and the sample size. */
  terminalRuns: number;
  /** Count of runs not yet finished. Excluded from the success-rate calculation. */
  openRuns: number;
  /** Count per outcome, highest first. Ties break by name — so the order doesn't shift between requeries. */
  outcomes: OutcomeCount[];
  /** Duration of completed runs. Failed runs are excluded since their duration means something different. */
  duration: DurationStats;
  /** Cards needing attention. Counted with the **same function** as the judgment aggregate. */
  attention: AttentionCounts;
};

/** Has the run finished? If `ended_at` is missing, it's still running. */
function isTerminal(run: KanbanTimelineRun): boolean {
  return taskTimeMs(run.ended_at) !== null;
}

/**
 * Counts only runs that **finished** inside the window.
 *
 * The timeline draws anything that merely overlaps the window (since the point there is
 * visibility), but metrics are different — counting work that finished outside the window
 * as this window's result would double-count the same run in two windows.
 */
function endedInWindow(run: KanbanTimelineRun, fromMs: number, toMs: number): boolean {
  const ended = taskTimeMs(run.ended_at);
  return ended !== null && ended >= fromMs && ended <= toMs;
}

export function computeOperationalMetrics(
  runs: readonly KanbanTimelineRun[],
  cards: readonly { id: string; status: string }[],
  pendingApprovalTaskIds: ReadonlySet<string>,
  window: { fromMs: number; toMs: number },
): OperationalMetrics {
  const completedTasks = new Set<string>();
  const outcomes = new Map<string, number>();
  const durations: number[] = [];
  let terminalRuns = 0;
  let openRuns = 0;
  let successes = 0;

  for (const run of runs) {
    if (!isTerminal(run)) {
      openRuns += 1;
      continue;
    }
    if (!endedInWindow(run, window.fromMs, window.toMs)) continue;
    terminalRuns += 1;

    // Also count runs that finished with no outcome. Don't invent one — leave it as "unrecorded".
    const outcome = run.outcome ?? "unrecorded";
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

    if (outcome === RUN_SUCCESS_OUTCOME) {
      successes += 1;
      completedTasks.add(run.task_id);
      const started = taskTimeMs(run.started_at);
      const ended = taskTimeMs(run.ended_at);
      if (started !== null && ended !== null && ended >= started) durations.push(ended - started);
    }
  }

  return {
    window,
    throughput: completedTasks.size,
    successRate: terminalRuns > 0 ? successes / terminalRuns : null,
    terminalRuns,
    openRuns,
    outcomes: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome)),
    duration: median(durations),
    attention: countNeedsAttention(cards, pendingApprovalTaskIds),
  };
}

function median(values: number[]): DurationStats {
  if (values.length === 0) return { medianMs: null, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { medianMs, samples: sorted.length };
}

/**
 * A rate is only shown as a number once the sample size reaches this.
 *
 * Writing 1 success out of 2 as "50%" reads a pattern that isn't there. Below this, the
 * screen shows the raw count instead of a rate.
 */
export const MIN_RATE_SAMPLES = 5;

export function hasEnoughSamples(terminalRuns: number): boolean {
  return terminalRuns >= MIN_RATE_SAMPLES;
}
