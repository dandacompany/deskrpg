import assert from "node:assert/strict";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeSpokenResponse, sanitizeStreamingSpokenResponse } = require("./meeting-formatter.js") as typeof import("./meeting-formatter.js");

test("sanitizeSpokenResponse removes a leading SPEAK prefix", () => {
  assert.equal(sanitizeSpokenResponse("SPEAK: 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeSpokenResponse("  SPEAK 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeSpokenResponse("안녕하세요 SPEAK:"), "안녕하세요 SPEAK:");
});

test("sanitizeStreamingSpokenResponse suppresses partial SPEAK prefix fragments", () => {
  assert.equal(sanitizeStreamingSpokenResponse("SPE"), "");
  assert.equal(sanitizeStreamingSpokenResponse("SPEAK:"), "");
  assert.equal(sanitizeStreamingSpokenResponse("SPEAK: 안녕하세요"), "안녕하세요");
  assert.equal(sanitizeStreamingSpokenResponse("So"), "So");
});
