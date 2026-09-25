import assert from "node:assert/strict";
import test from "node:test";

import { describeMeetingFailure, meetingErrorCode, meetingErrorMessage } from "./meeting-error";

/** Shaped like hermes-client's HermesError — this module is also read in the browser, so it does not import the class. */
function hermesError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { name: "HermesError", code, status });
}

test("model backend usage limit (a 429 inside a failed run) is mapped to its own limit code", () => {
  // Observed on staging: the reason the gateway returns as run.failed when the Codex account limit is hit
  const out = describeMeetingFailure(
    hermesError("run_failed", "HTTP 429: The usage limit has been reached", 200),
  );
  assert.equal(out.error, "backend_usage_limit");
  assert.equal(out.detail, "HTTP 429: The usage limit has been reached");
});

test("the gateway concurrent-run cap (HTTP 429) is a different code from usage limit", () => {
  assert.equal(
    describeMeetingFailure(hermesError("http_error", "Too Many Requests", 429)).error,
    "gateway_busy",
  );
});

test("unreachable gateway or rejected auth each get their own code", () => {
  assert.equal(
    describeMeetingFailure(hermesError("unreachable", "connect ECONNREFUSED", 0)).error,
    "backend_unavailable",
  );
  assert.equal(
    describeMeetingFailure(hermesError("unauthorized", "401", 401)).error,
    "backend_unauthorized",
  );
});

test("error and detail are always strings, whatever the input — Error, plain object, string, or nothing", () => {
  for (const input of [
    new Error("boom"),
    { code: "adapter_failed", message: "adapter blew up" },
    { nested: { deep: true } },
    "plain failure",
    null,
    undefined,
    42,
  ]) {
    const out = describeMeetingFailure(input);
    assert.equal(typeof out.error, "string", `error 가 문자열이 아니다: ${String(input)}`);
    assert.ok(out.detail === null || typeof out.detail === "string");
    assert.doesNotMatch(JSON.stringify(out), /\[object Object\]/);
  }
  assert.equal(describeMeetingFailure({ nested: { deep: true } }).detail, null);
  assert.equal(describeMeetingFailure("plain failure").detail, "plain failure");
});

test("detail is collapsed to one line, length-capped, and masks token-shaped substrings", () => {
  const long = describeMeetingFailure(new Error(`first line\nsecond ${"x".repeat(500)}`));
  assert.ok(long.detail);
  assert.doesNotMatch(long.detail!, /\n/);
  assert.ok(long.detail!.length <= 160, `길이 ${long.detail!.length}`);

  const secret = describeMeetingFailure(
    new Error("upstream said: Bearer abcdefghijklmnop key sk-proj-1234567890abcdef"),
  );
  assert.doesNotMatch(secret.detail!, /abcdefghijklmnop|sk-proj-1234567890abcdef/);
});

test("the client never uses a non-string error value as the code", () => {
  assert.equal(meetingErrorCode("backend_usage_limit"), "backend_usage_limit");
  assert.equal(meetingErrorCode({ code: "x" }), "unknown");
  assert.equal(meetingErrorCode(undefined), "unknown");
  assert.equal(meetingErrorCode(""), "unknown");
});

test("the text rendered in meeting chat never becomes [object Object], even for object input", () => {
  const dict: Record<string, string> = {
    "meeting.reason.backend_usage_limit": "AI 백엔드 사용 한도가 찼습니다.",
    "meeting.reason.unknown": "알 수 없는 오류입니다.",
  };
  const t = (key: string) => dict[key] ?? key;

  assert.equal(
    meetingErrorMessage({ error: "backend_usage_limit", detail: "HTTP 429" }, t),
    "AI 백엔드 사용 한도가 찼습니다. (HTTP 429)",
  );
  // Even if an old-version server sends the raw object, no garbage text leaks through
  assert.equal(meetingErrorMessage({ error: { message: "x" } }, t), "알 수 없는 오류입니다.");
  // An old string error with no translation is shown as-is (existing literal-error emitters)
  assert.equal(meetingErrorMessage({ error: "Permission denied" }, t), "Permission denied");
  assert.equal(
    meetingErrorMessage({ error: "backend_usage_limit", detail: { a: 1 } }, t),
    "AI 백엔드 사용 한도가 찼습니다.",
  );
});

test("a run the provider rejected names the cause and leaves the provider's text out", () => {
  // Measured on staging (Hermes 0.21.2) with an expired openai-codex sign-in; the key is masked.
  const expired = describeMeetingFailure(
    hermesError(
      "run_failed",
      "ChatGPT or Codex Subscription rejected your sign-in, so the model can't be reached. " +
        "Sign in again: `hermes -p sophie auth add openai-codex --type oauth`.\n\n" +
        "Provider said: HTTP 401: Incorrect API key provided: sk-test*****.",
      200,
    ),
  );
  assert.deepEqual(expired, { error: "provider_auth_expired", detail: null });

  const model = describeMeetingFailure(
    hermesError("run_failed", "The model `gpt-9` does not exist", 200),
  );
  assert.deepEqual(model, { error: "model_error", detail: null });
});

test("a plain error mentioning 401 is not taken for a provider sign-in", () => {
  // Only a run the gateway accepted can be the provider's rejection.
  assert.equal(
    describeMeetingFailure(new Error("HTTP 401 Unauthorized")).error,
    "npc_response_failed",
  );
});
