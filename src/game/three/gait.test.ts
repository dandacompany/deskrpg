import assert from "node:assert/strict";
import test from "node:test";

import { createGaitTracker } from "./gait";

/** Walk at a constant speed (cells/second) for `seconds` at 60fps. */
function walk(
  tracker: ReturnType<typeof createGaitTracker>,
  tilesPerSecond: number,
  seconds: number,
) {
  const dt = 1 / 60;
  let gait = tracker.update(0, 0, dt, true);
  for (let i = 0; i < seconds * 60; i++) gait = tracker.update(tilesPerSecond * dt, 0, dt, true);
  return gait;
}

test("the call default speed (300px/s) runs, the usual walk (150px/s) walks", () => {
  assert.equal(walk(createGaitTracker(), 300 / 32, 1).running, true);
  assert.equal(walk(createGaitTracker(), 150 / 32, 1).running, false);
  assert.equal(walk(createGaitTracker(), 55 / 32, 1).running, false, "산책은 걷는다");
});

test("when running the step cycle is proportional to speed — running at 2× cycles about 2× (so the feet do not slide)", () => {
  const gait = walk(createGaitTracker(), 300 / 32, 1);
  assert.ok(Math.abs(gait.cadence - 2) < 0.05, `주기 ${gait.cadence}`);
});

test("does not flicker when jittering near the threshold — exits below the entry threshold", () => {
  const tracker = createGaitTracker();
  walk(tracker, 300 / 32, 1);
  // Still running even when dropping just below the threshold (225px/s).
  assert.equal(walk(tracker, 210 / 32, 1).running, true);
  // Walks once slow enough.
  assert.equal(walk(tracker, 150 / 32, 1).running, false);
});

test("does not run when stopped, and a teleport does not count as speed", () => {
  const tracker = createGaitTracker();
  walk(tracker, 300 / 32, 1);
  assert.equal(tracker.update(0, 0, 1 / 60, false).running, false);
  const fresh = createGaitTracker();
  // 10 cells in one frame — that is a relocation. It must not count as running.
  assert.equal(fresh.update(10, 0, 1 / 60, true).running, false);
  assert.ok(fresh.speed < 1, `순간이동이 속도에 섞였습니다: ${fresh.speed}`);
});

test("the same decision regardless of frame rate", () => {
  const at = (fps: number) => {
    const tracker = createGaitTracker();
    let gait = tracker.update(0, 0, 1 / fps, true);
    for (let i = 0; i < fps; i++) gait = tracker.update(((300 / 32) * 1) / fps, 0, 1 / fps, true);
    return gait;
  };
  assert.equal(at(30).running, at(120).running);
  assert.ok(Math.abs(at(30).cadence - at(120).cadence) < 0.05);
});
