import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeClientFinalSpeech, sanitizeClientStreamingSpeech } from "./stream-text";

test("sanitizeClientStreamingSpeech hides partial SPEAK prefix chunks", () => {
  assert.equal(sanitizeClientStreamingSpeech("SPE"), "");
  assert.equal(sanitizeClientStreamingSpeech("SPEAK:"), "");
  assert.equal(sanitizeClientStreamingSpeech("SPEAK: 안"), "안");
});

test("sanitizeClientStreamingSpeech tolerates whitespace around the prefix", () => {
  assert.equal(sanitizeClientStreamingSpeech("  SPEAK : 안녕하세요"), "안녕하세요");
});

test("sanitizeClientFinalSpeech removes prefix from final text", () => {
  assert.equal(sanitizeClientFinalSpeech("SPEAK: 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeClientFinalSpeech(" SPEAK : 테스트"), "테스트");
});

test("sanitizeClientFinalSpeech removes a leading TO: line", () => {
  assert.equal(sanitizeClientFinalSpeech("TO: 단비\n어때요?"), "어때요?");
  assert.equal(sanitizeClientFinalSpeech("TO:단비\n어때요?"), "어때요?");
});

test("sanitizeClientFinalSpeech leaves a mid-body TO: untouched", () => {
  assert.equal(
    sanitizeClientFinalSpeech("어제 TO: 단비 라고 적었던 것 같아요"),
    "어제 TO: 단비 라고 적었던 것 같아요",
  );
});

test("sanitizeClientFinalSpeech leaves plain speech without TO: untouched", () => {
  assert.equal(sanitizeClientFinalSpeech("오늘 날씨가 좋네요"), "오늘 날씨가 좋네요");
});

test("sanitizeClientStreamingSpeech hides a growing TO: prefix until the line completes", () => {
  assert.equal(sanitizeClientStreamingSpeech("T"), "");
  assert.equal(sanitizeClientStreamingSpeech("TO"), "");
  assert.equal(sanitizeClientStreamingSpeech("TO:"), "");
  assert.equal(sanitizeClientStreamingSpeech("TO: 단"), "");
  assert.equal(sanitizeClientStreamingSpeech("TO: 단비\n어때요"), "어때요");
});
