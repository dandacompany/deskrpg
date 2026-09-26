import assert from "node:assert/strict";
import test from "node:test";

import type { PollOutcome } from "./automation-poller";
import {
  GATEWAY_HEALTH_EVENT,
  getGatewayHealth,
  healthFromPollOutcome,
  recordGatewayHealth,
  type GatewayHealthStore,
} from "./gateway-health";

const ok: PollOutcome = { ok: true, events: 0, pages: 1, cursor: "c", restarted: false };
const fail = (code: string, status?: number): PollOutcome => ({
  ok: false,
  code,
  reason: "x",
  boards: [{ ok: false, boardSlug: "b", code, reason: "x", ...(status ? { status } : {}) }],
});

test("a successful tick is ok, and one board answering is enough", () => {
  assert.equal(healthFromPollOutcome(ok), "ok");
  assert.equal(
    healthFromPollOutcome({
      ok: false,
      code: "unreachable",
      reason: "x",
      boards: [
        { ok: false, boardSlug: "a", code: "unreachable", reason: "x" },
        { ok: true, boardSlug: "b", events: 0, pages: 1, cursor: "c", restarted: false },
      ],
    }),
    "ok",
  );
});

test("unreachable and timeout mean the gateway could not be reached", () => {
  assert.equal(healthFromPollOutcome(fail("unreachable")), "unreachable");
  assert.equal(healthFromPollOutcome(fail("timeout")), "unreachable");
});

test("a 401 from a board poll, or the gate's plugin_unauthorized, means the owner key was rejected", () => {
  assert.equal(healthFromPollOutcome(fail("invalid_api_key", 401)), "unauthorized");
  assert.equal(
    healthFromPollOutcome({ ok: false, code: "plugin_unauthorized", reason: "x" }),
    "unauthorized",
  );
});

test("unbound channels and plugin gates say nothing about reachability", () => {
  for (const code of ["unbound", "plugin_upgrade_required", "plugin_absent", "no_board"]) {
    assert.equal(healthFromPollOutcome({ ok: false, code, reason: "x" }), null, code);
  }
});

test("any other failure is unknown, not ok", () => {
  assert.equal(healthFromPollOutcome(fail("internal_error")), "unknown");
});

test("the state is broadcast only when it changes, and a joining socket can read it", () => {
  const store: GatewayHealthStore = new Map();
  const sent: unknown[] = [];
  const emit = (channelId: string, event: string, payload: unknown) =>
    sent.push([channelId, event, payload]);

  assert.equal(getGatewayHealth("ch", store), null, "nothing before the first tick");
  recordGatewayHealth("ch", "ok", emit, 1, store);
  recordGatewayHealth("ch", "ok", emit, 2, store);
  recordGatewayHealth("ch", null, emit, 3, store);
  recordGatewayHealth("ch", "unreachable", emit, 4, store);

  assert.deepEqual(sent, [
    ["ch", GATEWAY_HEALTH_EVENT, { state: "ok", since: 1 }],
    ["ch", GATEWAY_HEALTH_EVENT, { state: "unreachable", since: 4 }],
  ]);
  assert.deepEqual(getGatewayHealth("ch", store), { state: "unreachable", since: 4 });
});
