/**
 * Layout math for the performance timeline — knows nothing about SVG, React, or the DOM.
 *
 * It draws "who **actually** worked when." It's actuals, not plans. Rows are actors, not
 * cards, and each bar is one run record.
 *
 * Keeping the layout as pure functions lets it be tested without SVG — overlap, lanes, and
 * window boundaries should be verifiable to be correct without looking at a picture.
 */

import type { KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";

/**
 * The kind of outcome used to pick a bar's color.
 *
 * `outcome` is an **open vocabulary owned by the Hermes core**. Treating it as a closed list
 * silently drops new values into gray every time the core adds one — that's actually happened
 * (measured on staging: 177 of 178 runs were `rate_limited`, which wasn't in the color map
 * and rendered as "other"). So the job here isn't "enumerate known values" but **group by
 * meaning**, and unknown values are left as `unknown` while the screen still shows the raw
 * string (`outcomeLegend`).
 *
 * `actionable` is different from failure — rate limits, blocks, and change requests are states
 * where **the user has something to do**. Coloring them as failures reads as "broken" and the
 * to-do gets missed.
 */
export type RunTone = "running" | "done" | "failed" | "actionable" | "neutral" | "unknown";

/** Groups outcomes that mean the same thing. Values confirmed against `kanban_db.py` in the `~/.hermes` core. */
const TONE_BY_OUTCOME: Readonly<Record<string, RunTone>> = {
  completed: "done",
  crashed: "failed",
  gave_up: "failed",
  timed_out: "failed",
  spawn_failed: "failed",
  stale: "failed",
  rate_limited: "actionable",
  blocked: "actionable",
  changes_requested: "actionable",
  reclaimed: "neutral",
  scheduled: "neutral",
  review_requested: "neutral",
};

export function toneOf(run: Pick<KanbanTimelineRun, "outcome" | "ended_at">): RunTone {
  if (!run.outcome) return run.ended_at === undefined ? "running" : "unknown";
  return TONE_BY_OUTCOME[run.outcome] ?? "unknown";
}

export type TimelineWindow = { fromMs: number; toMs: number };

export type PositionedBar = {
  run: KanbanTimelineRun;
  tone: RunTone;
  /** Start/end clipped to the window (ms). The side that extends past the window sticks to the window edge. */
  startMs: number;
  endMs: number;
  /** Not yet finished? The screen fades this end to say "certain up to here." */
  open: boolean;
  /** 0~1 ratio relative to the window. Pixel conversion is the screen's job — width isn't known here. */
  x: number;
  width: number;
  /** Lane number (0-based) stacking runs that overlap in time for the same actor. */
  lane: number;
};

export type ActorRow = {
  /** Actor name (`runs[].profile`). `null` if absent — runs with an unknown actor aren't dropped. */
  profile: string | null;
  /** How many lanes this row occupies (concurrent run count). Minimum 1. */
  lanes: number;
  bars: PositionedBar[];
};

export type TimelineLayout = {
  window: TimelineWindow;
  rows: ActorRow[];
  /** Count of runs not drawn because they don't overlap the window. If nonzero, the screen should surface it. */
  omitted: number;
};

/** Does it overlap the window? Clipping by start time alone would make long-running tasks vanish from the timeline. */
function overlaps(startMs: number, endMs: number | null, win: TimelineWindow): boolean {
  if (startMs > win.toMs) return false;
  if (endMs !== null && endMs < win.fromMs) return false;
  return true;
}

/**
 * Lays out run records into actor rows.
 *
 * - Row order is **most recently active actor on top**. Sorting by name would make you scan
 *   the whole list to find what just happened.
 * - If the same actor ran multiple runs concurrently, they stack into lower lanes (drawing them
 *   overlapped would hide all but one).
 * - Runs whose time can't be read are dropped, but `omitted` reports how many were dropped.
 */
export function layoutTimeline(
  runs: readonly KanbanTimelineRun[],
  win: TimelineWindow,
  nowMs: number,
): TimelineLayout {
  const span = Math.max(1, win.toMs - win.fromMs);
  const byActor = new Map<string, { profile: string | null; bars: PositionedBar[] }>();
  let omitted = 0;

  for (const run of runs) {
    const startedMs = taskTimeMs(run.started_at);
    if (startedMs === null) {
      omitted += 1;
      continue;
    }
    const endedMs = taskTimeMs(run.ended_at);
    const open = endedMs === null;
    // An unfinished run is treated as running "up to now." It never extends past the window end.
    const effectiveEnd = open ? Math.min(nowMs, win.toMs) : endedMs;
    if (!overlaps(startedMs, open ? null : endedMs, win)) {
      omitted += 1;
      continue;
    }
    const startMs = Math.max(startedMs, win.fromMs);
    const endMs = Math.max(startMs, Math.min(effectiveEnd, win.toMs));
    const key = run.profile ?? "\u0000unknown";
    const row = byActor.get(key) ?? { profile: run.profile ?? null, bars: [] };
    row.bars.push({
      run,
      tone: toneOf(run),
      startMs,
      endMs,
      open,
      x: (startMs - win.fromMs) / span,
      width: (endMs - startMs) / span,
      lane: 0,
    });
    byActor.set(key, row);
  }

  const rows: ActorRow[] = [];
  for (const row of byActor.values()) {
    row.bars.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const lanes = assignLanes(row.bars);
    rows.push({ profile: row.profile, lanes, bars: row.bars });
  }
  // Most recently active actor on top. Rows with no name go last.
  rows.sort((a, b) => {
    if ((a.profile === null) !== (b.profile === null)) return a.profile === null ? 1 : -1;
    return lastEnd(b) - lastEnd(a);
  });
  return { window: win, rows, omitted };
}

function lastEnd(row: ActorRow): number {
  return row.bars.reduce((max, bar) => Math.max(max, bar.endMs), 0);
}

/**
 * Pushes overlapping bars down into lower lanes. A greedy placement that puts each bar into the
 * earliest free lane — this guarantees the minimum lane count (the coloring of an interval graph
 * equals the max concurrency) and keeps the order stable.
 */
function assignLanes(bars: PositionedBar[]): number {
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end <= bar.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.endMs);
    } else {
      laneEnds[lane] = bar.endMs;
    }
    bar.lane = lane;
  }
  return Math.max(1, laneEnds.length);
}

