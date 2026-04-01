import assert from "node:assert/strict";
import test from "node:test";

import { injectTaskPrompt, withTaskReminder } from "./task-prompt.js";

test("injectTaskPrompt localizes the task registration confirmation by locale", () => {
  const englishPrompt = injectTaskPrompt("# Identity", "en");
  const koreanPrompt = injectTaskPrompt("# Identity", "ko");

  assert.match(englishPrompt, /Would you like me to register this as a task\?/);
  assert.match(koreanPrompt, /이 작업을 태스크로 등록할까요\?/);
});

test("withTaskReminder localizes the reminder step and falls back to English", () => {
  const japaneseReminder = withTaskReminder("hello", "ja");
  const fallbackReminder = withTaskReminder("hello", "fr-FR");

  assert.match(japaneseReminder, /まず「.*タスクとして登録しますか.*」を確認/);
  assert.match(fallbackReminder, /First ask \"Would you like me to register this as a task\?\"/);
});
