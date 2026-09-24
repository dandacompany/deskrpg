import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import {
  axisLabelKind,
  axisTicks,
  barDurationMs,
  dependencyEdges,
  layoutTimeline,
  outcomeLegend,
  presetWindow,
  targetMarker,
  toneOf,
  type TimelineWindow,
} from "./timeline-layout";

const S = 1000;
const WIN: TimelineWindow = { fromMs: 1_000 * S, toMs: 2_000 * S };
const NOW = 1_900 * S;

let seq = 0;
function run(over: Partial<KanbanTimelineRun> = {}): KanbanTimelineRun {
  seq += 1;
  return {
    id: String(seq),
    status: "done",
    task_id: "t1",
    board: "default",
    started_at: 1_100,
    ended_at: 1_200,
    ...over,
  } as KanbanTimelineRun;
}

// ---------------------------------------------------------------------------
// Outcome color
// ---------------------------------------------------------------------------

test("groups outcomes by meaning — separates failure from 'action needed'", () => {
  assert.equal(toneOf({ outcome: "completed", ended_at: 1 }), "done");
  for (const bad of ["crashed", "timed_out", "spawn_failed", "gave_up", "stale"]) {
    assert.equal(toneOf({ outcome: bad, ended_at: 1 }), "failed", bad);
  }
  // Limits, blocks, and change requests are states where the user has something to do.
  // Painting them as failure color reads as "broken" and that to-do gets missed.
  for (const todo of ["rate_limited", "blocked", "changes_requested"]) {
    assert.equal(toneOf({ outcome: todo, ended_at: 1 }), "actionable", todo);
  }
  for (const mid of ["reclaimed", "scheduled", "review_requested"]) {
    assert.equal(toneOf({ outcome: mid, ended_at: 1 }), "neutral", mid);
  }
});

test("no outcome and not ended yet means running", () => {
  assert.equal(toneOf({ ended_at: undefined }), "running");
  // Ended with no outcome is not judged — we don't invent a meaning that isn't there.
  assert.equal(toneOf({ ended_at: 1 }), "unknown");
});

test("unknown outcome is unknown, and the legend doesn't lose that string", () => {
  // `outcome` is an open vocabulary owned by the Hermes core. As values grow, the name
  // must still appear on screen — in production, 177 `rate_limited` runs missing from
  // the color mapping got flattened into gray. That was the bug.
  assert.equal(toneOf({ outcome: "some_future_outcome", ended_at: 1 }), "unknown");
  const win = { fromMs: 0, toMs: 10_000 };
  const layout = layoutTimeline(
    [
      run({
        id: "a",
        profile: "sophie",
        started_at: 1,
        ended_at: 2,
        outcome: "some_future_outcome",
      }),
      run({
        id: "b",
        profile: "sophie",
        started_at: 3,
        ended_at: 4,
        outcome: "some_future_outcome",
      }),
      run({ id: "c", profile: "sophie", started_at: 5, ended_at: 6, outcome: "rate_limited" }),
    ],
    win,
    10_000,
  );
  const legend = outcomeLegend(layout.rows);
  assert.deepEqual(
    legend.map((e) => [e.outcome, e.tone, e.count]),
    [
      ["some_future_outcome", "unknown", 2],
      ["rate_limited", "actionable", 1],
    ],
    "범례가 값 이름을 잃거나 '기타' 로 뭉갰습니다",
  );
});

// ---------------------------------------------------------------------------
// Window and overlap
// ---------------------------------------------------------------------------

test("draws anything that overlaps the window at all — clipping by start alone drops long runs", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 900, ended_at: 1_500, profile: "a" }), // starts before the window
      run({ started_at: 1_900, ended_at: 2_500, profile: "a" }), // ends after the window
      run({ started_at: 800, ended_at: 2_900, profile: "a" }), // spans the whole window
    ],
    WIN,
    NOW,
  );
  assert.equal(layout.rows[0].bars.length, 3);
  assert.equal(layout.omitted, 0);
});

test("a bar reaching outside the window clamps to the window edge", () => {
  const layout = layoutTimeline(
    [run({ started_at: 500, ended_at: 2_500, profile: "a" })],
    WIN,
    NOW,
  );
  const bar = layout.rows[0].bars[0];
  assert.equal(bar.startMs, WIN.fromMs);
  assert.equal(bar.endMs, WIN.toMs);
  assert.equal(bar.x, 0);
  assert.equal(bar.width, 1);
});

