import assert from "node:assert/strict";
import test from "node:test";

import { languageName, promptLocale } from "./prompt-locale";

test("promptLocale keeps Korean only for ko and falls back to English", () => {
  assert.equal(promptLocale("ko"), "ko");
  assert.equal(promptLocale("ko-KR"), "ko");
  for (const other of ["en", "ja", "zh", "fr", null, undefined, ""]) {
    assert.equal(promptLocale(other), "en");
  }
});

test("languageName names every supported locale in English", () => {
  assert.equal(languageName("ko"), "Korean");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("zh-TW"), "Chinese");
  assert.equal(languageName(null), "English");
});
