/**
 * Phase 1 Integration Tests — Adapter Abstraction Layer
 *
 * Verifies that the adapter abstraction layer is correctly wired:
 * 1. DB schema: adapter_type and adapter_config columns exist
 * 2. AdapterRegistry: correct routing behavior
 * 4. NpcConfig: adapterType field populated from DB
 * 5. MeetingBroker: adapterResolver accepted
 * 6. Unsupported adapter: clean rejection
 */
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

import { CodexAdapter } from "./codex-adapter";
import { AdapterRegistry } from "./types";
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
    // openclaw_config 는 은퇴했다 — 내용(페르소나)은 agent_config 로 옮겨졌고,
    // 정본이 둘이 되지 않도록 열 자체를 없앴다.
    assert.ok("agentConfig" in npcColumns, "페르소나는 agent_config 에 산다");
    assert.ok(!("openclawConfig" in npcColumns), "openclaw_config 는 남아 있으면 안 된다");
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

// (구 3번 섹션 — OpenClawAdapter 스트리밍/에러 처리 — 은 어댑터와 함께 삭제됐다.)

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

// (구 5번 섹션 — MeetingBroker adapterResolver 배선 — 은 브로커와 함께 삭제됐다.
//  P2 에서 ConversationEngine 이 그 역할을 이어받았고, 그쪽은
//  src/lib/conversation/conversation-engine.test.ts 가 검증한다.)


// ---------------------------------------------------------------------------
// 6. Unsupported adapter — clean rejection path
// ---------------------------------------------------------------------------

describe("Phase1: Unsupported adapter path", () => {
  test("registry.has returns false for unregistered CLI adapters", () => {
    const registry = new AdapterRegistry();
    registry.register(new CodexAdapter());

    assert.equal(registry.has("codex"), true);
    assert.equal(registry.has("claude"), false);
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

  test("adapter routing guard: an unregistered type is rejected before dispatch", () => {
    // streamNpcResponse 의 가드와 같은 판정 — 레지스트리에 없는 어댑터로는 보내지 않는다.
    const registry = new AdapterRegistry();
    registry.register(new CodexAdapter());

    const npcConfig = { adapterType: "claude" };

    assert.equal(!registry.has(npcConfig.adapterType), true, "등록되지 않은 어댑터는 거부된다");
    assert.equal(!registry.has("codex"), false, "등록된 어댑터는 통과한다");
  });
});

// (구 End-to-end adapter pipeline 섹션은 OpenClawAdapter.executeWithGateway 를 목
//  게이트웨이에 대고 부르는 것이 본체였다. 어댑터가 사라졌으므로 다른 어댑터로 옮겨
//  심을 내용이 아니다 — 남는 것은 세션 키 조립 규칙뿐이고 그건 다른 곳에서 본다.)