/** Default window ranges — "today" and "this week." No zoom (added later if there's demand). */
export type WindowPreset = "today" | "week";

/**
 * The window runs **through the end of today**. It doesn't cut off at `now`.
 *
 * It originally cut off at `now`, but then the target-date vertical line would almost never be
 * drawn — a target date is the **end of that day** (23:59), which is always after `now`. On a
 * screen opened to check what's due today, missing that line is as good as not having the
 * feature (a modal wiring test caught this).
 *
 * The rest of today is left as an empty stretch with no bar, and that emptiness is exactly what
 * shows "how much time is left." In-progress bars are only drawn up to `now` (`layoutTimeline`),
 * so nothing that hasn't happened gets drawn either.
 */
export function presetWindow(preset: WindowPreset, nowMs: number): TimelineWindow {
  const end = new Date(nowMs);
  end.setHours(23, 59, 59, 999);
  const toMs = end.getTime();
  if (preset === "today") return { fromMs: localDayStart(nowMs), toMs };
  // This is a **rolling 7 days**, not a calendar week. For a screen that answers "what happened
  // recently," rolling fits better than a calendar week that goes blank every Monday morning
  // (decided 2026-09-21). The window start is aligned to that day's local midnight so ticks
  // don't drift off date boundaries — the label is "last 7 days."
  return { fromMs: localDayStart(toMs - 6 * DAY_MS), toMs };
}

/** The **local** midnight of the day containing this timestamp. Single source of truth for tick alignment and date comparisons. */
function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 3600_000;

