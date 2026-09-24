import test from "node:test";
import assert from "node:assert/strict";

import { HermesAdapter } from "./hermes-adapter";

// Pins down that both transport paths carry the system instruction under the correct
// **field name**. If the name is wrong, Hermes silently ignores it — this is a place where
// a failure doesn't look like a failure, so the test is the only line of defense.

function fakeClient(capture: { body?: Record<string, unknown>; path?: string }) {
  return {
    async getCapabilities() {
      return { features: {} };
    },
    async startRun(args: Record<string, unknown>) {
      capture.path = "/v1/runs";
      capture.body = args;
      return { runId: "run-1" };
    },
    async streamRunEvents() {
      return { text: "ok" };
    },
    async createSession() {
      return { sessionId: "sess-1" };
    },
    async streamSessionChat(args: Record<string, unknown>) {
      capture.path = "/api/sessions/chat/stream";
      capture.body = args;
      return { text: "ok", runId: "run-1", sessionId: "sess-1" };
    },
  };
}

// Borrows only the prototype, skipping the constructor — all this test wants to see is which
// field name execute() carries the value under, and it doesn't need a real client/config.
function adapterWith(client: unknown): HermesAdapter {
  const a = Object.create(HermesAdapter.prototype) as Record<string, unknown>;
  a.client = client;
  a.sessionId = null;
  a.lastRunId = null;
  return a as unknown as HermesAdapter;
}

test("the meeting path (runs) carries it as instructions", async () => {
  const cap: { body?: Record<string, unknown> } = {};
  const a = adapterWith(fakeClient(cap));
  await a.execute({
    sessionKey: "k",
    prompt: "p",
    multiParty: true,
    instructions: "<team-instructions>\nMEET\n</team-instructions>",
  });
  assert.equal(cap.body?.instructions, "<team-instructions>\nMEET\n</team-instructions>");
});

test("the 1:1 path (session chat) carries it as systemMessage", async () => {
  const cap: { body?: Record<string, unknown> } = {};
  const a = adapterWith(fakeClient(cap));
  await a.execute({ sessionKey: "k", prompt: "p", instructions: "SYS" });
  assert.equal(cap.body?.systemMessage, "SYS");
});

test("both paths leave the field undefined when there's no instruction", async () => {
  const runCap: { body?: Record<string, unknown> } = {};
  await adapterWith(fakeClient(runCap)).execute({
    sessionKey: "k",
    prompt: "p",
    multiParty: true,
  });
  assert.equal(runCap.body?.instructions, undefined);

  const chatCap: { body?: Record<string, unknown> } = {};
  await adapterWith(fakeClient(chatCap)).execute({ sessionKey: "k", prompt: "p" });
  assert.equal(chatCap.body?.systemMessage, undefined);
});
