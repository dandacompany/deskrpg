import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FloorInbox } from "./inbox";

const always = () => true;
const noop = () => {};

/** Calls take repeatedly until the queue is empty, pulling the speaking order into an array. */
function drainAll(
  inbox: FloorInbox,
  isEligible: (npcId: string) => boolean = always,
  onSkipped: (npcId: string) => void = noop,
): string[] {
  const out: string[] = [];
  for (;;) {
    const next = inbox.take(isEligible, onSkipped);
    if (next === null) return out;
    out.push(next);
  }
}

describe("FloorInbox", () => {
  test("an empty inbox returns null", () => {
    assert.equal(new FloorInbox().take(always, noop), null);
  });

  test("mentions come out in the order they arrived — none are dropped", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "mention");
    assert.deepEqual(drainAll(inbox), ["b", "c", "d"]);
  });

  test("a user call jumps ahead of pending mentions, and the mentions remain", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "user");
    assert.deepEqual(drainAll(inbox), ["d", "b", "c"]);
  });

  test("with two user calls, only the last one remains", () => {
    const inbox = new FloorInbox();
    inbox.push("a", "user");
    inbox.push("b", "user");
    assert.deepEqual(drainAll(inbox), ["b"]);
  });

  test("mentioning the same NPC twice yields it once, keeping its original position", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("b", "mention");
    assert.deepEqual(drainAll(inbox), ["b", "c"]);
  });

  test("a user call absorbs that same NPC's pending mention — it doesn't speak twice", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("b", "user");
    assert.deepEqual(drainAll(inbox), ["b", "c"]);
  });

  test("an ineligible mention is skipped and reported via onSkipped", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    const skipped: string[] = [];
    const order = drainAll(
      inbox,
      (npcId) => npcId !== "b",
      (npcId) => skipped.push(npcId),
    );
    assert.deepEqual(order, ["c"]);
    assert.deepEqual(skipped, ["b"], "건너뛴 지목은 무음으로 사라지면 안 된다");
  });

  test("a user call is not subject to eligibility checks — it bypasses the quota", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "user");
    const skipped: string[] = [];
    const order = drainAll(
      inbox,
      () => false,
      (npcId) => skipped.push(npcId),
    );
    assert.deepEqual(order, ["b"]);
    assert.deepEqual(skipped, []);
  });

  test("pendingCount counts the pending grants", () => {
    const inbox = new FloorInbox();
    assert.equal(inbox.pendingCount(), 0);
    inbox.push("b", "mention");
    inbox.push("c", "mention");
    inbox.push("d", "user");
    assert.equal(inbox.pendingCount(), 3);
    inbox.take(always, noop);
    assert.equal(inbox.pendingCount(), 2);
  });

  test("clear empties everything", () => {
    const inbox = new FloorInbox();
    inbox.push("b", "mention");
    inbox.push("d", "user");
    inbox.clear();
    assert.equal(inbox.pendingCount(), 0);
    assert.equal(inbox.take(always, noop), null);
  });
});
