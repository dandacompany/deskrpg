/**
 * The four locales' key sets must be identical. `t()` falls back to en, then to the key
 * string itself, for a missing key — so a key missing from one locale silently shows up on
 * screen in another language (or as the key name). This test catches that. Work that adds UI
 * must keep this test green.
 */
import assert from "node:assert/strict";
import test from "node:test";

import en from "./locales/en";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zh from "./locales/zh";

const LOCALES: Record<string, Record<string, string>> = { ko, en, ja, zh };

test("all four locale files share an identical key set", () => {
  const reference = Object.keys(LOCALES.en).sort();
  for (const [name, map] of Object.entries(LOCALES)) {
    const keys = Object.keys(map).sort();
    const missing = reference.filter((key) => !(key in map));
    const extra = keys.filter((key) => !(key in LOCALES.en));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${name} diverges from en — missing ${missing.length}, extra ${extra.length}`,
    );
  }
});

// Empty strings are allowed — a value may be intentionally left blank.
test("locale values are strings", () => {
  for (const [name, map] of Object.entries(LOCALES)) {
    for (const [key, value] of Object.entries(map)) {
      assert.equal(typeof value, "string", `${name}.${key} must be a string`);
    }
  }
});
