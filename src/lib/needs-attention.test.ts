import assert from "node:assert/strict";
import test from "node:test";

import { attentionOf, countNeedsAttention } from "./needs-attention";

const card = (id: string, status: string) => ({ id, status });

test("distinguishes a blocked card awaiting approval from one blocked by an error", () => {
  const pending = new Set(["c1"]);
  assert.equal(attentionOf(card("c1", "blocked"), pending), "awaiting_approval");
  assert.equal(attentionOf(card("c2", "blocked"), pending), "blocked");
});

test("awaiting review is itself a state that waits on a human", () => {
  assert.equal(attentionOf(card("c3", "review"), new Set()), "review");
});

test("states that need no human action are null", () => {
  for (const s of ["triage", "todo", "scheduled", "ready", "running", "done", "archived"])
    assert.equal(attentionOf(card("c", s), new Set()), null, s);
});

test("a card whose approval was resolved is no longer awaiting approval", () => {
  // After approval a card moves to ready, but it can still show as blocked in between polls.
  // At that point, if it dropped out of the pending-approval set, it's safer to read it as
  // blocked by an error — showing "please approve" again would make the user make the same
  // decision twice.
  assert.equal(attentionOf(card("c1", "blocked"), new Set()), "blocked");
});

test("counts are tallied per kind, plus a total", () => {
  const cards = [
    card("c1", "blocked"),
    card("c2", "blocked"),
    card("c3", "review"),
    card("c4", "running"),
  ];
  assert.deepEqual(countNeedsAttention(cards, new Set(["c1"])), {
    awaiting_approval: 1,
    blocked: 1,
    review: 1,
    total: 3,
  });
});

test("an empty board is 0", () => {
  assert.deepEqual(countNeedsAttention([], new Set()), {
    awaiting_approval: 0,
    blocked: 0,
    review: 0,
    total: 0,
  });
});
