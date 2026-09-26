import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanStatusTransition, KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import { computeOperationalMetrics, MIN_RATE_SAMPLES } from "@/lib/kanban-metrics";

import KanbanMetricsPanel from "./KanbanMetricsPanel";

// `I18nProvider`'s default locale is English.

const WIN = { fromMs: 1_000_000, toMs: 2_000_000 };

let seq = 0;
function run(over: Partial<KanbanTimelineRun> = {}): KanbanTimelineRun {
  seq += 1;
  return {
    id: `r${seq}`,
    status: "done",
    task_id: `t${seq}`,
    board: "default",
    started_at: 1_100,
    ended_at: 1_110,
    outcome: "completed",
    ...over,
  } as KanbanTimelineRun;
}

async function mount(
  runs: KanbanTimelineRun[],
  cards: { id: string; status: string }[] = [],
  pending: ReadonlySet<string> = new Set(),
  transitions: KanbanStatusTransition[] | null = null,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const metrics = computeOperationalMetrics(runs, cards, pending, WIN, transitions);
  await act(async () => {
    root.render(
      <I18nProvider>
        <KanbanMetricsPanel metrics={metrics} />
      </I18nProvider>,
    );
  });
  return host;
}

test("shows the raw count instead of a ratio when the sample is below the threshold", async () => {
  // Writing 1 out of 2 as "50%" would read as a trend that isn't there.
  const host = await mount([run({ outcome: "completed" }), run({ outcome: "crashed" })]);
  assert.ok(host.textContent?.includes("1 of 2"));
  assert.equal(host.textContent?.includes("50%"), false);
});

test("shows the ratio as a number when the sample is large enough", async () => {
  const runs = Array.from({ length: MIN_RATE_SAMPLES }, () => run({ outcome: "completed" }));
  const host = await mount(runs);
  assert.ok(host.textContent?.includes("100%"));
});

test("with no finished runs, success rate is no data — not 0%", async () => {
  const host = await mount([run({ ended_at: undefined, outcome: undefined })]);
  assert.ok(host.textContent?.includes("No data"));
  assert.equal(host.textContent?.includes("0%"), false);
});

test("the median is always accompanied by the sample count", async () => {
  const host = await mount([run()]);
  assert.ok(host.textContent?.includes("1 samples"), "표본 수 없이 중앙값만 보이면 추세로 읽힌다");
});

test("when there are cards needing attention, they're broken down by kind and emphasized", async () => {
  const cards = [
    { id: "a", status: "review" },
    { id: "b", status: "blocked" },
    { id: "c", status: "blocked" },
  ];
  const host = await mount([], cards, new Set(["b"]));
  const text = host.textContent ?? "";
  assert.ok(text.includes("awaiting approval"));
  assert.ok(text.includes("in review"));
  assert.ok(text.includes("blocked"));
  // This cell calls for action right now, so it must stand out.
  assert.ok(host.querySelector(".border-danger"), "강조 표시가 없다");
});

test("does not emphasize when there are no cards needing attention", async () => {
  const host = await mount([run()], [{ id: "a", status: "running" }]);
  assert.ok(!host.querySelector(".border-danger"));
});

test("lists the outcome distribution by kind", async () => {
  const host = await mount([
    run({ outcome: "crashed" }),
    run({ outcome: "gave_up" }),
    run({ outcome: "completed" }),
  ]);
  const text = host.textContent ?? "";
  for (const label of ["Crashed", "Gave up", "Completed"]) {
    assert.ok(text.includes(label), `${label} is missing from the distribution`);
  }
});

test("outcome names are translated, and a value the screen does not know keeps its raw name", async () => {
  const host = await mount([
    run({ outcome: "review_requested" }),
    run({ outcome: "brand_new_outcome" }),
  ]);
  const text = host.textContent ?? "";
  assert.equal(text.includes("review_requested"), false, "the raw value must not show");
  assert.ok(text.includes("Sent for review"));
  assert.ok(text.includes("brand_new_outcome"), "an unknown value is never renamed or dropped");
});

test("an approval board shows its hand-offs as success and the cards waiting for a person", async () => {
  const host = await mount([
    run({ task_id: "a", outcome: "review_requested" }),
    run({ task_id: "b", outcome: "review_requested" }),
  ]);
  const text = host.textContent ?? "";
  assert.ok(text.includes("Handed to review2"), "the hand-off cell shows the card count");
  assert.ok(text.includes("2 of 2"), "both runs count as successes");
});

test("the hand-off cell stays hidden when nothing is waiting for review", async () => {
  const host = await mount([run()]);
  assert.equal(host.querySelector('[data-metric="handedOff"]') !== null, false);
});

test("does not show that cell when there are no runs in progress", async () => {
  const host = await mount([run()]);
  assert.equal(host.textContent?.includes("Still running"), false);
});

function sentBack(taskId: string, id: number): KanbanStatusTransition {
  return { id, task_id: taskId, board: "default", from: "review", to: "todo", created_at: 1_500 };
}

test("rework shows how many times results were sent back and to how many cards", async () => {
  const host = await mount([run()], [], new Set(), [
    sentBack("a", 1),
    sentBack("a", 2),
    sentBack("b", 3),
  ]);
  const cell = host.querySelector('[data-metric="rework"]');
  assert.equal(cell !== null, true);
  assert.equal(cell?.textContent, "Rework32 cards");
});

test("rework shows 0 when transitions are known and none were returns", async () => {
  const host = await mount([run()], [], new Set(), []);
  assert.equal(host.querySelector('[data-metric="rework"]')?.textContent, "Rework0");
});

test("the rework cell stays hidden when transitions can't be asked for", async () => {
  const host = await mount([run()]);
  assert.equal(host.querySelector('[data-metric="rework"]') !== null, false);
});
