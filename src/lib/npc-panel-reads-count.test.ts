import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneSeenIds, unseenCardCount, unseenCronCount } from "./npc-panel-reads-count";

test("a seen card is not counted", () => {
  assert.equal(unseenCardCount(["a", "b", "c"], ["a"]), 2);
  assert.equal(unseenCardCount(["a"], ["a"]), 0);
  assert.equal(unseenCardCount([], ["a", "b"]), 0);
});

test("an id no longer assigned is pruned — the set doesn't grow forever", () => {
  assert.deepEqual(pruneSeenIds(["a", "b"], ["a", "옛것", "또옛것"]), ["a"]);
  assert.deepEqual(pruneSeenIds([], ["a"]), []);
});

test("cron only counts after seenAt", () => {
  const times = ["2026-09-20T00:00:00Z", "2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z"];
  assert.equal(unseenCronCount(times, "2026-09-21T00:00:00Z"), 1);
  assert.equal(unseenCronCount(times, null), 3);
  assert.equal(unseenCronCount(times, "2026-09-23T00:00:00Z"), 0);
});

test("a timestamp exactly equal to seenAt is treated as already seen", () => {
  assert.equal(unseenCronCount(["2026-09-21T00:00:00Z"], "2026-09-21T00:00:00Z"), 0);
});
