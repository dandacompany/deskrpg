import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanEvent, KanbanRun } from "@/lib/hermes/deskrpg-plugin-types";

import { cardRunState, mixedAiOpinion, runAttempts } from "./kanban-run-history";

function run(over: Partial<KanbanRun> & { id: string }): KanbanRun {
  return { status: "done", started_at: 100, ended_at: 110, ...over };
}

test("attempts are numbered by start time, not by the order the plugin sent them", () => {
  const attempts = runAttempts([
    run({ id: "2", started_at: 200, outcome: "completed" }),
    run({ id: "1", started_at: 100, outcome: "crashed" }),
  ]);
  assert.deepEqual(
    attempts.map((a) => [a.run.id, a.ordinal, a.end]),
    [
      ["1", 1, "crashed"],
      ["2", 2, "completed"],
    ],
  );
});

test("a reclaimed run says whether someone stopped it, the worker went silent, or the card moved", () => {
  const [stopped, lost, moved, other] = runAttempts([
    run({
      id: "a",
      started_at: 1,
      outcome: "reclaimed",
      error: "manual_reclaim: terminated by deskrpg",
    }),
    run({ id: "b", started_at: 2, outcome: "reclaimed", error: "stale_lock=abc heartbeat lost" }),
    run({
      id: "c",
      started_at: 3,
      outcome: "reclaimed",
      summary: "status changed to todo (deskrpg/direct)",
    }),
    run({ id: "d", started_at: 4, outcome: "reclaimed" }),
  ]);
  assert.deepEqual(
    [stopped.end, lost.end, moved.end, other.end],
    ["stopped", "lost", "moved", "reclaimed"],
  );
});

test("a drag out of running reclaimed through Hermes reads as moved, not stopped", () => {
  const [attempt] = runAttempts([
    run({
      id: "m",
      started_at: 1,
      outcome: "reclaimed",
      error: "manual_reclaim: status changed to todo (deskrpg/direct)",
    }),
  ]);
  assert.equal(attempt.end, "moved");
});

test("a run without an end is still running", () => {
  const [attempt] = runAttempts([run({ id: "r", status: "running", ended_at: undefined })]);
  assert.equal(attempt.end, "running");
});

test("the failure cause is read the same way as the chat path, and a terminal provider exit reads as sign-in", () => {
  const [usage, auth, terminal, plain] = runAttempts([
    run({ id: "1", started_at: 1, outcome: "crashed", error: "HTTP 429: usage limit reached" }),
    run({ id: "2", started_at: 2, outcome: "crashed", error: "Incorrect API key provided" }),
    run({
      id: "3",
      started_at: 3,
      outcome: "crashed",
      error: "pid 9 exited on a terminal provider error (exit 3)",
      metadata: { terminal_provider: true },
    }),
    run({ id: "4", started_at: 4, outcome: "crashed", error: "pid 9 exited with code 1" }),
  ]);
  assert.deepEqual(
    [usage.cause, auth.cause, terminal.cause, plain.cause],
    ["usage_limit", "provider_auth", "provider_auth", null],
  );
});

test("events are grouped under the run they came from; card-level events belong to none", () => {
  const events: KanbanEvent[] = [
    { id: "e1", kind: "created", payload: {}, created_at: 1, run_id: null },
    { id: "e2", kind: "claimed", payload: {}, created_at: 2, run_id: 7 },
    { id: "e3", kind: "crashed", payload: {}, created_at: 3, run_id: 7 },
  ];
  const [attempt] = runAttempts([run({ id: "7", outcome: "crashed" })], events);
  assert.deepEqual(
    attempt.events.map((e) => e.kind),
    ["claimed", "crashed"],
  );
});

test("without run ids on events every attempt has an empty event list", () => {
  const events: KanbanEvent[] = [{ id: "e1", kind: "crashed", payload: {}, created_at: 3 }];
  const [attempt] = runAttempts([run({ id: "7", outcome: "crashed" })], events);
  assert.deepEqual(attempt.events, []);
});

test("a blocked card whose last try failed after repeated failures is waiting for a person", () => {
  const attempts = runAttempts([
    run({ id: "1", started_at: 1, outcome: "crashed" }),
    run({ id: "2", started_at: 2, outcome: "timed_out" }),
  ]);
  assert.deepEqual(cardRunState({ status: "blocked", consecutive_failures: 2 }, attempts), {
    kind: "gave_up",
    failures: 2,
  });
});

test("a failed card back in the queue will be retried by itself", () => {
  const attempts = runAttempts([run({ id: "1", outcome: "crashed" })]);
  assert.deepEqual(cardRunState({ status: "ready", consecutive_failures: 1 }, attempts), {
    kind: "retrying",
    failures: 1,
  });
});

test("a card blocked for another reason, or with no failures, has nothing to say", () => {
  const ok = runAttempts([run({ id: "1", outcome: "review_requested" })]);
  assert.equal(cardRunState({ status: "blocked", consecutive_failures: 1 }, ok), null);
  assert.equal(cardRunState({ status: "ready", consecutive_failures: 0 }, ok), null);
  assert.equal(cardRunState({ status: "done" }, ok), null);
});

test("a card finished outside DeskRPG says so in its run history", () => {
  const task = {
    status: "done",
    review: {
      policy: { version: 1, mode: "human", reviewer_profile: null },
      policy_revision: 1,
      submission: null,
      review_round: 0,
      state: "approved",
      reason: "external_done",
      approval: null,
    },
  } as Parameters<typeof cardRunState>[0];
  assert.deepEqual(cardRunState(task, []), { kind: "external_done" });
  assert.equal(cardRunState({ status: "done" }, []), null);
});

const mixedReview = (state: string) =>
  ({
    policy: { version: 1, mode: "mixed", reviewer_profile: "Rev" },
    policy_revision: 1,
    submission: null,
    review_round: 2,
    state,
    reason: null,
    approval: null,
  }) as never;

test("a mixed card waiting for a person shows the AI reviewer's latest verdict", () => {
  const runs = [
    {
      id: 1,
      profile: "impl",
      outcome: "review_requested",
      summary: "done",
      started_at: 10,
      ended_at: 20,
    },
    {
      id: 2,
      profile: "rev",
      outcome: "review_requested",
      summary: "old verdict",
      started_at: 30,
      ended_at: 40,
    },
    {
      id: 3,
      profile: "impl",
      outcome: "review_requested",
      summary: "fixed",
      started_at: 50,
      ended_at: 60,
    },
    {
      id: 4,
      profile: "rev",
      outcome: "review_requested",
      summary: "  pass: looks right  ",
      started_at: 70,
      ended_at: 80,
    },
    { id: 5, profile: "rev", outcome: "crashed", summary: "boom", started_at: 90, ended_at: 95 },
  ] as never[];
  assert.equal(mixedAiOpinion(mixedReview("human_required"), runs), "pass: looks right");
  assert.equal(mixedAiOpinion(mixedReview("reviewing"), runs), null, "only while a person decides");
  assert.equal(mixedAiOpinion(mixedReview("human_required"), []), null);
});
