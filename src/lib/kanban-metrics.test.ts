import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanStatusTransition, KanbanTimelineRun } from "@/lib/hermes/deskrpg-plugin-types";
import { countNeedsAttention } from "@/lib/needs-attention";
import {
  computeOperationalMetrics,
  countRework,
  hasEnoughSamples,
  MIN_RATE_SAMPLES,
} from "./kanban-metrics";

const WIN = { fromMs: 1_000_000, toMs: 2_000_000 };
const NO_APPROVALS: ReadonlySet<string> = new Set();

let seq = 0;
function run(over: Partial<KanbanTimelineRun> = {}): KanbanTimelineRun {
  seq += 1;
  return {
    id: `r${seq}`,
    status: "done",
    task_id: `t${seq}`,
    board: "default",
    started_at: 1_100,
    ended_at: 1_200,
    outcome: "completed",
    ...over,
  } as KanbanTimelineRun;
}

function metrics(
  runs: KanbanTimelineRun[],
  cards: { id: string; status: string }[] = [],
  pending: ReadonlySet<string> = NO_APPROVALS,
) {
  return computeOperationalMetrics(runs, cards, pending, WIN);
}

// ---------------------------------------------------------------------------
// Success rate — counted using outcome vocabulary
// ---------------------------------------------------------------------------

test("failures are not lumped together — each outcome keeps its own count", () => {
  const m = metrics([
    run({ outcome: "completed" }),
    run({ outcome: "crashed" }),
    run({ outcome: "gave_up" }),
    run({ outcome: "timed_out" }),
  ]);
  assert.equal(m.terminalRuns, 4);
  assert.equal(m.successRate, 0.25);
  assert.deepEqual(
    m.outcomes.map((o) => o.outcome).sort(),
    ["completed", "crashed", "gave_up", "timed_out"],
    "실패를 한 덩어리로 뭉개면 무엇을 고쳐야 하는지가 사라진다",
  );
});

test("a run handed to human review ended normally — it counts as success, not failure", () => {
  const m = metrics([
    run({ outcome: "review_requested" }),
    run({ outcome: "review_requested" }),
    run({ outcome: "crashed" }),
  ]);
  assert.equal(m.terminalRuns, 3);
  assert.equal(m.successRate, 2 / 3);
});

test("a card handed to review is not finished yet — it is counted apart from throughput", () => {
  const m = metrics([
    run({ task_id: "waiting", outcome: "review_requested" }),
    run({ task_id: "approved", outcome: "review_requested" }),
    run({ task_id: "approved", outcome: "completed", started_at: 1_500, ended_at: 1_500 }),
  ]);
  assert.equal(m.throughput, 1, "only the approved card is done");
  assert.equal(m.handedOff, 1, "the card still waiting for a human is counted on its own");
});

test("approval board: review hand-offs give the duration, the zero-length approval run does not", () => {
  // Hermes records a human approval as a synthesized `completed` run with started_at == ended_at.
  const m = metrics([
    run({ task_id: "a", outcome: "review_requested", started_at: 1_100, ended_at: 1_130 }),
    run({ task_id: "a", outcome: "completed", started_at: 1_500, ended_at: 1_500 }),
  ]);
  assert.deepEqual(m.duration, { medianMs: 30_000, samples: 1 });
  assert.equal(m.successRate, 1);
});

test("success rate is null when there are no finished runs — showing 0% would be a lie", () => {
  const m = metrics([run({ ended_at: undefined, outcome: undefined })]);
  assert.equal(m.successRate, null);
  assert.equal(m.terminalRuns, 0);
  assert.equal(m.openRuns, 1);
});

test("a run that finished with no outcome is counted as unrecorded — nothing is made up", () => {
  const m = metrics([run({ outcome: undefined })]);
  assert.deepEqual(m.outcomes, [{ outcome: "unrecorded", count: 1 }]);
  assert.equal(m.successRate, 0);
});

