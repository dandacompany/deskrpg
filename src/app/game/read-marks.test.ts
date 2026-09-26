import assert from "node:assert/strict";
import test from "node:test";

import { isLookingAt, needsReadMark } from "./read-marks";

test("looking at a room needs both the panel on it and the tab in front", () => {
  assert.equal(isLookingAt("r1", "r1", true), true);
  assert.equal(isLookingAt("r1", "r1", false), false);
  assert.equal(isLookingAt("r2", "r1", true), false);
  assert.equal(isLookingAt(null, "r1", true), false);
});

test("a read mark is needed for unread lines or a last line after the read point", () => {
  assert.equal(needsReadMark({ unread: 2 }), true);
  assert.equal(
    needsReadMark({ lastAt: "2026-09-26T10:01:00.000Z", readAt: "2026-09-26T10:00:00.000Z" }),
    true,
  );
  assert.equal(
    needsReadMark({ lastAt: "2026-09-26T10:00:00.000Z", readAt: "2026-09-26T10:00:00.000Z" }),
    false,
  );
  // No read point known yet — the list hasn't told us; don't mark blindly.
  assert.equal(needsReadMark({ lastAt: "2026-09-26T10:00:00.000Z", readAt: null }), false);
});
