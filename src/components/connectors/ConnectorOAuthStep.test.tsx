import assert from "node:assert/strict";
import test from "node:test";

import ConnectorOAuthStep from "./ConnectorOAuthStep";
import { createConnectorsApi } from "./connectors-api";
import {
  $,
  cleanup,
  click,
  container,
  mockFetch,
  render,
  text,
  type,
} from "../skills/skills-test-harness";

const ROOT = "/api/channels/ch-1/npcs/n-1/connectors";
const START = `POST ${ROOT}/servers/canva/oauth`;
const GOOD = "http://127.0.0.1:8412/callback?code=a&state=b";

let done = 0;
let opened: unknown[][] = [];
let openResult: unknown = {};
const originalOpen = window.open;

const step = () => (
  <ConnectorOAuthStep
    api={createConnectorsApi("ch-1", "n-1")}
    server="canva"
    onDone={() => {
      done += 1;
    }}
    onCancel={() => {}}
  />
);

test.beforeEach(() => {
  done = 0;
  opened = [];
  openResult = {};
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return openResult;
  }) as typeof window.open;
});
test.afterEach(async () => {
  await cleanup();
  window.open = originalOpen;
});

test("start opens the provider page in a new tab", async () => {
  mockFetch({ [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" } });
  await render(step());
  await click('[data-action="oauth-start"]');
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], "https://canva.example/auth");
  assert.equal(opened[0][1], "_blank");
  assert.equal(container.querySelector("[data-oauth-link]"), null);
});

test("a blocked popup shows the link instead", async () => {
  openResult = null;
  mockFetch({ [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" } });
  await render(step());
  await click('[data-action="oauth-start"]');
  assert.equal($("[data-oauth-link]").getAttribute("href"), "https://canva.example/auth");
  assert.equal($("[data-oauth-link]").getAttribute("rel"), "noopener noreferrer");
});

test("a non-loopback address is rejected on the spot and finish stays off", async () => {
  mockFetch({ [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" } });
  await render(step());
  await click('[data-action="oauth-start"]');
  await type('[name="oauth-paste"]', "https://evil.example/callback?code=a&state=b");
  assert.ok(text().includes("127.0.0.1 로 시작하고 code 와 state 가 들어 있는 주소여야 합니다"));
  assert.equal(($('[data-action="oauth-submit"]') as HTMLButtonElement).disabled, true);
});

test("a denied redirect says the provider refused", async () => {
  mockFetch({ [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" } });
  await render(step());
  await click('[data-action="oauth-start"]');
  await type('[name="oauth-paste"]', "http://127.0.0.1:8412/callback?error=access_denied");
  assert.ok(text().includes("공급자가 인증을 거절했습니다: access_denied"));
  assert.equal(($('[data-action="oauth-submit"]') as HTMLButtonElement).disabled, true);
});

test("a valid address is sent whole, then polling to approved finishes", async () => {
  const log = mockFetch({
    [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" },
    [`POST ${ROOT}/oauth/s1/callback`]: { ok: true },
    [`GET ${ROOT}/oauth/s1`]: { status: "approved", tools: ["design"] },
  });
  await render(step());
  await click('[data-action="oauth-start"]');
  await type('[name="oauth-paste"]', `  "${GOOD}"\n`);
  assert.equal(($('[data-action="oauth-submit"]') as HTMLButtonElement).disabled, false);
  await click('[data-action="oauth-submit"]');
  assert.deepEqual(log.bodies[`POST ${ROOT}/oauth/s1/callback`], { redirectUrl: GOOD });
  assert.ok(log.calls.includes(`GET ${ROOT}/oauth/s1`));
  assert.equal(done, 1);
});

test("an already-approved start finishes without a paste", async () => {
  mockFetch({ [START]: { status: "approved" } });
  await render(step());
  await click('[data-action="oauth-start"]');
  assert.equal(opened.length, 0);
  assert.equal(done, 1);
});

test("a poll error shows the failure and does not finish", async () => {
  mockFetch({
    [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" },
    [`POST ${ROOT}/oauth/s1/callback`]: { ok: true },
    [`GET ${ROOT}/oauth/s1`]: { status: "error", error: "token exchange failed" },
  });
  await render(step());
  await click('[data-action="oauth-start"]');
  await type('[name="oauth-paste"]', GOOD);
  await click('[data-action="oauth-submit"]');
  assert.ok(text().includes("token exchange failed"));
  assert.equal(done, 0);
});

test("unmounting mid-session cancels it", async () => {
  const log = mockFetch({
    [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" },
    [`DELETE ${ROOT}/oauth/s1`]: { ok: true },
  });
  await render(step());
  await click('[data-action="oauth-start"]');
  await cleanup();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(log.calls.includes(`DELETE ${ROOT}/oauth/s1`));
});

test("unmounting after approval does not cancel", async () => {
  const log = mockFetch({
    [START]: { sessionId: "s1", authUrl: "https://canva.example/auth" },
    [`POST ${ROOT}/oauth/s1/callback`]: { ok: true },
    [`GET ${ROOT}/oauth/s1`]: { status: "approved" },
  });
  await render(step());
  await click('[data-action="oauth-start"]');
  await type('[name="oauth-paste"]', GOOD);
  await click('[data-action="oauth-submit"]');
  await cleanup();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!log.calls.some((c) => c.startsWith("DELETE")));
});