test("runs that don't overlap the window are dropped, and the count is reported", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 10, ended_at: 20, profile: "a" }),
      run({ started_at: 5_000, ended_at: 5_100, profile: "a" }),
      run({ started_at: 1_100, ended_at: 1_200, profile: "a" }),
    ],
    WIN,
    NOW,
  );
  assert.equal(layout.rows.length, 1);
  assert.equal(layout.rows[0].bars.length, 1);
  assert.equal(layout.omitted, 2, "조용히 버리면 화면이 사실을 숨긴다");
});

test("runs whose times can't be read also show up in the omitted count", () => {
  const layout = layoutTimeline([run({ started_at: undefined, profile: "a" })], WIN, NOW);
  assert.deepEqual(layout.rows, []);
  assert.equal(layout.omitted, 1);
});

// ---------------------------------------------------------------------------
// In progress
// ---------------------------------------------------------------------------

test("an unfinished run draws only up to now and is marked open", () => {
  const layout = layoutTimeline(
    [run({ started_at: 1_500, ended_at: undefined, profile: "a" })],
    WIN,
    NOW,
  );
  const bar = layout.rows[0].bars[0];
  assert.equal(bar.open, true, "여기까지 확실하다는 표시가 필요하다");
  assert.equal(bar.endMs, NOW);
});

test("an in-progress run doesn't overrun the end of the window", () => {
  const future = 9_000 * S;
  const layout = layoutTimeline(
    [run({ started_at: 1_500, ended_at: undefined, profile: "a" })],
    WIN,
    future,
  );
  assert.equal(layout.rows[0].bars[0].endMs, WIN.toMs);
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

test("runs that overlap in time stack into lower rows — overlapping draws would show only one", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 1_100, ended_at: 1_500, profile: "a" }),
      run({ started_at: 1_200, ended_at: 1_600, profile: "a" }),
      run({ started_at: 1_300, ended_at: 1_400, profile: "a" }),
    ],
    WIN,
    NOW,
  );
  assert.equal(layout.rows[0].lanes, 3);
  assert.deepEqual(
    layout.rows[0].bars.map((b) => b.lane),
    [0, 1, 2],
  );
});

test("non-overlapping runs reuse the same lane", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 1_100, ended_at: 1_200, profile: "a" }),
      run({ started_at: 1_300, ended_at: 1_400, profile: "a" }),
    ],
    WIN,
    NOW,
  );
  assert.equal(layout.rows[0].lanes, 1);
  assert.deepEqual(
    layout.rows[0].bars.map((b) => b.lane),
    [0, 0],
  );
});

test("lane count equals the max number of concurrent runs", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 1_100, ended_at: 1_900, profile: "a" }),
      run({ started_at: 1_200, ended_at: 1_300, profile: "a" }),
      run({ started_at: 1_400, ended_at: 1_500, profile: "a" }),
    ],
    WIN,
    NOW,
  );
  assert.equal(layout.rows[0].lanes, 2, "두 번째·세 번째는 서로 겹치지 않으니 한 줄을 나눠 쓴다");
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

test("rows split by worker, with the most recently active one on top", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 1_100, ended_at: 1_200, profile: "오래전" }),
      run({ started_at: 1_700, ended_at: 1_800, profile: "방금" }),
    ],
    WIN,
    NOW,
  );
  assert.deepEqual(
    layout.rows.map((r) => r.profile),
    ["방금", "오래전"],
  );
});

test("a run with an unknown worker is not dropped — it goes in the last row", () => {
  const layout = layoutTimeline(
    [
      run({ started_at: 1_100, ended_at: 1_200, profile: undefined }),
      run({ started_at: 1_100, ended_at: 1_200, profile: "소피" }),
    ],
    WIN,
    NOW,
  );
  assert.deepEqual(
    layout.rows.map((r) => r.profile),
    ["소피", null],
  );
});

// ---------------------------------------------------------------------------
// Window presets and ticks
// ---------------------------------------------------------------------------

test("the 'today' window runs from midnight to the end of today — cutting at now hides the target-date line forever", () => {
  const now = Date.parse("2026-09-21T14:30:00.000Z");
  const win = presetWindow("today", now);
  const start = new Date(win.fromMs);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.ok(win.fromMs <= now);
  const end = new Date(win.toMs);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  // The target date is the end of that day, so cutting at `now` would always put it outside the window.
  assert.ok(win.toMs > now);
});

