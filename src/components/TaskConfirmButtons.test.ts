import test from "node:test";
import assert from "node:assert/strict";

// Test the isTaskConfirmPrompt detection logic
// (import the function directly since it's a pure utility)
const { isTaskConfirmPrompt } = require("./TaskConfirmButtons");

// --- Korean ---
test("detects Korean task confirm prompt", () => {
  assert.equal(isTaskConfirmPrompt("이 작업을 태스크로 등록할까요?"), true);
});

test("detects Korean confirm in longer message", () => {
  assert.equal(
    isTaskConfirmPrompt(
      "네, 이해했습니다. 이 작업을 태스크로 등록할까요? 승인해주시면 바로 시작할게요.",
    ),
    true,
  );
});

// --- English ---
test("detects English task confirm prompt", () => {
  assert.equal(isTaskConfirmPrompt("Would you like me to register this as a task?"), true);
});

test("detects English confirm case-insensitive", () => {
  assert.equal(isTaskConfirmPrompt("Should I Register This As A Task for you?"), true);
});

// --- Japanese ---
test("detects Japanese task confirm prompt", () => {
  assert.equal(isTaskConfirmPrompt("この作業をタスクとして登録しますか？"), true);
});

// --- Chinese ---
test("detects Chinese task confirm prompt", () => {
  assert.equal(isTaskConfirmPrompt("要把这项工作登记为任务吗？"), true);
});

// --- Negative cases ---
test("does not detect normal conversation", () => {
  assert.equal(isTaskConfirmPrompt("안녕하세요, 무엇을 도와드릴까요?"), false);
});

test("does not detect task update response", () => {
  assert.equal(isTaskConfirmPrompt("태스크를 업데이트했습니다. 진행률 75%입니다."), false);
});

test("does not detect empty string", () => {
  assert.equal(isTaskConfirmPrompt(""), false);
});

test("does not detect partial match", () => {
  assert.equal(isTaskConfirmPrompt("태스크로 등록했습니다"), false);
});
