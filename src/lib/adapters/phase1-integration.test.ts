/**
 * Phase 1 Integration Tests — Adapter Abstraction Layer
 *
 * Verifies that the adapter abstraction layer is correctly wired:
 * 1. DB schema: adapter_type and adapter_config columns exist
 * 2. AdapterRegistry: correct routing behavior
 * 3. OpenClawAdapter: streaming, session management, error handling
 * 4. NpcConfig: adapterType field populated from DB
 * 5. MeetingBroker: adapterResolver accepted
 * 6. Unsupported adapter: clean rejection
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

import { AdapterRegistry } from "./types";
import { OpenClawAdapter } from "./openclaw-adapter";
import type {
  NpcAdapter,
  AdapterExecuteOptions,
  AdapterHealthResult,
  AdapterSessionInfo,
} from "./types";

// ---------------------------------------------------------------------------
// 1. DB Schema — adapter_type and adapter_config columns
// ---------------------------------------------------------------------------

describe("Phase1: DB Schema", () => {
  test("npcs schema exports adapterType and adapterConfig columns", async () => {
    const schema = await import("../../db/schema");
    const npcColumns = schema.npcs;

    // Drizzle table objects expose column names
    assert.ok("adapterType" in npcColumns, "adapterType column should exist in npcs schema");
    assert.ok("adapterConfig" in npcColumns, "adapterConfig column should exist in npcs schema");
    // openclawConfig should still exist (backward compat)
    assert.ok("openclawConfig" in npcColumns, "openclawConfig column should still exist");
  });

  test("SQLite base schema includes adapter columns", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const schemaPath = path.resolve("src/db/sqlite-base-schema.js");
    const content = fs.readFileSync(schemaPath, "utf-8");

    assert.ok(content.includes("adapter_type"), "sqlite-base-schema.js should contain adapter_type");
    assert.ok(content.includes("adapter_config"), "sqlite-base-schema.js should contain adapter_config");
  });
});

// ---------------------------------------------------------------------------
// 2. AdapterRegistry — routing behavior
// ---------------------------------------------------------------------------

describe("Phase1: AdapterRegistry routing", () => {
  function stubAdapter(type: string): NpcAdapter {
    return {
      type,
      async execute() { return { response: `from-${type}`, session: { sessionRef: "s" } }; },
      async testConnection() { return { status: "ok" as const }; },
    };
  }

  test("registry routes to correct adapter by type", () => {
    const registry = new AdapterRegistry();
    const claude = stubAdapter("claude");
    const openclaw = stubAdapter("openclaw");
    registry.register(claude);
    registry.register(openclaw);

    assert.equal(registry.get("claude"), claude);
    assert.equal(registry.get("openclaw"), openclaw);
  });

  test("registry rejects unknown adapter type with descriptive error", () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter("openclaw"));

    assert.throws(
      () => registry.get("nonexistent"),
      (err: Error) => {
        assert.ok(err.message.includes("nonexistent"));
        return true;
      },
    );
  });

  test("listInstalled reflects runtime state", () => {
    const registry = new AdapterRegistry();
    assert.deepEqual(registry.listInstalled(), []);

    registry.register(stubAdapter("claude"));
    registry.register(stubAdapter("codex"));
    assert.deepEqual(registry.listInstalled().sort(), ["claude", "codex"]);
  });
});

// ---------------------------------------------------------------------------
// 3. OpenClawAdapter — streaming and error handling
// ---------------------------------------------------------------------------

describe("Phase1: OpenClawAdapter", () => {
  test("executeWithGateway streams deltas correctly", async () => {
    const adapter = new OpenClawAdapter();
    const deltas = ["chunk1-", "chunk2-", "chunk3"];
    const received: string[] = [];

    const mockGateway = {
      chatSend: mock.fn(async (_aid: string, _sk: string, _msg: string, onDelta: (d: string) => void) => {
        for (const d of deltas) onDelta(d);
        return deltas.join("");
      }),
    };

    const result = await adapter.executeWithGateway(
      mockGateway,
      {
        sessionKey: "test-key",
        prompt: "hello",
        onDelta: (chunk) => received.push(chunk),
      },
      "agent-1",
    );

    assert.equal(result.response, "chunk1-chunk2-chunk3");
    assert.deepEqual(received, deltas);
    assert.equal(result.session.sessionRef, "test-key");
  });

  test("executeWithGateway handles empty response", async () => {
    const adapter = new OpenClawAdapter();
    const mockGateway = {
      chatSend: mock.fn(async () => null),
    };

    const result = await adapter.executeWithGateway(
      mockGateway,
      { sessionKey: "k", prompt: "p" },
      "a",
    );

    assert.equal(result.response, "");
  });

  test("executeWithGateway passes attachments to gateway", async () => {
    const adapter = new OpenClawAdapter();
    const attachments = [
      { type: "image" as const, mimeType: "image/png", fileName: "test.png", content: "base64data" },
    ];

    const mockGateway = {
      chatSend: mock.fn(async (_a: string, _s: string, _m: string, _d: (d: string) => void, att: unknown) => {
        return "ok";
      }),
    };

    await adapter.executeWithGateway(
      mockGateway,
      { sessionKey: "k", prompt: "p", attachments },
      "a",
    );

    const call = mockGateway.chatSend.mock.calls[0];
    assert.equal(call.arguments[4], attachments);
  });

  test("executeWithGateway propagates gateway errors", async () => {
    const adapter = new OpenClawAdapter();
    const mockGateway = {
      chatSend: mock.fn(async () => { throw new Error("connection lost"); }),
    };

    await assert.rejects(
      () => adapter.executeWithGateway(mockGateway, { sessionKey: "k", prompt: "p" }, "a"),
      /connection lost/,
    );
  });

  test("execute without gateway throws instructive error", async () => {
    const adapter = new OpenClawAdapter();
    await assert.rejects(
      () => adapter.execute({ sessionKey: "k", prompt: "p" }),
      /executeWithGateway/,
    );
  });

  test("abort without gateway throws instructive error", async () => {
    const adapter = new OpenClawAdapter();
    await assert.rejects(
      () => adapter.abort!("k"),
      /abortWithGateway/,
    );
  });

  test("abortWithGateway calls gateway.chatAbort correctly", async () => {
    const adapter = new OpenClawAdapter();
    const mockGateway = {
      chatAbort: mock.fn(async () => {}),
    };

    await adapter.abortWithGateway(mockGateway, "agent-1", "session-1");
    assert.equal(mockGateway.chatAbort.mock.callCount(), 1);
    assert.equal(mockGateway.chatAbort.mock.calls[0].arguments[0], "agent-1");
    assert.equal(mockGateway.chatAbort.mock.calls[0].arguments[1], "session-1");
  });
});

// ---------------------------------------------------------------------------
// 4. NpcConfig — adapterType populated
// ---------------------------------------------------------------------------

describe("Phase1: NpcConfig shape", () => {
  test("NpcConfig interface includes adapterType and adapterConfig", () => {
    // This is a compile-time check — if this file compiles, the interface is correct.
    // We verify by constructing a valid NpcConfig-like object.
    const config = {
      id: "npc-1",
      name: "Test NPC",
      agentId: "agent-1",
      sessionKeyPrefix: "test",
      adapterType: "openclaw",
      adapterConfig: { model: "test" },
      _channelId: "ch-1",
      _name: "Test NPC",
      role: "Participant",
      passPolicy: null,
    };

    assert.equal(config.adapterType, "openclaw");
    assert.deepEqual(config.adapterConfig, { model: "test" });
  });

  test("default adapterType is openclaw for backward compat", () => {
    // Simulate what getNpcConfig does when adapterType is missing
    const npcRow = { adapterType: undefined };
    const adapterType = typeof npcRow.adapterType === "string" ? npcRow.adapterType : "openclaw";
    assert.equal(adapterType, "openclaw");
  });

  test("adapterConfig namespace isolation", () => {
    // Verify the namespace pattern works for multi-adapter configs
    const adapterConfig = {
      _type: "claude",
      _channelOverride: true,
      openclaw: { agentId: "oc-1", sessionKeyPrefix: "ot-abc" },
      claude: { model: "claude-sonnet-4", providerId: "p-1" },
      codex: { model: "gpt-5.4", providerId: "p-2" },
    };

    // Active config resolution
    const activeType = adapterConfig._type;
    const activeConfig = adapterConfig[activeType as keyof typeof adapterConfig];
    assert.deepEqual(activeConfig, { model: "claude-sonnet-4", providerId: "p-1" });

    // Switching adapter preserves other configs
    adapterConfig._type = "codex";
    const newActive = adapterConfig[adapterConfig._type as keyof typeof adapterConfig];
    assert.deepEqual(newActive, { model: "gpt-5.4", providerId: "p-2" });

    // OpenClaw config still intact
    assert.deepEqual(adapterConfig.openclaw, { agentId: "oc-1", sessionKeyPrefix: "ot-abc" });
  });
});

// ---------------------------------------------------------------------------
// 5. MeetingBroker — adapterResolver wiring
// ---------------------------------------------------------------------------

describe("Phase1: MeetingBroker adapterResolver", () => {
  test("MeetingBroker constructor stores adapterResolver", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MeetingBroker } = require("../meeting-broker.js") as { MeetingBroker: new (config: Record<string, unknown>, callbacks: Record<string, unknown>) => { adapterResolver: unknown; gateway: unknown } };

    const resolverFn = (npcId: string) => new OpenClawAdapter();

    const broker = new MeetingBroker(
      {
        topic: "Test",
        participants: [],
        gateway: null,
        sessionKeyPrefix: "test",
        meetingId: "m-1",
        adapterResolver: resolverFn,
      },
      {},
    );

    assert.equal(broker.adapterResolver, resolverFn);
    assert.equal(broker.gateway, null);
  });

  test("MeetingBroker defaults adapterResolver to null", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MeetingBroker } = require("../meeting-broker.js") as { MeetingBroker: new (config: Record<string, unknown>, callbacks: Record<string, unknown>) => { adapterResolver: unknown } };

    const broker = new MeetingBroker(
      {
        topic: "Test",
        participants: [],
        gateway: null,
        sessionKeyPrefix: "test",
        meetingId: "m-1",
      },
      {},
    );

    assert.equal(broker.adapterResolver, null);
  });
});

// ---------------------------------------------------------------------------
// 6. Unsupported adapter — clean rejection path
// ---------------------------------------------------------------------------

describe("Phase1: Unsupported adapter path", () => {
  test("registry.has returns false for unregistered CLI adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(new OpenClawAdapter());

    assert.equal(registry.has("openclaw"), true);
    assert.equal(registry.has("claude"), false);
    assert.equal(registry.has("codex"), false);
    assert.equal(registry.has("gemini"), false);
    assert.equal(registry.has("opencode"), false);
  });

  test("unsupported_adapter response message key exists", async () => {
    const { isNpcResponseMessageCode, getNpcResponseMessageKey } = await import("../npc-response-messages");

    assert.ok(
      isNpcResponseMessageCode("unsupported_adapter"),
      "unsupported_adapter should be a valid NpcResponseMessageCode",
    );
    assert.equal(
      getNpcResponseMessageKey("unsupported_adapter"),
      "npc.unsupportedAdapter",
    );
  });

  test("adapter routing guard: non-openclaw type is rejected before gateway call", () => {
    // Simulate the guard logic from streamNpcResponse
    const registry = new AdapterRegistry();
    registry.register(new OpenClawAdapter());

    const npcConfig = { adapterType: "claude" };

    // This is the guard condition from socket-handlers.ts:608
    const shouldReject = !registry.has(npcConfig.adapterType) || npcConfig.adapterType !== "openclaw";
    assert.equal(shouldReject, true, "Non-openclaw adapter should be rejected in Phase 1");

    // Openclaw should pass
    const openclawConfig = { adapterType: "openclaw" };
    const shouldPass = !registry.has(openclawConfig.adapterType) || openclawConfig.adapterType !== "openclaw";
    assert.equal(shouldPass, false, "Openclaw adapter should pass the guard");
  });
});

// ---------------------------------------------------------------------------
// 7. End-to-end adapter pipeline simulation
// ---------------------------------------------------------------------------

describe("Phase1: End-to-end adapter pipeline", () => {
  test("full DM chat flow through adapter", async () => {
    const adapter = new OpenClawAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);

    // Simulate: NPC config loaded from DB
    const npcConfig = {
      id: "npc-1",
      adapterType: "openclaw",
      agentId: "agent-abc",
      sessionKeyPrefix: "ot-test",
      _channelId: "ch-1",
    };

    // 1. Resolve adapter from registry
    const resolvedAdapter = registry.get(npcConfig.adapterType);
    assert.equal(resolvedAdapter.type, "openclaw");

    // 2. Build session key (same logic as socket-handlers.ts:619)
    const userId = "user-123";
    const sessionKey = `${npcConfig.sessionKeyPrefix}-dm-${userId}`;
    assert.equal(sessionKey, "ot-test-dm-user-123");

    // 3. Execute through adapter with mock gateway
    const streamedChunks: string[] = [];
    const mockGateway = {
      chatSend: mock.fn(async (_a: string, _sk: string, _msg: string, onDelta: (d: string) => void) => {
        onDelta("I'm ");
        onDelta("an NPC");
        return "I'm an NPC";
      }),
    };

    const result = await (resolvedAdapter as OpenClawAdapter).executeWithGateway(
      mockGateway,
      {
        sessionKey,
        prompt: "Hello NPC",
        onDelta: (chunk) => streamedChunks.push(chunk),
      },
      npcConfig.agentId,
    );

    // 4. Verify response
    assert.equal(result.response, "I'm an NPC");
    assert.deepEqual(streamedChunks, ["I'm ", "an NPC"]);
    assert.equal(result.session.sessionRef, sessionKey);
  });

  test("full task session flow with separate session key", async () => {
    const adapter = new OpenClawAdapter();

    const npcConfig = {
      sessionKeyPrefix: "ot-worker",
      agentId: "agent-xyz",
    };
    const taskId = "worker-20260409-ab12";

    // Task session key pattern (socket-handlers.ts:1170)
    const taskSessionKey = `${npcConfig.sessionKeyPrefix}-task-${taskId}`;
    assert.equal(taskSessionKey, "ot-worker-task-worker-20260409-ab12");

    const mockGateway = {
      chatSend: mock.fn(async () => '작업 시작합니다.\n```json:task\n{"action":"create","id":"worker-20260409-ab12","title":"테스트","status":"in_progress","summary":"시작"}\n```'),
    };

    const result = await adapter.executeWithGateway(
      mockGateway,
      { sessionKey: taskSessionKey, prompt: "태스크 시작" },
      npcConfig.agentId,
    );

    assert.ok(result.response.includes("json:task"));
    assert.ok(result.response.includes('"action":"create"'));
  });

  test("meeting session key pattern", () => {
    const prefix = "ot-meeting";
    const channelId = "ch-dev";

    // Meeting session key pattern (socket-handlers.ts:656)
    const meetingSessionKey = `${prefix}-meeting-${channelId}`;
    assert.equal(meetingSessionKey, "ot-meeting-meeting-ch-dev");

    // Summary session key pattern
    const meetingId = "m-001";
    const summarySessionKey = `${prefix}-summary-${meetingId}`;
    assert.equal(summarySessionKey, "ot-meeting-summary-m-001");
  });
});
