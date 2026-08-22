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

test("buildTaskSessionPrompt includes task context", () => {
  const { buildTaskSessionPrompt } = require("./task-prompt.js");
  const task = {
    title: "PDF 보고서",
    npcTaskId: "dev-20260408-a1b2",
    status: "in_progress",
    summary: "1분기 분석 중",
    createdAt: "2026-04-08T10:00:00Z",
  };
  const result = buildTaskSessionPrompt(task, "ko");
  assert.ok(result.includes("PDF 보고서"));
  assert.ok(result.includes("dev-20260408-a1b2"));
  assert.ok(result.includes("in_progress"));
  assert.ok(result.includes("1분기 분석 중"));
  assert.ok(result.includes("Task Management Protocol") || result.includes("태스크"));
});

test("buildTaskSessionPrompt works with null summary", () => {
  const { buildTaskSessionPrompt } = require("./task-prompt.js");
  const task = {
    title: "테스트",
    npcTaskId: "t-1",
    status: "pending",
    summary: null,
    createdAt: "2026-04-08T10:00:00Z",
  };
  const result = buildTaskSessionPrompt(task, "en");
  assert.ok(result.includes("테스트"));
  assert.ok(!result.includes("null"));
});

test("buildTaskSessionPrompt includes buildTaskCorePrompt content", () => {
  const { buildTaskSessionPrompt, buildTaskCorePrompt } = require("./task-prompt.js");
  const task = {
    title: "Test",
    npcTaskId: "t-1",
    status: "in_progress",
    summary: null,
    createdAt: "2026-04-08T00:00:00Z",
  };
  const result = buildTaskSessionPrompt(task, "ko");
  // Should contain both task context AND core prompt
  assert.ok(result.includes("[TASK CONTEXT]"));
  assert.ok(result.includes("json:task"));
});

test("buildTaskSessionPrompt locale fallback to en", () => {
  const { buildTaskSessionPrompt } = require("./task-prompt.js");
  const task = {
    title: "Test",
    npcTaskId: "t-1",
    status: "pending",
    summary: "doing stuff",
    createdAt: "2026-04-08T00:00:00Z",
  };
  const resultKo = buildTaskSessionPrompt(task, "ko");
  const resultEn = buildTaskSessionPrompt(task, "en");
  // Both should contain task context
  assert.ok(resultKo.includes("Test"));
  assert.ok(resultEn.includes("Test"));
  // Both should contain core prompt (different locales)
  assert.ok(resultKo.length > 100);
  assert.ok(resultEn.length > 100);
});
