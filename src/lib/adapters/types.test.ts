import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "./types";
import type { NpcAdapter, AdapterExecuteOptions, AdapterHealthResult } from "./types";

describe("AdapterExecuteOptions", () => {
  test("carries backend-neutral multi-party and control fields", () => {
    const options: AdapterExecuteOptions = {
      sessionKey: "s",
      prompt: "p",
      conversationHistory: [{ role: "user", content: "이전 발언" }],
      onToolProgress: () => {},
      onRunStarted: () => {},
    };
    assert.equal(options.conversationHistory?.[0].role, "user");
    assert.equal(typeof options.onToolProgress, "function");
    assert.equal(typeof options.onRunStarted, "function");
  });

  test("no longer accepts OpenClaw-specific fields", () => {
    // @ts-expect-error agentId was removed from the neutral options object
    const bad: AdapterExecuteOptions = { sessionKey: "s", prompt: "p", agentId: "a" };
    assert.ok(bad);
  });
});

function createStubAdapter(type: string): NpcAdapter {
  return {
    type,
    async execute(_opts: AdapterExecuteOptions) {
      return { response: "stub", session: { sessionRef: "s-1" } };
    },
    async testConnection() {
      return { status: "ok" as const } satisfies AdapterHealthResult;
    },
  };
}

describe("AdapterRegistry", () => {
  test("register and get adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = createStubAdapter("test");
    registry.register(adapter);
    assert.equal(registry.get("test"), adapter);
  });

  test("get unknown type throws", () => {
    const registry = new AdapterRegistry();
    assert.throws(() => registry.get("unknown"), /Unknown adapter type: unknown/);
  });

  test("has returns true for registered, false for unknown", () => {
    const registry = new AdapterRegistry();
    registry.register(createStubAdapter("claude"));
    assert.equal(registry.has("claude"), true);
    assert.equal(registry.has("codex"), false);
  });

  test("listInstalled returns registered types", () => {
    const registry = new AdapterRegistry();
    registry.register(createStubAdapter("claude"));
    registry.register(createStubAdapter("openclaw"));
    const list = registry.listInstalled();
    assert.deepEqual(list.sort(), ["claude", "openclaw"]);
  });

  test("register replaces existing adapter of same type", () => {
    const registry = new AdapterRegistry();
    const first = createStubAdapter("claude");
    const second = createStubAdapter("claude");
    registry.register(first);
    registry.register(second);
    assert.equal(registry.get("claude"), second);
  });
});
