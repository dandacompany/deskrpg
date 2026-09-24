import test from "node:test";
import assert from "node:assert/strict";

import { epochSecondsToMs } from "./epoch";

test("converts a plugin event's ts (seconds) to ms", () => {
  assert.equal(epochSecondsToMs(1_758_000_000), 1_758_000_000_000);
});
