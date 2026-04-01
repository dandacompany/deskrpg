import assert from "node:assert/strict";
import test from "node:test";

import { computeMeetingTopicRows } from "./start-form";

test("computeMeetingTopicRows keeps a compact minimum", () => {
  assert.equal(computeMeetingTopicRows(""), 2);
  assert.equal(computeMeetingTopicRows("short topic"), 2);
});

test("computeMeetingTopicRows grows for multiline and long content", () => {
  assert.equal(computeMeetingTopicRows("line1\nline2\nline3"), 3);
  assert.equal(computeMeetingTopicRows("x".repeat(190)), 4);
});

test("computeMeetingTopicRows is capped", () => {
  assert.equal(computeMeetingTopicRows(["a", "b", "c", "d", "e", "f"].join("\n")), 5);
});