/**
 * Time-axis ticks. Picks an interval based on window length and returns only the boundaries that
 * fall inside the window.
 *
 * The tick count isn't fixed because "today" can be less than an hour right after midnight —
 * forcing six ticks in that case would produce second-level ticks.
 *
 * **Boundaries are counted from local midnight, not epoch.** Aligning to epoch multiples puts
 * daily ticks at UTC midnight, which lands at 09:00 in KST — this is the actual defect where all
 * seven ticks of a weekly window read "09:00 AM." Timezones with a 30-minute offset (e.g. India)
 * hit the same problem even for hourly ticks, so the same basis is used regardless of interval.
 *
 * Daily ticks don't add 24 hours — they **advance the date by one** — adding a fixed 24 hours in
 * a region with DST would drift a day off midnight over time.
 */
export function axisTicks(win: TimelineWindow, maxTicks = 8): number[] {
  const span = win.toMs - win.fromMs;
  if (span <= 0) return [];
  const steps = [
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3600_000,
    3 * 3600_000,
    6 * 3600_000,
    12 * 3600_000,
    DAY_MS,
  ];
  // Ticks are boundaries, so the count is `span/step + 1`. Forgetting that +1 when picking the
  // interval overshoots by exactly one (a 4-hour window with a 30-minute interval → 9 ticks).
  const step = steps.find((s) => Math.floor(span / s) + 1 <= maxTicks) ?? steps[steps.length - 1];
  const ticks: number[] = [];

  if (step === DAY_MS) {
    const cursor = new Date(localDayStart(win.fromMs));
    if (cursor.getTime() < win.fromMs) cursor.setDate(cursor.getDate() + 1);
    while (cursor.getTime() <= win.toMs) {
      ticks.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
    }
    return ticks;
  }

  const origin = localDayStart(win.fromMs);
  const first = origin + Math.ceil((win.fromMs - origin) / step) * step;
  for (let t = first; t <= win.toMs; t += step) ticks.push(t);
  return ticks;
}

/**
 * Whether tick labels should be shown as time or date. When the window spans more than a day,
 * hour:minute alone can't distinguish ticks — that's the actual defect where all seven labels
 * of a weekly window read the same text.
 */
export type AxisLabelKind = "time" | "date";

export function axisLabelKind(win: TimelineWindow): AxisLabelKind {
  return win.toMs - win.fromMs > DAY_MS ? "date" : "time";
}

/**
 * One legend entry. If `outcome` is `null`, the screen attaches its own wording such as
 * "no outcome recorded" or "still running."
 */
export type OutcomeLegendEntry = { outcome: string | null; tone: RunTone; count: number };

/**
 * Builds the legend only from outcomes that **actually appear** among the visible bars.
 *
 * Using a fixed list of tones as the legend would squash unknown values into a single "other"
 * entry and lose their name. Here the value itself is the entry, so even as the core grows its
 * vocabulary, that string still shows up on screen — not losing the name is the point of this
 * function, even when a color can't be picked.
 *
 * Sorted by count descending, then by name for ties. A fixed sort keeps snapshots stable.
 */
export function outcomeLegend(rows: readonly ActorRow[]): OutcomeLegendEntry[] {
  const seen = new Map<string, OutcomeLegendEntry>();
  for (const row of rows) {
    for (const bar of row.bars) {
      const outcome = bar.run.outcome ?? null;
      const key = `${bar.tone}\u0000${outcome ?? ""}`;
      const found = seen.get(key);
      if (found) found.count += 1;
      else seen.set(key, { outcome, tone: bar.tone, count: 1 });
    }
  }
  return [...seen.values()].sort(
    (a, b) => b.count - a.count || (a.outcome ?? "").localeCompare(b.outcome ?? ""),
  );
}

/** Duration of one bar (ms). If not yet finished, it's however much is visible inside the window. */
export function barDurationMs(bar: PositionedBar): number {
  return bar.endMs - bar.startMs;
}

// ---------------------------------------------------------------------------
// Target date (D3(c) — one project target date instead of a plan bar)
// ---------------------------------------------------------------------------

export type TargetMarker =
  | { kind: "none" }
  /** Inside the window, so a vertical line can be drawn. `x` is a 0~1 ratio. */
  | { kind: "inWindow"; atMs: number; x: number }
  /**
   * The target date is outside the window. **The line is not pinned to the window edge** — that
   * would make the target date look like it's at that instant. Instead, direction and days
   * remaining are stated in words.
   */
  | { kind: "outside"; atMs: number; side: "before" | "after"; daysFromNow: number };

