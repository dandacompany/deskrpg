/**
 * How a card artifact came to be: which card, who ran it and when, and which cards it built on.
 *
 * The artifact records only `task_id` (its `run_id` is never filled — plugin `artifacts_context.py`),
 * so the run is the one whose time window holds the artifact's creation time, falling back to the
 * last run that started before it. Parents come from the card's own links. Everything here is read
 * from Hermes when the artifact is opened; nothing is stored.
 *
 * Pure and dependency-free — safe for the client bundle.
 */

import type { KanbanRun, KanbanTaskDetail, PluginTime } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";

/** Parent cards shown at most; the rest are counted. */
export const PROVENANCE_PARENTS_MAX = 5;

export type ArtifactProvenanceCard = { id: string; title: string; status: string };

export type ArtifactProvenance = {
  task: ArtifactProvenanceCard & { assignee: string | null };
  run: {
    profile: string | null;
    outcome: string | null;
    started_at: PluginTime | null;
    ended_at: PluginTime | null;
  } | null;
  parents: ArtifactProvenanceCard[];
  /** Who made it, as the employee's display name (`hermes_profiles`); the profile name when unknown. */
  workerName: string | null;
  /** Parents beyond `PROVENANCE_PARENTS_MAX`, or whose card could not be read. */
  moreParents: number;
};

/** The run that made an artifact created at `createdAtMs`. */
export function pickRun(runs: readonly KanbanRun[], createdAtMs: number | null): KanbanRun | null {
  if (runs.length === 0) return null;
  const timed = runs
    .map((run) => ({ run, start: taskTimeMs(run.started_at), end: taskTimeMs(run.ended_at) }))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  if (createdAtMs !== null) {
    const inside = timed.filter(
      (r) => r.start !== null && r.start <= createdAtMs && (r.end === null || createdAtMs <= r.end),
    );
    if (inside.length > 0) return inside[inside.length - 1].run;
    const before = timed.filter((r) => r.start !== null && r.start <= createdAtMs);
    if (before.length > 0) return before[before.length - 1].run;
  }
  return timed[timed.length - 1].run;
}

/** The profile that made the artifact: the run's, else the card's assignee. */
export function provenanceProfile(
  detail: KanbanTaskDetail,
  createdAtMs: number | null,
): string | null {
  return pickRun(detail.runs ?? [], createdAtMs)?.profile ?? detail.task.assignee ?? null;
}

export function buildArtifactProvenance(
  detail: KanbanTaskDetail,
  createdAtMs: number | null,
  parents: ReadonlyArray<ArtifactProvenanceCard | null>,
  displayName: (profile: string) => string | null = () => null,
): ArtifactProvenance {
  const run = pickRun(detail.runs ?? [], createdAtMs);
  const profile = provenanceProfile(detail, createdAtMs);
  const known = parents.filter((p): p is ArtifactProvenanceCard => p !== null);
  return {
    task: {
      id: detail.task.id,
      title: detail.task.title,
      status: detail.task.status,
      assignee: detail.task.assignee ?? null,
    },
    run: run
      ? {
          profile: run.profile ?? null,
          outcome: run.outcome ?? null,
          started_at: run.started_at ?? null,
          ended_at: run.ended_at ?? null,
        }
      : null,
    parents: known,
    workerName: profile ? (displayName(profile) ?? profile) : null,
    moreParents: (detail.links?.parents?.length ?? 0) - known.length,
  };
}
