import test from "node:test";
import assert from "node:assert/strict";

import { parseOAuthPaste } from "./mcp-oauth-paste";

test("accepts loopback callback URLs with code and state", () => {
  assert.deepEqual(parseOAuthPaste("http://127.0.0.1:8412/callback?code=abc&state=xyz"), {
    ok: true,
    code: "abc",
    state: "xyz",
  });
  assert.deepEqual(
    parseOAuthPaste(
      "  'http://localhost:8412/callback?code=a&state=b&iss=https%3A%2F%2Fi.example'\n",
    ),
    { ok: true, code: "a", state: "b", iss: "https://i.example" },
  );
  assert.equal(parseOAuthPaste("http://[::1]:8412/callback?code=a&state=b").ok, true);
});

test("rejects non-loopback, https, wrong path, or missing params", () => {
  for (const raw of [
    "https://127.0.0.1:8412/callback?code=a&state=b",
    "http://evil.example/callback?code=a&state=b",
    "http://127.0.0.1.evil.example/callback?code=a&state=b",
    "http://127.0.0.1:8412/other?code=a&state=b",
    "http://127.0.0.1:8412/callback?code=a",
    "http://127.0.0.1:8412/callback?state=b",
    "not a url",
    "",
  ]) {
    assert.deepEqual(parseOAuthPaste(raw), { ok: false, reason: "invalid" }, raw);
  }
});

test("reports a provider error parameter as denied", () => {
  assert.deepEqual(parseOAuthPaste("http://127.0.0.1:8412/callback?error=access_denied&state=b"), {
    ok: false,
    reason: "denied",
    error: "access_denied",
  });
});