/**
 * Resolves a project target date relative to the window.
 *
 * `targetDate` is a `YYYY-MM-DD` date (see `toIsoDate` in `project-registry.ts`). It's treated as
 * due through the **end** of that day — if the target is September 30, the deadline runs through
 * 23:59 on the 30th; using 00:00 would lose a day.
 */
function localMidnight(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function targetMarker(
  targetDate: string | null | undefined,
  win: TimelineWindow,
  nowMs: number,
): TargetMarker {
  if (!targetDate) return { kind: "none" };
  const dayStart = Date.parse(`${targetDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dayStart)) return { kind: "none" };
  const atMs = dayStart + 24 * 3600_000 - 1;
  const span = Math.max(1, win.toMs - win.fromMs);
  if (atMs >= win.fromMs && atMs <= win.toMs) {
    return { kind: "inWindow", atMs, x: (atMs - win.fromMs) / span };
  }
  return {
    kind: "outside",
    atMs,
    side: atMs < win.fromMs ? "before" : "after",
    // Local calendar days from today: 0 is today, negative is overdue. Counting the hours left
    // until 23:59 and rounding up turned yesterday into -0 ("0 days left") and today into 1.
    // Rounding the midnight-to-midnight gap absorbs a 23- or 25-hour DST day.
    daysFromNow: Math.round((dayStart - localMidnight(nowMs)) / (24 * 3600_000)),
  };
}

// ---------------------------------------------------------------------------
// Dependency arrows (a parent link is the execution order)
// ---------------------------------------------------------------------------

export type DependencyEdge = {
  parentTaskId: string;
  childTaskId: string;
  /** The parent's last bar end and the child's first bar start. Only built when both are visible in the window. */
  from: { x: number; row: number; lane: number };
  to: { x: number; row: number; lane: number };
  /**
   * Did the child start before the parent? Hermes only picks up the child after the parent
   * finishes, so this normally shouldn't happen. If it does, it's worth seeing, so it isn't hidden.
   */
  outOfOrder: boolean;
};

/**
 * Turns parent→child links into arrows.
 *
 * Only built **when both cards are drawn inside the window**. If one is missing, the arrow would
 * come from or go into thin air, implying a relationship that isn't there.
 */
export function dependencyEdges(
  rows: readonly ActorRow[],
  links: readonly { parent_id: string; child_id: string }[],
): DependencyEdge[] {
  type Anchor = {
    row: number;
    lane: number;
    startX: number;
    endX: number;
    startMs: number;
    endMs: number;
  };
  const anchors = new Map<string, Anchor>();
  rows.forEach((row, rowIndex) => {
    for (const bar of row.bars) {
      const existing = anchors.get(bar.run.task_id);
      if (!existing) {
        anchors.set(bar.run.task_id, {
          row: rowIndex,
          lane: bar.lane,
          startX: bar.x,
          endX: bar.x + bar.width,
          startMs: bar.startMs,
          endMs: bar.endMs,
        });
        continue;
      }
      // If a card ran more than once, connect its earliest start to its latest end.
      if (bar.startMs < existing.startMs) {
        existing.startMs = bar.startMs;
        existing.startX = bar.x;
        existing.row = rowIndex;
        existing.lane = bar.lane;
      }
      if (bar.endMs > existing.endMs) {
        existing.endMs = bar.endMs;
        existing.endX = bar.x + bar.width;
      }
    }
  });

  const edges: DependencyEdge[] = [];
  for (const link of links) {
    const parent = anchors.get(link.parent_id);
    const child = anchors.get(link.child_id);
    if (!parent || !child) continue;
    edges.push({
      parentTaskId: link.parent_id,
      childTaskId: link.child_id,
      from: { x: parent.endX, row: parent.row, lane: parent.lane },
      to: { x: child.startX, row: child.row, lane: child.lane },
      outOfOrder: child.startMs < parent.endMs,
    });
  }
  return edges;
}
