import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";

import KanbanTimeline from "./KanbanTimeline";

// `I18nProvider`'s default locale is English — wording assertions use en values.

const FROM = Date.parse("2026-09-21T00:00:00.000Z");
const TO = Date.parse("2026-09-21T12:00:00.000Z");
const NOW = Date.parse("2026-09-21T10:00:00.000Z");

let seq = 0;
function run(over: Partial<KanbanTimelineRun> = {}): KanbanTimelineRun {
  seq += 1;
  return {
    id: `r${seq}`,
    status: "done",
    task_id: `t${seq}`,
    board: "default",
    profile: "sophie",
    task_title: `카드 ${seq}`,
    started_at: Math.floor(Date.parse("2026-09-21T01:00:00.000Z") / 1000),
    ended_at: Math.floor(Date.parse("2026-09-21T01:10:00.000Z") / 1000),
    outcome: "completed",
    ...over,
  } as KanbanTimelineRun;
}

async function mount(props: Partial<React.ComponentProps<typeof KanbanTimeline>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  const presets: string[] = [];
  await act(async () => {
    root.render(
      <I18nProvider>
        <KanbanTimeline
          runs={[run()]}
          window={{ fromMs: FROM, toMs: TO }}
          preset="today"
          onPresetChange={(p) => presets.push(p)}
          now={NOW}
          truncated={false}
          loading={false}
          error={null}
          onOpenTask={(id) => opened.push(id)}
          targetDate={null}
          links={[]}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return { host, opened, presets };
}

test("a table fallback with the same data appears alongside the SVG", async () => {
  // SVG doesn't get read as a whole by screen readers and can't be scanned by keyboard. Not optional.
  const { host } = await mount({ runs: [run(), run({ profile: "oliver" })] });
  assert.ok(host.querySelector("svg"), "그림이 없다");
  const details = host.querySelector("details");
  assert.ok(details, "표 대체본이 없다");
  const rows = details.querySelectorAll("tbody tr");
  assert.equal(rows.length, 2, "표가 막대와 같은 건수를 내야 한다");
});

test("clicking a card name in the table opens that card", async () => {
  const { host, opened } = await mount({ runs: [run({ task_id: "task-42" })] });
  const button = host.querySelector("tbody button");
  assert.ok(button);
  await act(async () => {
    (button as HTMLElement).click();
  });
  assert.deepEqual(opened, ["task-42"]);
});

test("each worker gets a row, and the name is written on the drawing", async () => {
  const { host } = await mount({
    runs: [run({ profile: "sophie" }), run({ profile: "oliver" })],
  });
  const text = host.querySelector("svg")?.textContent ?? "";
  assert.ok(text.includes("sophie"));
  assert.ok(text.includes("oliver"));
});

test("a run with an unknown worker still gets its own row", async () => {
  const { host } = await mount({ runs: [run({ profile: undefined })] });
  assert.ok(host.textContent?.includes("Unknown worker"));
});

test("colors outcomes by meaning — 'there's something to do' is not colored as a failure", async () => {
  const { host } = await mount({
    runs: [
      run({ outcome: "completed" }),
      run({ outcome: "crashed" }),
      run({ outcome: "rate_limited" }),
    ],
  });
  const classes = [...host.querySelectorAll("svg rect")].map((r) => r.getAttribute("class"));
  assert.ok(classes.includes("fill-success"));
  assert.ok(classes.includes("fill-danger"));
  // Hitting a limit isn't a failure — it's a state where the user has something to do. Red would
  // cause that task to be missed.
  // There is no `warning` token, so `fill-warning` renders no color at all — use a token that exists.
  assert.ok(classes.includes("fill-npc"), "조치 필요는 실패와 다른 색이어야 한다");
  assert.equal(
    classes.filter((c) => c === "fill-text-muted").length,
    0,
    "아는 결과가 '기타' 회색으로 빠졌습니다",
  );
});

test("an unknown outcome still shows its own name in the legend — not flattened to gray", async () => {
  // Observed in staging 0.11.1: 177 of 178 runs were `rate_limited`, which wasn't in the color
  // mapping and rendered gray. `outcome` is an open vocabulary owned by the Hermes core, so it can
  // grow further — even when a color can't be chosen, the name must not be lost.
  const { host } = await mount({
    runs: [run({ outcome: "some_future_outcome" }), run({ outcome: "rate_limited" })],
  });
  const labels = [...host.querySelectorAll("[data-timeline-legend]")].map((n) =>
    n.getAttribute("data-timeline-legend"),
  );
  assert.ok(
    labels.includes("some_future_outcome"),
    `범례가 모르는 결과의 이름을 잃었습니다: ${labels.join(", ")}`,
  );
  assert.ok(labels.includes("rate_limited"));
  const shown = host.querySelector('[data-timeline-legend="some_future_outcome"]');
  assert.equal(shown?.textContent, "some_future_outcome", "범례가 값 대신 다른 글자를 씁니다");
});

test("axis labels differ from each other in a window spanning more than a day — not all the same time", async () => {
  // Shape of the observed bug: all seven ticks in a week-long window read "9:00 AM."
  const from = Date.parse("2026-09-15T00:00:00.000Z");
  const started = Math.floor((from + 3600_000) / 1000);
  const { host } = await mount({
    window: { fromMs: from, toMs: from + 7 * 24 * 3600_000 },
    preset: "week",
    runs: [run({ started_at: started, ended_at: started + 60 })],
  });
  const labels = [...host.querySelectorAll("svg text")]
    .map((n) => n.textContent ?? "")
    .filter((text) => text.length > 0);
  assert.ok(labels.length >= 2, `축 라벨이 ${labels.length}개입니다`);
  assert.equal(
    new Set(labels).size,
    labels.length,
    `축 라벨이 서로 겹칩니다: ${labels.join(" | ")}`,
  );
});

test("an unfinished run is drawn dimmed and marked as still running in the table", async () => {
  const { host } = await mount({
    runs: [
      run({
        ended_at: undefined,
        outcome: undefined,
        started_at: Math.floor(Date.parse("2026-09-21T09:00:00.000Z") / 1000),
      }),
    ],
  });
  const rect = host.querySelector("svg rect");
  assert.ok(Number(rect?.getAttribute("opacity")) < 1, "여기까지 확실하다는 표시가 필요하다");
  assert.ok(host.querySelector("tbody")?.textContent?.includes("Still running"));
});

test("the screen says so when truncated", async () => {
  const { host } = await mount({ truncated: true });
  assert.ok(host.textContent?.includes("showing the most recent"));
});

test("discloses the count dropped for falling outside the window", async () => {
  const { host } = await mount({
    runs: [run(), run({ started_at: 10, ended_at: 20 })],
  });
  assert.ok(host.textContent?.includes("outside this range"));
});

test("a fetch failure is not papered over by an empty timeline", async () => {
  // "nobody has worked" and "can't be asked" are different things.
  const { host } = await mount({ error: "게이트웨이 연결 실패", runs: [] });
  assert.ok(host.textContent?.includes("게이트웨이 연결 실패"));
  assert.equal(host.textContent?.includes("No runs recorded"), false);
});

test("says so when there's no recorded history", async () => {
  const { host } = await mount({ runs: [] });
  assert.ok(host.textContent?.includes("No runs recorded"));
});

test("the range buttons reveal selected state and announce a change", async () => {
  const { host, presets } = await mount({ preset: "today" });
  const buttons = [...host.querySelectorAll("button[aria-pressed]")];
  const today = buttons.find((b) => b.textContent === "Today");
  // A rolling 7 days, not a calendar week — the wording says so too (2026-09-21 decision).
  const week = buttons.find((b) => b.textContent === "Last 7 days");
  assert.equal(today?.getAttribute("aria-pressed"), "true");
  assert.ok(week);
  await act(async () => {
    (week as HTMLElement).click();
  });
  assert.deepEqual(presets, ["week"]);
});

test("even a very short run has a visible width", async () => {
  // An invisible one-second failure is as good as not existing.
  const start = Math.floor(Date.parse("2026-09-21T05:00:00.000Z") / 1000);
  const { host } = await mount({
    runs: [run({ started_at: start, ended_at: start, outcome: "crashed" })],
  });
  const width = Number(host.querySelector("svg rect")?.getAttribute("width"));
  assert.ok(width >= 2, `폭이 ${width} 로 사실상 보이지 않는다`);
});

test("with no target date, draws no vertical line and marks it unset", async () => {
  // There's no screen for creating a project yet, so having no value is the default. A deadline that doesn't exist is never drawn in.
  const { host } = await mount({ targetDate: null });
  assert.ok(host.textContent?.includes("No target date"));
  assert.ok(!host.querySelector("line.stroke-danger"));
});

test("draws a vertical line when the target date is inside the window", async () => {
  // The target date is the end of a **local date**. Since the window is absolute time, it must be
  // built to cover that day — a window set in UTC can miss that day's end depending on timezone
  // (this test itself was wrong that way at first).
  const dayStart = Date.parse("2026-09-21T00:00:00");
  const { host } = await mount({
    targetDate: "2026-09-21",
    window: { fromMs: dayStart, toMs: dayStart + 24 * 3600_000 },
    // With no bars, the drawing itself isn't rendered (replaced by an empty-state message) — a
    // deadline line with nothing to compare against says nothing. So this puts one run in the window.
    runs: [
      run({
        started_at: Math.floor((dayStart + 3600_000) / 1000),
        ended_at: Math.floor((dayStart + 7200_000) / 1000),
      }),
    ],
  });
  const line = host.querySelector("line.stroke-danger");
  assert.ok(line, "창 안 목표일인데 선이 없다");
  assert.ok(host.textContent?.includes("Target"));
});

test("with the target date outside the window, shows days remaining instead of a line", async () => {
  // Pinning the line to the window edge would make the target date look like it falls at that instant.
  const { host } = await mount({ targetDate: "2026-10-15" });
  assert.ok(!host.querySelector("line.stroke-danger"));
  assert.ok(host.textContent?.includes("days left"));
});

test("a past target date is marked overdue", async () => {
  const { host } = await mount({ targetDate: "2026-09-01" });
  assert.ok(host.textContent?.includes("overdue"));
});

// A local clock and a window that ends before today, so the chip states the day count.
const LOCAL_NOW = Date.parse("2026-09-26T10:00:00");
const EARLIER_WINDOW = {
  fromMs: LOCAL_NOW - 3 * 24 * 3600_000,
  toMs: LOCAL_NOW - 2 * 24 * 3600_000,
};

test("yesterday's target reads one day overdue, not zero days left", async () => {
  const { host } = await mount({
    targetDate: "2026-09-25",
    now: LOCAL_NOW,
    window: EARLIER_WINDOW,
  });
  assert.match(host.textContent ?? "", /\(1 days overdue\)/);
  assert.ok(!/days left/.test(host.textContent ?? ""));
});

test("today's target reads today, not one day left", async () => {
  const { host } = await mount({
    targetDate: "2026-09-26",
    now: LOCAL_NOW,
    window: EARLIER_WINDOW,
  });
  assert.match(host.textContent ?? "", /\(today\)/);
  assert.ok(!/days left/.test(host.textContent ?? ""));
});

test("tomorrow's target reads one day left", async () => {
  const { host } = await mount({
    targetDate: "2026-09-27",
    now: LOCAL_NOW,
    window: EARLIER_WINDOW,
  });
  assert.match(host.textContent ?? "", /\(1 days left\)/);
});

test("only a link where both cards are visible becomes an arrow", async () => {
  const parent = run({ task_id: "p", profile: "a" });
  const child = run({
    task_id: "c",
    profile: "b",
    started_at: Math.floor(Date.parse("2026-09-21T02:00:00.000Z") / 1000),
    ended_at: Math.floor(Date.parse("2026-09-21T02:10:00.000Z") / 1000),
  });
  const { host } = await mount({
    runs: [parent, child],
    links: [
      { parent_id: "p", child_id: "c" },
      { parent_id: "p", child_id: "ghost" },
    ],
  });
  const arrows = [...host.querySelectorAll("line")].filter((l) =>
    l.getAttribute("class")?.includes("stroke-text-dim"),
  );
  assert.equal(arrows.length, 1, "허공으로 들어가는 화살표를 만들면 없는 관계를 암시한다");
});

test("a link with reversed order is shown with a dashed line", async () => {
  const parent = run({
    task_id: "p",
    profile: "a",
    started_at: Math.floor(Date.parse("2026-09-21T03:00:00.000Z") / 1000),
    ended_at: Math.floor(Date.parse("2026-09-21T04:00:00.000Z") / 1000),
  });
  const child = run({ task_id: "c", profile: "b" });
  const { host } = await mount({
    runs: [parent, child],
    links: [{ parent_id: "p", child_id: "c" }],
  });
  const dashed = [...host.querySelectorAll("line")].filter(
    (l) => l.getAttribute("stroke-dasharray") === "3 2",
  );
  assert.equal(dashed.length, 1);
});
