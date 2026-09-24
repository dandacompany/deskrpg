import assert from "node:assert/strict";
import test from "node:test";

import { readGrowthState, writeGrowthFlag } from "./growth-storage";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

test("reads back the stored seen version and Star click", () => {
  const s = memoryStorage();
  assert.deepEqual(readGrowthState(s), { ok: true, seenVersion: null, starClicked: false });
  writeGrowthFlag(s, "seenVersion", "2026.922.0");
  writeGrowthFlag(s, "starClicked", "1");
  assert.deepEqual(readGrowthState(s), { ok: true, seenVersion: "2026.922.0", starClicked: true });
});

test("ok is false when storage can't be read", () => {
  const broken = {
    getItem() {
      throw new Error("SecurityError");
    },
  } as unknown as Storage;
  assert.equal(readGrowthState(broken).ok, false);
  assert.equal(readGrowthState(null).ok, false);
  assert.doesNotThrow(() => writeGrowthFlag(broken, "starClicked", "1"));
});

test("stores and reads back survey state, and resets a corrupted value to the initial state", async () => {
  const { readSurveyState, writeSurveyState } = await import("./growth-storage");
  const s = memoryStorage();
  assert.deepEqual(readSurveyState(s), { consent: "unknown", usageMs: 0, nextAt: null });
  writeSurveyState(s, { consent: "granted", usageMs: 5, nextAt: 99 });
  assert.deepEqual(readSurveyState(s), { consent: "granted", usageMs: 5, nextAt: 99 });
  s.setItem("deskrpg.feedback.survey", "{not json");
  assert.deepEqual(readSurveyState(s), { consent: "unknown", usageMs: 0, nextAt: null });
  s.setItem("deskrpg.feedback.survey", JSON.stringify({ consent: "hacked", usageMs: -3 }));
  assert.deepEqual(readSurveyState(s), { consent: "unknown", usageMs: 0, nextAt: null });
  assert.equal(readSurveyState(null), null);
});