test("the 'last 7 days' window opens at local midnight of day 7 and closes at the end of today", () => {
  const now = Date.parse("2026-09-21T14:30:00.000Z");
  const win = presetWindow("week", now);
  const start = new Date(win.fromMs);
  // A rolling 7 days, not a calendar week. If the start isn't aligned to local midnight,
  // the day ticks drift off the date boundary (labels point at a time other than midnight).
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(new Date(win.toMs).getHours(), 23);
  const days = Math.round(localNoonDayIndex(win.toMs) - localNoonDayIndex(win.fromMs));
  assert.equal(days, 6, "오늘을 포함해 7일이어야 합니다");
});

/** Local date as an integer — dividing by ms to count days breaks in DST regions. */
function localNoonDayIndex(ms: number): number {
  const d = new Date(ms);
  return Math.round(
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() / 86_400_000,
  );
}

test("ticks pick a spacing based on window length and stay inside the window", () => {
  const hour = 3600_000;
  const win = { fromMs: 0, toMs: 4 * hour };
  const ticks = axisTicks(win);
  assert.ok(ticks.length > 0 && ticks.length <= 8);
  assert.ok(ticks.every((t) => t >= win.fromMs && t <= win.toMs));
});

test("even in a very short window, ticks don't overrun it", () => {
  const ticks = axisTicks({ fromMs: 0, toMs: 60_000 });
  assert.ok(ticks.every((t) => t <= 60_000));
});

test("day ticks land on local midnight — aligning to epoch boundaries puts them at 09:00 in KST", () => {
  // **Calls `axisTicks` directly on a window not aligned to midnight.** Because `presetWindow`
  // now aligns the window start to local midnight, using a preset window here would let this
  // assertion pass even if tick alignment were wrong (confirmed by mutation testing — reverting
  // the alignment to epoch still passed). This is exactly the shape the original bug took:
  // the old week preset opened at 23:59:59 seven days ago.
  //
  // Assert on "the tick's local hour/minute is 0:00", not on the label string — that way the
  // same assertion passes correctly under both TZ=UTC and TZ=Asia/Seoul (under UTC the two
  // midnights coincide, so the bug wouldn't show).
  const dayEnd = new Date(Date.parse("2026-09-14T00:00:00.000Z"));
  dayEnd.setHours(23, 59, 59, 999);
  const win = { fromMs: dayEnd.getTime(), toMs: dayEnd.getTime() + 7 * 24 * 3600_000 };
  const ticks = axisTicks(win);
  assert.ok(ticks.length >= 2, `주 단위 창에 눈금이 ${ticks.length}개입니다`);
  for (const tick of ticks) {
    const d = new Date(tick);
    assert.equal(d.getHours(), 0, `눈금 ${d.toString()} 이 로컬 자정이 아닙니다`);
    assert.equal(d.getMinutes(), 0);
  }
});

test("preset-window ticks are also at local midnight", () => {
  const now = Date.parse("2026-09-21T14:30:00.000Z");
  for (const tick of axisTicks(presetWindow("week", now))) {
    const d = new Date(tick);
    assert.equal(d.getHours(), 0, `눈금 ${d.toString()} 이 로컬 자정이 아닙니다`);
  }
});

test("ticks in a window longer than a day fall on different days — labels don't all collapse together", () => {
  const now = Date.parse("2026-09-21T14:30:00.000Z");
  const win = presetWindow("week", now);
  const ticks = axisTicks(win);
  // The shape of the real-world bug was "all seven labels read 09:00". Label formatting is a
  // locale concern, so here we only check the underlying property — ticks must fall on
  // different **dates**.
  const days = ticks.map((t) => new Date(t).toDateString());
  assert.equal(new Set(days).size, days.length, `눈금이 같은 날에 겹쳤습니다: ${days.join(", ")}`);
  assert.equal(axisLabelKind(win), "date", "하루를 넘는 창은 날짜 라벨을 써야 합니다");
});

test("a window of a day or less uses time labels", () => {
  const now = Date.parse("2026-09-21T14:30:00.000Z");
  assert.equal(axisLabelKind(presetWindow("today", now)), "time");
  assert.equal(axisLabelKind({ fromMs: 0, toMs: 4 * 3600_000 }), "time");
});

test("a zero-length window has no ticks", () => {
  assert.deepEqual(axisTicks({ fromMs: 5, toMs: 5 }), []);
});

test("duration is however much is visible inside the window", () => {
  const layout = layoutTimeline(
    [run({ started_at: 900, ended_at: 1_500, profile: "a" })],
    WIN,
    NOW,
  );
  assert.equal(barDurationMs(layout.rows[0].bars[0]), 500 * S);
});

// ---------------------------------------------------------------------------
// Target date
// ---------------------------------------------------------------------------

