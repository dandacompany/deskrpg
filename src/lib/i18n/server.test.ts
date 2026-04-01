import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocale, translateServer } from "./server";

test("normalizeLocale maps browser locale strings to supported locales", () => {
  assert.equal(normalizeLocale("ko-KR"), "ko");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("fr-FR"), "en");
  assert.equal(normalizeLocale(undefined), "en");
});

test("translateServer uses locale strings and falls back to english for unknown keys", () => {
  assert.equal(translateServer("ko-KR", "meeting.systemSender"), "시스템");
  assert.equal(
    translateServer("en-US", "minutes.exportTitle", { topic: "Roadmap Sync" }),
    "Meeting Minutes: Roadmap Sync",
  );
  assert.equal(translateServer("zh-CN", "nonexistent.key"), "nonexistent.key");
});
