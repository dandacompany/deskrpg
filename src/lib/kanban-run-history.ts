/**
 * A card's runs, read as **attempts** a person can follow: which try this was, how it ended in
 * words, why it failed, and whether the card will run again on its own.
 *
 * Hermes keeps every try as a separate run on the same card but records no link between a retry
 * and the run it retries. The ordinal here is the order the runs started in — an honest
 * reconstruction, not a stored relation, so the screen calls it "attempt order".
 *
 * Pure and dependency-free (besides the shared cause reader) — safe for the client bundle.
 */

import type { KanbanEvent, KanbanRun, KanbanTask } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";
import { runFailureCause, type RunFailureCause } from "@/lib/run-failure-cause";

/**
 * How an attempt ended. Hermes outcomes pass through by name; `reclaimed` is split three ways,
 * because "someone stopped it", "the worker stopped answering" and "the card was moved" call for
 * different next steps. Hermes tells them apart only by the text it writes (`kanban_db.py`
 * `reclaim_task`, `_reclaim_stale_run`; the plugin's direct move writes `(deskrpg/direct)`).
 */
export type AttemptEnd = "running" | "stopped" | "lost" | "moved" | (string & {});

export type RunAttempt = {
  run: KanbanRun;
  /** 1-based, by start time. */
  ordinal: number;
  end: AttemptEnd;
  /** Why it failed, when the text says something a person can act on. */
  cause: RunFailureCause | null;
  /** The card's events that belong to this run (needs plugin `kanban_run_events`; empty otherwise). */
  events: KanbanEvent[];
};

const FAILED_ENDS: ReadonlySet<string> = new Set([
  "crashed",
  "timed_out",
  "spawn_failed",
  "gave_up",
  "lost",
]);

export function isFailedEnd(end: AttemptEnd): boolean {
  return FAILED_ENDS.has(end);
}

function attemptEnd(run: KanbanRun): AttemptEnd {
  if (!run.ended_at && !run.outcome) return "running";
  const outcome = run.outcome ?? "unrecorded";
  if (outcome !== "reclaimed") return outcome;
  const error = run.error ?? "";
  // A drag out of running: plugin 0.26.0+ reclaims through Hermes (`manual_reclaim: … (deskrpg/direct)` in the
  // error); older plugins closed the run themselves with the marker in the summary. Checked before
  // `manual_reclaim` so a move is not shown as a stop.
  if (error.includes("(deskrpg/direct)") || (run.summary ?? "").includes("(deskrpg/direct)"))
    return "moved";
  if (error.startsWith("manual_reclaim")) return "stopped";
  if (error.includes("stale_lock")) return "lost";
  return "reclaimed";
}

/**
 * The actionable cause. Hermes marks a worker that exited on a provider it can't heal
 * (`terminal_provider`, credential revoked or model gone) — read that as a sign-in problem
 * unless the text says the model is the issue; otherwise read the text the same way the
 * chat path does (`runFailureCause`).
 */
function attemptCause(run: KanbanRun): RunFailureCause | null {
  const fromText = runFailureCause([run.error, run.summary].filter(Boolean).join("\n"));
  if (fromText) return fromText;
  if (run.metadata?.terminal_provider === true) return "provider_auth";
  return null;
}

function startedMs(run: KanbanRun): number {
  return taskTimeMs(run.started_at) ?? 0;
}

export function runAttempts(
  runs: readonly KanbanRun[],
  events: readonly KanbanEvent[] = [],
): RunAttempt[] {
  const byRun = new Map<string, KanbanEvent[]>();
  for (const event of events) {
    if (event.run_id === null || event.run_id === undefined) continue;
    const key = String(event.run_id);
    const list = byRun.get(key);
    if (list) list.push(event);
    else byRun.set(key, [event]);
  }
  return [...runs]
    .sort((a, b) => startedMs(a) - startedMs(b) || String(a.id).localeCompare(String(b.id)))
    .map((run, index) => ({
      run,
      ordinal: index + 1,
      end: attemptEnd(run),
      cause: attemptCause(run),
      events: byRun.get(String(run.id)) ?? [],
    }));
}

/**
 * One line about what happens next, or null when there is nothing to say.
 *
 * - `gave_up`: Hermes stopped retrying after repeated failures and blocked the card — it runs
 *   again only once a person unblocks it.
 * - `retrying`: it failed and is back in the queue — the dispatcher will try again by itself.
 * - `external_done`: the card needed approval but was finished outside DeskRPG with none on record.
 */
export type CardRunState =
  | { kind: "gave_up"; failures: number }
  | { kind: "retrying"; failures: number }
  | { kind: "external_done" };

export function cardRunState(
  task: { status: string; consecutive_failures?: number; review?: KanbanTask["review"] },
  attempts: readonly RunAttempt[],
): CardRunState | null {
  if (task.review?.state === "approved" && task.review.reason === "external_done")
    return { kind: "external_done" };
  const failures = task.consecutive_failures ?? 0;
  const last = attempts[attempts.length - 1];
  // Hermes ends the run itself as `gave_up` only on the spawn path; after a timeout or crash the
  // last run keeps that outcome and `gave_up` is only an event. So: blocked, failing in a row, and
  // the last try failed.
  if (task.status === "blocked" && failures > 0 && last && isFailedEnd(last.end)) {
    return { kind: "gave_up", failures };
  }
  if (failures > 0 && (task.status === "ready" || task.status === "todo")) {
    return { kind: "retrying", failures };
  }
  return null;
}
