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

  test("소진된 NPC 를 지명하면 onMentionSkipped 만 부르고 말하지 않는다", async () => {
    // 실패를 MAX_CONSECUTIVE_FAILURES(3)만큼 쌓아 실제로 burned out 상태를 만든다 —
    // 내부 필드를 건드리지 않아야 "언젠가 이 분기로 들어온다"가 진짜로 고정된다.
    const a = p("n1", "단비", throwing());
    const starts: string[] = [];
    const skipped: Array<[string, string]> = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnStart: (npcId) => starts.push(npcId),
        onMentionSkipped: (npcId, reason) => skipped.push([npcId, reason]),
        onError: () => {},
      },
    );

    for (let i = 0; i < 3; i++) await rt.handleHumanMessage("지호", "@[단비] 어때?");
    assert.deepEqual(starts, ["n1", "n1", "n1"], "소진되기 전까지는 세 번 다 시도한다");
    assert.deepEqual(skipped, [], "소진 전에는 건너뛰지 않는다");

    await rt.handleHumanMessage("지호", "@[단비] 이번엔?");

    assert.deepEqual(skipped, [["n1", "backend_failing"]], "소진된 NPC 는 사유와 함께 정확히 한 번 알린다");
    assert.equal(starts.length, 3, "소진된 NPC 는 새 턴을 열지 않는다");
  });

  test("onTurnStart 는 호출자의 소켓 id 를 싣는다 — NPC 사슬도 같은 값", async () => {
    // 이 값이 클라이언트의 A* 대상이다. null 이면 아무 클라이언트도 걷기를 시작하지 않는다.
    const a = p("n1", "단비", always("@[하늘] 네 생각은?"));
    const b = p("n2", "하늘", always("저는 좋아요"));
    const starts: Array<[string, string | null]> = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnStart: (npcId, _name, callerSocketId) => starts.push([npcId, callerSocketId]) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 시작해줘", "socket-abc");

    assert.deepEqual(
      starts,
      [["n1", "socket-abc"], ["n2", "socket-abc"]],
      "사슬을 시작한 사람이 여전히 걸어갈 대상이므로 NPC 가 부른 턴도 같은 소켓 id 를 쓴다",
    );
  });

  test("호출자가 바뀌면 다음 턴부터 새 호출자에게 걸어간다", async () => {
    const a = p("n1", "단비", always("네"));
    const starts: Array<string | null> = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnStart: (_id, _name, callerSocketId) => starts.push(callerSocketId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 하나", "socket-a");
    await rt.handleHumanMessage("소라", "@[단비] 둘", "socket-b");

    assert.deepEqual(starts, ["socket-a", "socket-b"], "런타임은 채널당 하나라 호출자를 박아 두면 안 된다");
  });

  test("onTurnStart 가 던져도 그 NPC 가 영구히 잠기지 않는다", async () => {
    // io.emit 은 호출부가 주입하는 남의 코드다. 한 번 던졌다고 speaking 집합에 남으면
    // 그 NPC 는 프로세스가 죽을 때까지 이 채널에서 말하지 못한다.
    const a = p("n1", "단비", always("네"));
    let boom = true;
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnStart: () => {
          if (boom) { boom = false; throw new Error("emit failed"); }
        },
      },
    );

    await assert.rejects(() => rt.handleHumanMessage("지호", "@[단비] 하나", "socket-a"));

    assert.equal(rt.isSpeaking("n1"), false, "실패한 턴 뒤에도 잠금이 풀려 있어야 한다");
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
