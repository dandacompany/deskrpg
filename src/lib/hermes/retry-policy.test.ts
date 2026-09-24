import test from "node:test";
import assert from "node:assert/strict";

import { parseRetryAfterMs, shouldRetryStatus, retryDelayMs } from "./retry-policy";

// Hermes does not silently drop requests over its concurrency limit —
// it rejects them explicitly with `429 + Retry-After: 1 + code: rate_limit_exceeded`
// (api_server.py:7154-7182). DeskRPG was the side that dropped them.

test("retries only 429", () => {
  assert.equal(shouldRetryStatus(429), true);
  // 503 means the gateway itself cannot accept — repeating gets the same answer.
  for (const s of [400, 401, 403, 404, 500, 503]) {
    assert.equal(shouldRetryStatus(s), false, `${s}`);
  }
});

test("reads Retry-After seconds as milliseconds", () => {
  assert.equal(parseRetryAfterMs("1"), 1000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("2.5"), 2500);
});

test("null when Retry-After is missing or malformed", () => {
  for (const v of [null, "", "soon", "-1", "NaN"]) {
    assert.equal(parseRetryAfterMs(v), null, JSON.stringify(v));
  }
});

test("clamps an absurdly long Retry-After to the cap", () => {
  // Holding one meeting turn for minutes makes the user think it froze.
  assert.equal(parseRetryAfterMs("600"), 10_000);
});

test("without the header, uses a backoff that grows per attempt", () => {
  assert.equal(retryDelayMs(0, null), 500);
  assert.equal(retryDelayMs(1, null), 1000);
  assert.equal(retryDelayMs(2, null), 2000);
});

test("with the header, the header wins", () => {
  // What the server knows beats our guess.
  assert.equal(retryDelayMs(0, 1000), 1000);
  assert.equal(retryDelayMs(2, 1000), 1000);
});
