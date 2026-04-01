import test from "node:test";
import assert from "node:assert/strict";

import {
  getNpcResponseMessageKey,
  resolveNpcResponseChunk,
  type NpcResponseMessageCode,
} from "./npc-response-messages";

const TEST_CODES: Record<NpcResponseMessageCode, string> = {
  no_agent: "npc.noAgent",
  gateway_not_connected: "npc.gatewayNotConnected",
  gateway_error: "npc.gatewayError",
  wait_before_sending: "npc.waitBeforeSending",
  npc_not_found: "npc.notFound",
};

test("npc response message codes map to stable translation keys", () => {
  for (const [code, key] of Object.entries(TEST_CODES)) {
    assert.equal(getNpcResponseMessageKey(code as NpcResponseMessageCode), key);
  }
});

test("resolveNpcResponseChunk localizes system message codes", () => {
  const calls: Array<{ key: string; params?: Record<string, string | number> }> = [];
  const result = resolveNpcResponseChunk(
    {
      chunk: "",
      messageCode: "gateway_error",
      done: true,
    },
    (key, params) => {
      calls.push({ key, params });
      return `translated:${key}`;
    },
  );

  assert.equal(result, "translated:npc.gatewayError");
  assert.deepEqual(calls, [{ key: "npc.gatewayError", params: undefined }]);
});

test("resolveNpcResponseChunk preserves streamed text when no system message code exists", () => {
  const result = resolveNpcResponseChunk(
    {
      chunk: "hello",
      done: false,
    },
    () => "should-not-be-used",
  );

  assert.equal(result, "hello");
});
