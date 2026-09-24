import test from "node:test";
import assert from "node:assert/strict";

import { decideNpcClick, shouldRememberTarget } from "./npc-click-intent";

// --- When already standing next to them: the case where nothing used to happen ---

test("with an empty path, open the conversation right there", () => {
  assert.equal(decideNpcClick({ pathLength: 0, clickedNpcId: "npc-1" }), "interact-now");
});

test("even when the path is only one's own tile, open it right there", () => {
  // findPath includes the start tile — length 1 means "no need to move".
  assert.equal(decideNpcClick({ pathLength: 1, clickedNpcId: "npc-1" }), "interact-now");
});

// --- When apart: existing behavior ---

test("when walking is needed, defer the conversation until arrival", () => {
  assert.equal(decideNpcClick({ pathLength: 2, clickedNpcId: "npc-1" }), "walk-then-interact");
});

test("the same for long distances", () => {
  assert.equal(decideNpcClick({ pathLength: 9, clickedNpcId: "npc-1" }), "walk-then-interact");
});

// --- Clicking empty floor ---

test("if it is not an NPC, only move", () => {
  assert.equal(decideNpcClick({ pathLength: 5, clickedNpcId: null }), "walk-only");
});

test("if it is not an NPC, only move even with an empty path", () => {
  assert.equal(decideNpcClick({ pathLength: 0, clickedNpcId: null }), "walk-only");
});

// --- Remembering the target: where a polluted targetNpcId is blocked ---

test("remember the target only when waiting for arrival", () => {
  assert.equal(shouldRememberTarget("walk-then-interact"), true);
});

test("do not remember when talking immediately", () => {
  // If remembered, the next time you walk somewhere else and arrive, an unrelated conversation opens.
  assert.equal(shouldRememberTarget("interact-now"), false);
});

test("do not remember when only moving either", () => {
  assert.equal(shouldRememberTarget("walk-only"), false);
});
