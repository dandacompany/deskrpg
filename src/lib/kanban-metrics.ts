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

import type { KanbanStatusTransition, KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import { countNeedsAttention, type AttentionCounts } from "@/lib/needs-attention";
import { taskTimeMs } from "@/lib/plugin-time";

/**
 * The outcome vocabulary for finished runs (Hermes `task_runs.outcome`).
 *
 * `completed` finishes the card. The rest are not lumped together as one "failure" —
 * `gave_up` and `crashed` call for different human action, and merging them loses what
 * needs to be fixed.
 */
export const RUN_SUCCESS_OUTCOME = "completed";

/**
 * The worker finished and, by the board's policy, handed the card to a human for review
 * (`kanban_db.request_review`). The run ended normally, so it counts toward the success rate, but
 * the card is not done until someone approves it — approval is recorded as a separate
 * `completed` run, which is what throughput counts.
 */
export const RUN_REVIEW_OUTCOME = "review_requested";

const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set([RUN_SUCCESS_OUTCOME, RUN_REVIEW_OUTCOME]);

export type OutcomeCount = { outcome: string; count: number };

export type DurationStats = {
  /** Median (ms). A mean gets dragged around by a single crash. null if there are no samples. */
  medianMs: number | null;
  /** **Always report the sample count alongside it.** Showing the median of 3 runs as a trend reads a pattern that isn't there. */
  samples: number;
};

/**
 * Rework — a result sent back from review. Counted as `review` → `todo`/`ready` transitions that
 * **happened inside the window**, the same rule as finished runs: a return that happened earlier
 * belongs to an earlier window even if the card is still being reworked now.
 */
export type ReworkStats = {
  /** Number of returns. A card sent back twice counts twice — each one is a round of human review. */
  returns: number;
  /** Number of distinct cards sent back at least once. */
  cards: number;
};

/** The statuses a returned card lands in (Hermes `_landing_status_after_parents`). */
const REWORK_LANDING: ReadonlySet<string> = new Set(["todo", "ready"]);

export type OperationalMetrics = {
  window: { fromMs: number; toMs: number };
  /** **Number of cards** with at least one completed run in this window. The same card counts once even if it ran several times. */
  throughput: number;
  /** **Number of cards** handed to human review in this window that were not completed in it — work done, waiting for a person. */
  handedOff: number;
  /** Success rate among finished runs (0-1). null if there are no finished runs — writing 0% would be a lie. */
  successRate: number | null;
  /** Count of finished runs. Both the denominator for `successRate` and the sample size. */
  terminalRuns: number;
  /** Count of runs not yet finished. Excluded from the success-rate calculation. */
  openRuns: number;
  /** Count per outcome, highest first. Ties break by name — so the order doesn't shift between requeries. */
  outcomes: OutcomeCount[];
  /**
   * Duration of runs that ended well (`completed`, `review_requested`). Failed runs are excluded
   * since their duration means something different, and so are zero-length runs: Hermes
   * synthesizes one with started_at == ended_at when a human approves a card, and it measures no work.
   */
  duration: DurationStats;
  /** Cards needing attention. Counted with the **same function** as the judgment aggregate. */
  attention: AttentionCounts;
  /**
   * null when the transitions couldn't be asked for (a plugin without `kanban_task_events`, or the
   * request failed). The screen then hides the cell — writing 0 would claim nothing was sent back.
   */
  rework: ReworkStats | null;
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

export function countRework(
  transitions: readonly KanbanStatusTransition[],
  window: { fromMs: number; toMs: number },
): ReworkStats {
  const cards = new Set<string>();
  let returns = 0;
  for (const transition of transitions) {
    if (transition.from !== "review" || !REWORK_LANDING.has(transition.to)) continue;
    const at = taskTimeMs(transition.created_at);
    if (at === null || at < window.fromMs || at > window.toMs) continue;
    returns += 1;
    cards.add(transition.task_id);
  }
  return { returns, cards: cards.size };
}

export function computeOperationalMetrics(
  runs: readonly KanbanTimelineRun[],
  cards: readonly { id: string; status: string }[],
  pendingApprovalTaskIds: ReadonlySet<string>,
  window: { fromMs: number; toMs: number },
  transitions: readonly KanbanStatusTransition[] | null = null,
): OperationalMetrics {
  const completedTasks = new Set<string>();
  const reviewTasks = new Set<string>();
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

    if (SUCCESS_OUTCOMES.has(outcome)) {
      successes += 1;
      if (outcome === RUN_SUCCESS_OUTCOME) completedTasks.add(run.task_id);
      else reviewTasks.add(run.task_id);
      const started = taskTimeMs(run.started_at);
      const ended = taskTimeMs(run.ended_at);
      if (started !== null && ended !== null && ended > started) durations.push(ended - started);
    }
  }

  return {
    window,
    throughput: completedTasks.size,
    handedOff: [...reviewTasks].filter((id) => !completedTasks.has(id)).length,
    successRate: terminalRuns > 0 ? successes / terminalRuns : null,
    terminalRuns,
    openRuns,
    outcomes: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome)),
    duration: median(durations),
    attention: countNeedsAttention(cards, pendingApprovalTaskIds),
    rework: transitions === null ? null : countRework(transitions, window),
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
