import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OpenChatRuntime } from "./open-chat-runtime";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

/** 지정한 시간만큼 기다렸다가 정해진 답을 돌려주는 목. 동시성 검증용. */
function delayed(reply: string, ms: number): NpcAdapter {
  return {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      await new Promise((r) => setTimeout(r, ms));
      return { response: reply, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() { return { status: "ok" as const }; },
  } as NpcAdapter;
}

function always(reply: string): NpcAdapter {
  return {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      return { response: reply, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() { return { status: "ok" as const }; },
  } as NpcAdapter;
}

function throwing(): NpcAdapter {
  return {
    type: "mock",
    async execute() { throw new Error("backend down"); },
    async testConnection() { return { status: "ok" as const }; },
  } as NpcAdapter;
}

function p(npcId: string, displayName: string, adapter: NpcAdapter): EngineParticipant {
  return {
    npcId, displayName, seated: true, turnCount: 0, lastSpokeAt: 0,
    sessionKey: `sk-${npcId}`, adapter, role: "동료",
  };
}

const TIMEOUT = { idleMs: 3000, maxMs: 5000 };

describe("OpenChatRuntime", () => {
  test("한 메시지에 둘을 지명하면 둘 다 말한다", async () => {
    const a = p("n1", "단비", always("김치찌개요"));
    const b = p("n2", "하늘", always("저도요"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 점심 뭐 먹지?");

    assert.deepEqual(spoke.sort(), ["n1", "n2"]);
  });

  test("먼저 끝난 쪽이 먼저 말한다 — 순서대로 돌지 않는다", async () => {
    // 이 단언이 "동시 발언"의 전부다. 순차 구현이면 항상 지명 순서(단비→하늘)로 나온다.
    const a = p("n1", "단비", delayed("느린 답", 80));
    const b = p("n2", "하늘", delayed("빠른 답", 10));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 어때?");

    assert.deepEqual(spoke, ["n2", "n1"], `늦게 부른 하늘이 먼저 끝났으므로 먼저 말해야 한다. 실제: ${JSON.stringify(spoke)}`);
  });

  test("사람이 지명하면 예산을 쓰지 않는다 — 예산 0 이어도 전원 대답", async () => {
    const a = p("n1", "단비", always("네"));
    const b = p("n2", "하늘", always("네"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT, budget: 0 },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 어때?");

    assert.equal(spoke.length, 2, "사람이 부른 것은 예산과 무관하다");
  });

  test("NPC 가 지명하면 예산을 쓰고, 다 쓰면 멈춘다", async () => {
    // 단비가 하늘을, 하늘이 단비를 계속 부른다. 예산 2 면 NPC 발 지명은 2회까지.
    const a = p("n1", "단비", always("@[하늘] 네 생각은?"));
    const b = p("n2", "하늘", always("@[단비] 아니 네 생각은?"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT, budget: 2 },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 시작해줘");

    // 사람이 부른 단비 1회(무료) + NPC 발 지명 2회 = 최대 3회
    assert.ok(spoke.length <= 3, `예산이 사슬을 끊어야 한다. 실제: ${spoke.length}회`);
    assert.ok(spoke.length >= 2, `적어도 사람이 부른 것과 그 다음 하나는 나와야 한다. 실제: ${spoke.length}회`);
  });

  test("이미 말하는 중인 NPC 를 또 부르면 무시한다", async () => {
    const a = p("n1", "단비", delayed("네", 60));
    const starts: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnStart: (npcId) => starts.push(npcId) },
    );

    const first = rt.handleHumanMessage("지호", "@[단비] 하나");
    // 첫 턴이 끝나기 전에 또 부른다
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rt.isSpeaking("n1"), true);
    await rt.handleHumanMessage("지호", "@[단비] 둘");
    await first;

    assert.deepEqual(starts, ["n1"], "이미 말하는 중이므로 두 번째 지명은 새 턴을 만들지 않아야 한다");
  });

  test("어댑터가 터져도 다른 NPC 는 말한다", async () => {
    const a = p("n1", "단비", throwing());
    const b = p("n2", "하늘", always("저는 괜찮아요"));
    const spoke: string[] = [];
    const errors: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnEnd: (npcId, _t, meta) => { if (!meta?.aborted) spoke.push(npcId); },
        onError: (err) => errors.push(String(err)),
      },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 어때?");

    assert.deepEqual(spoke, ["n2"], "터진 NPC 만 빠져야 한다");
    assert.equal(errors.length, 1);
  });

  test("지명이 없으면 아무도 깨지 않는다", async () => {
    const a = p("n1", "단비", always("네"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "오늘 날씨 좋네");

    assert.deepEqual(spoke, [], "지명 전용이므로 그냥 하는 말에는 반응하지 않는다");
  });
});
