import assert from "node:assert/strict";
import test from "node:test";

import {
  CITYSCAPE_WALKER_FRAME_INTERVAL,
  createWalkerSpeed,
  shouldAdvanceWalkerFrame,
} from "./cityscape-motion";

test("createWalkerSpeed keeps pedestrians in a slower movement range", () => {
  assert.equal(createWalkerSpeed(0), 0.65);
  assert.equal(createWalkerSpeed(1), 1.05);
  assert.equal(createWalkerSpeed(0.5), 0.85);
});

test("walker animation advances less often for a calmer walk cycle", () => {
  assert.equal(CITYSCAPE_WALKER_FRAME_INTERVAL, 8);
  assert.equal(shouldAdvanceWalkerFrame(0), true);
  assert.equal(shouldAdvanceWalkerFrame(5), false);
  assert.equal(shouldAdvanceWalkerFrame(8), true);
});