test("no target date means no marker", () => {
  assert.deepEqual(targetMarker(null, WIN, NOW), { kind: "none" });
  assert.deepEqual(targetMarker(undefined, WIN, NOW), { kind: "none" });
  assert.deepEqual(targetMarker("날짜아님", WIN, NOW), { kind: "none" });
});

test("the target date runs through the end of that day — treating it as midnight loses a day", () => {
  const dayStart = Date.parse("2026-09-30T00:00:00");
  const win = { fromMs: dayStart - 3600_000, toMs: dayStart + 48 * 3600_000 };
  const marker = targetMarker("2026-09-30", win, dayStart);
  assert.equal(marker.kind, "inWindow");
  if (marker.kind !== "inWindow") return;
  assert.ok(marker.atMs > dayStart + 23 * 3600_000, "30일 밤이어야 한다");
  assert.ok(marker.atMs < dayStart + 24 * 3600_000);
});

test("a target date outside the window doesn't clamp the line to the edge — it reports direction and days remaining", () => {
  const now = Date.parse("2026-09-21T00:00:00");
  const win = { fromMs: now - 3600_000, toMs: now };
  const marker = targetMarker("2026-09-30", win, now);
  assert.equal(marker.kind, "outside");
  if (marker.kind !== "outside") return;
  assert.equal(marker.side, "after");
  assert.equal(marker.daysFromNow, 10, "9월 30일 밤까지면 10일 뒤로 올림된다");
});

test("a past target date comes out as a negative day count — the screen must be able to say it's overdue", () => {
  const now = Date.parse("2026-09-21T12:00:00");
  const win = { fromMs: now - 3600_000, toMs: now };
  const marker = targetMarker("2026-09-10", win, now);
  assert.equal(marker.kind, "outside");
  if (marker.kind !== "outside") return;
  assert.equal(marker.side, "before");
  assert.ok(marker.daysFromNow < 0);
});

// ---------------------------------------------------------------------------
// Dependency arrows
// ---------------------------------------------------------------------------

test("an arrow is only made when both cards are visible", () => {
  const layout = layoutTimeline(
    [
      run({ task_id: "parent", started_at: 1_100, ended_at: 1_200, profile: "a" }),
      run({ task_id: "child", started_at: 1_300, ended_at: 1_400, profile: "b" }),
    ],
    WIN,
    NOW,
  );
  const edges = dependencyEdges(layout.rows, [
    { parent_id: "parent", child_id: "child" },
    // The child isn't in the window — don't draw an arrow into empty space.
    { parent_id: "parent", child_id: "ghost" },
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].childTaskId, "child");
  assert.equal(edges[0].outOfOrder, false);
});

test("a child that started before its parent is shown, not hidden", () => {
  const layout = layoutTimeline(
    [
      run({ task_id: "parent", started_at: 1_300, ended_at: 1_900, profile: "a" }),
      run({ task_id: "child", started_at: 1_100, ended_at: 1_200, profile: "b" }),
    ],
    WIN,
    NOW,
  );
  const edges = dependencyEdges(layout.rows, [{ parent_id: "parent", child_id: "child" }]);
  assert.equal(edges[0].outOfOrder, true);
});

test("a card that ran more than once connects from its first start to its last end", () => {
  const layout = layoutTimeline(
    [
      run({ task_id: "parent", started_at: 1_100, ended_at: 1_200, profile: "a" }),
      run({ task_id: "parent", started_at: 1_300, ended_at: 1_500, profile: "a" }),
      run({ task_id: "child", started_at: 1_700, ended_at: 1_800, profile: "b" }),
    ],
    WIN,
    NOW,
  );
  const edges = dependencyEdges(layout.rows, [{ parent_id: "parent", child_id: "child" }]);
  assert.equal(edges.length, 1);
  // The parent's end is the end of its second run.
  assert.ok(edges[0].from.x > 0.2);
  assert.equal(edges[0].outOfOrder, false);
});

test("if today is the target date, it falls inside today's window — this is the core case for the feature", () => {
  const now = Date.parse("2026-09-21T09:00:00");
  const win = presetWindow("today", now);
  const marker = targetMarker("2026-09-21", win, now);
  assert.equal(marker.kind, "inWindow", "오늘 마감인데 선이 안 그려지면 기능이 없는 것과 같다");
});

test("tomorrow's target date is outside the window, so it's stated in words", () => {
  const now = Date.parse("2026-09-21T09:00:00");
  const win = presetWindow("today", now);
  const marker = targetMarker("2026-09-22", win, now);
  assert.equal(marker.kind, "outside");
});
