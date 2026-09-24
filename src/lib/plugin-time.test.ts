import assert from "node:assert/strict";
import test from "node:test";

import { taskTimeMs } from "./plugin-time";

const EPOCH_SECONDS = 1758412800; // 2025-09-21T00:00:00Z
const AS_MS = EPOCH_SECONDS * 1000;

test("reads the epoch-seconds integer the plugin sends", () => {
  assert.equal(taskTimeMs(EPOCH_SECONDS), AS_MS);
});

test("Date.parse can't read this value — this test is the evidence for that defect", () => {
  // Why elapsed time used to silently disappear back when the screen called `Date.parse(task.started_at)`.
  assert.ok(Number.isNaN(Date.parse(String(EPOCH_SECONDS))));
});

test("also reads the ISO string the fake plugin server sends", () => {
  assert.equal(taskTimeMs(new Date(AS_MS).toISOString()), AS_MS);
});

test("a numeric-only string is read as epoch seconds", () => {
  assert.equal(taskTimeMs(String(EPOCH_SECONDS)), AS_MS);
});

test("a value already in ms is not multiplied by 1000", () => {
  assert.equal(taskTimeMs(AS_MS), AS_MS);
});

test("a missing or unreadable value is null — never 0 or NaN", () => {
  assert.equal(taskTimeMs(undefined), null);
  assert.equal(taskTimeMs(null), null);
  assert.equal(taskTimeMs(""), null);
  assert.equal(taskTimeMs("어제"), null);
  assert.equal(taskTimeMs(Number.NaN), null);
});

test("epoch 0 is different from having no value", () => {
  assert.equal(taskTimeMs(0), 0);
});
