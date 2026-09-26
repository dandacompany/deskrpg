/**
 * A Hermes session can outlive the work it is shown for: one DM session makes several artifacts, and
 * the plugin returns everything the session ever read. Only what was read inside the work's time
 * window belongs to it — before the artifact was saved, or while the run was going.
 *
 * `at` is the first time the session read the source (the plugin merges repeats and keeps the first),
 * so a source first read before the window's end counts even if it was read again later.
 *
 * A source without a usable `at` is kept: Hermes stamps every message, so a missing time means the
 * record is incomplete, and hiding a real read is worse than showing one extra. Pure — no I/O.
 */
import type { SessionSource } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";

export type SourcesWindow = { fromMs?: number | null; toMs?: number | null };

export function sourcesWithin(
  sources: readonly SessionSource[],
  window: SourcesWindow | undefined,
): SessionSource[] {
  const from = window?.fromMs ?? null;
  const to = window?.toMs ?? null;
  if (from === null && to === null) return [...sources];
  return sources.filter((source) => {
    const at = source.at ? Date.parse(source.at) : NaN;
    if (Number.isNaN(at)) return true;
    // `at` has whole-second precision; bounds are whole seconds too, so compare at that grain.
    const sec = Math.floor(at / 1000);
    if (from !== null && sec < Math.floor(from / 1000)) return false;
    if (to !== null && sec > Math.floor(to / 1000)) return false;
    return true;
  });
}

/**
 * The end of an artifact's window: when the agent last saved it. A version a person saved by hand
 * (`captured_via: "edit"`) does not move it — the session reading more afterwards did not go into
 * that version. Falls back to the artifact's creation time.
 */
export function artifactSourcesUntilMs(detail: {
  artifact: { created_at: number };
  versions: ReadonlyArray<{ created_at: number; captured_via: string }>;
}): number | null {
  const agentSaves = detail.versions
    .filter((v) => v.captured_via !== "edit")
    .map((v) => taskTimeMs(v.created_at))
    .filter((ms): ms is number => ms !== null);
  if (agentSaves.length > 0) return Math.max(...agentSaves);
  return taskTimeMs(detail.artifact.created_at);
}