test("outcome distribution sorts by count descending, ties broken by name", () => {
  const m = metrics([
    run({ outcome: "crashed" }),
    run({ outcome: "crashed" }),
    run({ outcome: "completed" }),
    run({ outcome: "blocked" }),
  ]);
  assert.deepEqual(
    m.outcomes.map((o) => `${o.outcome}:${o.count}`),
    ["crashed:2", "blocked:1", "completed:1"],
  );
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

test("a run that finished outside the window is not this window's result", () => {
  // Counting anything that merely overlaps would double-count the same run across two windows.
  const m = metrics([
    run({ started_at: 900, ended_at: 999 }), // ended before the window
    run({ started_at: 900, ended_at: 1_500 }), // ended inside the window — counted
    run({ started_at: 1_900, ended_at: 2_500 }), // ended after the window
  ]);
  assert.equal(m.terminalRuns, 1);
});

test("a still-running run is excluded from the success-rate denominator and counted separately", () => {
  const m = metrics([
    run({ outcome: "completed" }),
    run({ ended_at: undefined, outcome: undefined }),
  ]);
  assert.equal(m.terminalRuns, 1);
  assert.equal(m.openRuns, 1);
  assert.equal(m.successRate, 1);
});

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

test("throughput is a card count — the same card succeeding multiple times counts once", () => {
  const m = metrics([
    run({ task_id: "same", outcome: "completed" }),
    run({ task_id: "same", outcome: "completed" }),
    run({ task_id: "other", outcome: "completed" }),
  ]);
  assert.equal(m.throughput, 2);
});

test("a failed run doesn't count toward throughput", () => {
  const m = metrics([run({ task_id: "a", outcome: "crashed" })]);
  assert.equal(m.throughput, 0);
});

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

test("duration is the median, reported together with the sample count", () => {
  const m = metrics([
    run({ started_at: 1_100, ended_at: 1_110 }),
    run({ started_at: 1_200, ended_at: 1_230 }),
    run({ started_at: 1_300, ended_at: 1_320 }),
  ]);
  assert.equal(m.duration.samples, 3);
  assert.equal(m.duration.medianMs, 20_000, "10·20·30초의 중앙값은 20초다");
});

test("with an even sample count, it's the average of the middle two", () => {
  const m = metrics([
    run({ started_at: 1_100, ended_at: 1_110 }),
    run({ started_at: 1_200, ended_at: 1_230 }),
  ]);
  assert.equal(m.duration.medianMs, 20_000);
});

test("the median isn't pulled by outliers — a mean would give a different answer", () => {
  const m = metrics([
    run({ started_at: 1_100, ended_at: 1_110 }),
    run({ started_at: 1_200, ended_at: 1_210 }),
    run({ started_at: 1_300, ended_at: 1_900 }),
  ]);
  assert.equal(m.duration.medianMs, 10_000);
});

test("with no samples, the median is null and the sample count is 0", () => {
  const m = metrics([run({ outcome: "crashed" })]);
  assert.deepEqual(m.duration, { medianMs: null, samples: 0 });
});

test("a failed run's duration is never mixed in — duration means something different there", () => {
  const m = metrics([
    run({ outcome: "completed", started_at: 1_100, ended_at: 1_110 }),
    run({ outcome: "timed_out", started_at: 1_200, ended_at: 1_900 }),
  ]);
  assert.equal(m.duration.samples, 1);
  assert.equal(m.duration.medianMs, 10_000);
});

test("a run whose timestamps can't be read is excluded from duration samples but stays in the outcome distribution", () => {
  const m = metrics([run({ outcome: "completed", started_at: undefined, ended_at: 1_200 })]);
  assert.equal(m.duration.samples, 0);
  assert.equal(m.terminalRuns, 1);
});

// ---------------------------------------------------------------------------
// Cards needing attention — same count as the decision collection
// ---------------------------------------------------------------------------

test("uses the shared function instead of counting attention-needed cards itself", () => {
  const cards = [
    { id: "a", status: "review" },
    { id: "b", status: "blocked" },
    { id: "c", status: "blocked" },
    { id: "d", status: "running" },
  ];
  const pending = new Set(["b"]);
  const m = metrics([], cards, pending);
  // If the two counted separately they'd get different numbers, and nobody could tell which is right.
  assert.deepEqual(m.attention, countNeedsAttention(cards, pending));
  assert.equal(m.attention.awaiting_approval, 1);
  assert.equal(m.attention.blocked, 1);
  assert.equal(m.attention.review, 1);
  assert.equal(m.attention.total, 3);
});

test("when the pending-approval set is empty, blocked is read as blocked by an error", () => {
  // If approval was resolved but the card is still shown as blocked, showing "please
  // approve" again would make the user make the same decision twice.
  const m = metrics([], [{ id: "b", status: "blocked" }], new Set());
  assert.equal(m.attention.awaiting_approval, 0);
  assert.equal(m.attention.blocked, 1);
});

// ---------------------------------------------------------------------------
// Sample threshold
// ---------------------------------------------------------------------------

test("does not show a rate as a number when the sample size is too small", () => {
  assert.equal(hasEnoughSamples(MIN_RATE_SAMPLES - 1), false);
  assert.equal(hasEnoughSamples(MIN_RATE_SAMPLES), true);
  assert.equal(hasEnoughSamples(0), false);
});

// ---------------------------------------------------------------------------
// Rework — review → todo/ready transitions that happened inside the window
// ---------------------------------------------------------------------------

let transitionSeq = 0;
function transition(over: Partial<KanbanStatusTransition> = {}): KanbanStatusTransition {
  transitionSeq += 1;
  return {
    id: transitionSeq,
    task_id: "t1",
    board: "default",
    from: "review",
    to: "todo",
    created_at: 1_500,
    ...over,
  };
}

test("rework counts returns from review to todo or ready, and the cards they happened to", () => {
  const stats = countRework(
    [
      transition({ task_id: "a", to: "todo" }),
      transition({ task_id: "a", to: "ready" }),
      transition({ task_id: "b", to: "ready" }),
    ],
    WIN,
  );
  assert.deepEqual(stats, { returns: 3, cards: 2 });
});

test("rework does not count a return that happened outside the window", () => {
  // Same rule as finished runs: a return belongs to the window it happened in, not to every
  // window in which the card is still being reworked.
  const stats = countRework(
    [
      transition({ task_id: "before", created_at: 999 }),
      transition({ task_id: "inside", created_at: 1_000 }),
      transition({ task_id: "inside-end", created_at: 2_000 }),
      transition({ task_id: "after", created_at: 2_001 }),
    ],
    WIN,
  );
  assert.deepEqual(stats, { returns: 2, cards: 2 });
});

test("other transitions are not rework", () => {
  const stats = countRework(
    [
      transition({ from: "running", to: "review" }),
      transition({ from: "review", to: "done" }),
      transition({ from: "review", to: "blocked" }),
      transition({ from: null, to: "todo" }),
      transition({ from: "blocked", to: "ready" }),
    ],
    WIN,
  );
  assert.deepEqual(stats, { returns: 0, cards: 0 });
});

test("without transitions the rework metric is unknown, not zero", () => {
  assert.equal(metrics([]).rework, null);
  assert.deepEqual(computeOperationalMetrics([], [], NO_APPROVALS, WIN, []).rework, {
    returns: 0,
    cards: 0,
  });
});

test("a swarm root's instant completion is structure, not throughput or success", () => {
  const metrics = computeOperationalMetrics(
    [
      run({ metadata: { kind: "kanban_swarm_v1", goal: "g" } }),
      // The timeline route can pass the sqlite JSON text through.
      run({ metadata: '{"kind": "kanban_swarm_v1"}' } as unknown as Partial<KanbanTimelineRun>),
      run(),
    ],
    [],
    NO_APPROVALS,
    WIN,
  );
  assert.equal(metrics.throughput, 1);
  assert.equal(metrics.terminalRuns, 1);
});
