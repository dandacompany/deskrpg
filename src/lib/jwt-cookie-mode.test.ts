// The rule for whether to send cookies as `Secure`. Get this wrong and **login breaks entirely
// on HTTP deployments** — the signup/login API returns 200, but the browser drops the cookie
// and the user stays stuck on `/auth` (observed 2026-09-18: Safari for anything including
// localhost, Chrome for private IPs). The symptom leaves nothing in the server log, so it is silent.
import assert from "node:assert/strict";
import test from "node:test";

import { isSecureCookie } from "./jwt";

/** Tests that touch `process.env` must restore it — this process is shared with other files. */
function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("when COOKIE_SECURE is set, it wins regardless of NODE_ENV", () => {
  withEnv({ COOKIE_SECURE: "false", NODE_ENV: "production" }, () => {
    assert.equal(isSecureCookie(), false, "HTTP 배포에서 Secure 쿠키가 나간다 — 로그인이 막힌다");
  });
  withEnv({ COOKIE_SECURE: "true", NODE_ENV: "development" }, () => {
    assert.equal(isSecureCookie(), true);
  });
});

test("when COOKIE_SECURE is unset, only production is Secure", () => {
  withEnv({ COOKIE_SECURE: undefined, NODE_ENV: "production" }, () => {
    assert.equal(isSecureCookie(), true);
  });
  withEnv({ COOKIE_SECURE: undefined, NODE_ENV: "development" }, () => {
    assert.equal(isSecureCookie(), false);
  });
});

test("a value other than `false`/`true` doesn't count as configured — falls back to the production default", () => {
  // So someone who set `COOKIE_SECURE=0` meaning "off" isn't surprised to see HTTPS-like
  // behavior, this behavior is pinned here. Change this test first if you want to change it.
  withEnv({ COOKIE_SECURE: "0", NODE_ENV: "production" }, () => {
    assert.equal(isSecureCookie(), true);
  });
});
