import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ConversationEngine } from "./conversation-engine";
import type { EngineParticipant } from "./conversation-engine";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

/** 대본대로 답하는 목 어댑터. 호출 인자를 기록한다. */
function mockAdapter(replies: string[]): NpcAdapter & { calls: AdapterExecuteOptions[] } {
  const queue = [...replies];
  const calls: AdapterExecuteOptions[] = [];
  return {
    type: "mock",
    calls,
    async execute(options: AdapterExecuteOptions) {
      calls.push(options);
      const text = queue.length > 1 ? queue.shift()! : queue[0];
      options.onDelta?.(text);
      return { response: text, session: { sessionRef: options.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  };
}

function participant(npcId: string, replies: string[], over: Partial<EngineParticipant> = {}): EngineParticipant {
  return {
    npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0,
    adapter: mockAdapter(replies), sessionKey: `sk-${npcId}`, ...over,
  };
}

describe("ConversationEngine — peer 모드", () => {
  test("폴링 없이 교대로 발언한다", async () => {
    const a = participant("a", ["안녕"]);
    const b = participant("b", ["반가워"]);
    const spoken: string[] = [];
    const engine = new ConversationEngine(
      { mode: "peer", topic: "T", participants: [a, b],
        quota: { maxTotalTurns: 4, maxTurnsPerAgent: 10, cooldownMs: 0 } },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.deepEqual(spoken, ["a", "b", "a", "b"], "교대로 4턴");

    // 폴링이 없었음을 증명: 각 어댑터 호출 수 == 그 참가자의 발언 수
    const aCalls = (a.adapter as unknown as { calls: unknown[] }).calls.length;
    assert.equal(aCalls, 2, "peer는 발언당 1회만 호출한다(폴링 호출 없음)");
  });
});

describe("ConversationEngine — meeting 모드", () => {
  test("전원 PASS가 상한만큼 반복되면 종료한다", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["PASS"]);
    let ended = false;
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      { onEnd: () => { ended = true; } },
    );
    await engine.run();
    assert.equal(ended, true);
    assert.equal(engine.isRunning(), false);
  });

  test("SPEAK한 참가자에게만 발언권이 간다", async () => {
    const a = participant("a", ["SPEAK: 하겠습니다", "말합니다", "PASS"]);
    const b = participant("b", ["PASS"]);
    const spoken: string[] = [];
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 2, maxTurnsPerAgent: 20 } },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.ok(spoken.includes("a"), "손든 a가 발언해야 한다");
    assert.equal(spoken.includes("b"), false, "PASS한 b는 발언하지 않는다");
  });
});

describe("ConversationEngine — 착석 게이트", () => {
  test("착석하지 않은 참가자는 폴링도 발언도 하지 않는다", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["SPEAK: 저요"], { seated: false });
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {},
    );
    await engine.run();
    assert.equal((b.adapter as unknown as { calls: unknown[] }).calls.length, 0,
      "미착석 참가자는 어댑터가 한 번도 불리지 않아야 한다");
  });
});

describe("ConversationEngine — 폴링 청크", () => {
  test("maxConcurrentPolls보다 참가자가 많으면 나눠서 호출한다", async () => {
    const order: string[] = [];
    const many = ["a", "b", "c", "d"].map((id) => {
      const pt = participant(id, ["PASS"]);
      const inner = pt.adapter.execute.bind(pt.adapter);
      pt.adapter.execute = async (o: AdapterExecuteOptions) => { order.push(id); return inner(o); };
      return pt;
    });
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: many,
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
        maxConcurrentPolls: 2 },
      {},
    );
    await engine.run();
    assert.equal(order.length, 4, "네 명 모두 폴링된다");
  });
});

describe("ConversationEngine — 사용자 개입", () => {
  test("addUserMessage가 트랜스크립트에 들어가 다음 프롬프트에 실린다", async () => {
    const a = participant("a", ["SPEAK: 예", "답변"]);
    const engine = new ConversationEngine(
      { mode: "meeting", topic: "T", participants: [a],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 } },
      {},
    );
    engine.addUserMessage("단테", "빨리 결론 내세요");
    await engine.run();
    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    const withHistory = calls.find((c) => (c.conversationHistory?.length ?? 0) > 0);
    assert.ok(withHistory, "사용자 메시지가 conversationHistory로 전달되어야 한다");
    assert.ok(
      withHistory!.conversationHistory!.some((h) => h.content.includes("빨리 결론 내세요")),
      "사용자 발언 내용이 히스토리에 있어야 한다",
    );
  });
});
