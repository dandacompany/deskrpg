import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSafeHttpUrl, oauthReducer, pollDelayMs } from "./provider-auth-model";

describe("provider-auth-model", () => {
  it("start -> waiting -> approved becomes done", () => {
    let s = oauthReducer({ kind: "idle" }, { type: "start" });
    assert.equal(s.kind, "starting");
    s = oauthReducer(s, {
      type: "started",
      sessionId: "s1",
      userCode: "AB-12",
      verificationUrl: "https://x/d",
      expiresIn: 900,
      now: 0,
    });
    assert.deepEqual(s, {
      kind: "waiting",
      sessionId: "s1",
      userCode: "AB-12",
      verificationUrl: "https://x/d",
      expiresAt: 900_000,
    });
    assert.equal(oauthReducer(s, { type: "poll", status: "pending", error: null }).kind, "waiting");
    assert.equal(oauthReducer(s, { type: "poll", status: "approved", error: null }).kind, "done");
  });
  it("denied/expired/error become failed with a reason code", () => {
    const w = {
      kind: "waiting" as const,
      sessionId: "s",
      userCode: "c",
      verificationUrl: "https://x",
      expiresAt: 1,
    };
    assert.deepEqual(oauthReducer(w, { type: "poll", status: "denied", error: null }), {
      kind: "failed",
      errorCode: "oauth_denied",
    });
    assert.deepEqual(oauthReducer(w, { type: "poll", status: "expired", error: null }), {
      kind: "failed",
      errorCode: "oauth_expired",
    });
    assert.deepEqual(oauthReducer(w, { type: "poll", status: "error", error: "x" }), {
      kind: "failed",
      errorCode: "oauth_error",
    });
  });
  it("cancel becomes idle", () => {
    const w = {
      kind: "waiting" as const,
      sessionId: "s",
      userCode: "c",
      verificationUrl: "https://x",
      expiresAt: 1,
    };
    assert.deepEqual(oauthReducer(w, { type: "cancel" }), { kind: "idle" });
  });
  it("the polling interval is at least 2 seconds", () => {
    assert.equal(pollDelayMs(undefined), 2500);
    assert.equal(pollDelayMs(1), 2000);
    assert.equal(pollDelayMs(5), 5000);
  });
  it("only opens http(s)", () => {
    assert.equal(isSafeHttpUrl("https://auth.openai.com/codex/device"), true);
    assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
    assert.equal(isSafeHttpUrl("not a url"), false);
  });

  // Coverage beyond the brief — a late-arriving event never resurrects the state.
  it("ignores poll/started events received when not waiting", () => {
    const idle = { kind: "idle" as const };
    assert.deepEqual(oauthReducer(idle, { type: "poll", status: "approved", error: null }), idle);
    const started = {
      type: "started" as const,
      sessionId: "s",
      userCode: "c",
      verificationUrl: "https://x",
      expiresIn: 1,
      now: 0,
    };
    assert.deepEqual(oauthReducer(idle, started), idle);
  });
  it("failure while starting/waiting becomes failed, and start after failed/done becomes starting again", () => {
    assert.deepEqual(oauthReducer({ kind: "starting" }, { type: "fail", errorCode: "forbidden" }), {
      kind: "failed",
      errorCode: "forbidden",
    });
    assert.equal(
      oauthReducer({ kind: "failed", errorCode: "x" }, { type: "start" }).kind,
      "starting",
    );
    assert.equal(oauthReducer({ kind: "done" }, { type: "start" }).kind, "starting");
    assert.equal(oauthReducer({ kind: "starting" }, { type: "start" }).kind, "starting");
  });
  it("falls back to the default when the polling interval input isn't a number", () => {
    assert.equal(pollDelayMs(Number.NaN), 2500);
    assert.equal(pollDelayMs(0), 2000);
  });
});
