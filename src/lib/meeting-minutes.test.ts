import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMeetingMinutesRecord } from "./meeting-minutes";

test("normalizeMeetingMinutesRecord parses SQLite JSON strings into arrays", () => {
  const normalized = normalizeMeetingMinutesRecord({
    participants: '[{"id":"npc-1","name":"마틴","type":"npc"}]',
    keyTopics: '["우선순위","KPI"]',
  });

  assert.deepEqual(normalized.participants, [
    { id: "npc-1", name: "마틴", type: "npc" },
  ]);
  assert.deepEqual(normalized.keyTopics, ["우선순위", "KPI"]);
});

test("normalizeMeetingMinutesRecord falls back to empty arrays for invalid values", () => {
  const normalized = normalizeMeetingMinutesRecord({
    participants: "oops",
    keyTopics: null,
  });

  assert.deepEqual(normalized.participants, []);
  assert.deepEqual(normalized.keyTopics, []);
});
