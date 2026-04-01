import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeClientFinalSpeech,
  sanitizeClientStreamingSpeech,
} from "./stream-text";

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
