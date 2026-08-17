// 회귀 기준선 — MeetingBroker의 현재 동작을 이관 전에 고정한다.
// P2에서 ConversationEngine으로 재작성한 뒤, 이 파일의 단언들이 새 구현에 대해
// 그대로 통과해야 한다(스펙 D9: meeting 모드 동작 불변).
// 이관이 끝나면 import 대상만 ConversationEngine으로 바꾸고 나머지는 유지한다.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MeetingBroker } = require("./meeting-broker.js") as typeof import("./meeting-broker.js");

type Reply = { text: string };

/**
 * 대본대로 답하는 목 게이트웨이.
 * scripted[agentId]가 큐이며, 호출마다 앞에서 하나씩 꺼낸다.
 * 비면 마지막 값을 반복한다(폴링이 몇 번 도는지에 테스트가 결합되지 않게).
 */
function mockGateway(scripted: Record<string, Reply[]>) {
  const calls: Array<{ agentId: string; sessionKey: string; message: string }> = [];
  const queues = new Map(Object.entries(scripted).map(([k, v]) => [k, [...v]]));
  return {
    calls,
    async chatSend(
      agentId: string,
      sessionKey: string,
      message: string,
      onChunk: (c: string) => void,
    ) {
      calls.push({ agentId, sessionKey, message });
      const q = queues.get(agentId) ?? [{ text: "PASS" }];
      const reply = q.length > 1 ? q.shift()! : q[0];
      onChunk(reply.text);
      return reply.text;
    },
    async chatAbort() {},
  };
}

const participants = [
  { agentId: "a", displayName: "에이", role: "Participant" },
  { agentId: "b", displayName: "비", role: "Participant" },
];

describe("MeetingBroker 기준선 — 폴링과 발언권", () => {
  test("PASS만 나오면 연속 PASS 상한에서 회의가 끝난다", async () => {
    const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
    let ended = false;
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxConsecutivePasses: 2, cooldownMs: 0 } },
      { onMeetingEnd: () => { ended = true; } },
    );
    await broker.run();
    assert.equal(ended, true, "onMeetingEnd가 호출되어야 한다");
    assert.equal(broker.isRunning(), false);
  });

  test("SPEAK한 참가자만 발언권 후보가 된다", async () => {
    const gw = mockGateway({
      a: [{ text: "SPEAK: 하고 싶습니다" }],
      b: [{ text: "PASS" }],
    });
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { cooldownMs: 0 } },
      {},
    );
    const { raises, passes } = await broker.pollAgents();
    assert.deepEqual(raises.map((r: { agent: { agentId: string } }) => r.agent.agentId), ["a"]);
    assert.deepEqual(passes, ["b"]);
  });

  test("여러 명이 손들면 가장 오래 발언하지 않은 쪽이 뽑힌다", () => {
    const gw = mockGateway({});
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    broker.addTurn("a", "에이", "먼저 말함");
    const selected = broker.selectSpeaker([
      { agent: participants[0], reason: "" },
      { agent: participants[1], reason: "" },
    ]);
    assert.equal(selected.agent.agentId, "b", "이미 말한 a보다 아직 안 말한 b가 우선");
  });
});

describe("MeetingBroker 기준선 — 할당량", () => {
  test("getRemainingTurns가 참가자별 발언 수를 차감한다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTurnsPerAgent: 3 } },
      {},
    );
    assert.equal(broker.getRemainingTurns("a"), 3);
    broker.addTurn("a", "에이", "1");
    broker.addTurn("a", "에이", "2");
    assert.equal(broker.getRemainingTurns("a"), 1);
    assert.equal(broker.getRemainingTurns("b"), 3, "다른 참가자는 영향받지 않는다");
  });

  test("총 턴 상한에 도달하면 isFinished가 참이 된다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTotalTurns: 2 } },
      {},
    );
    assert.equal(broker.isFinished(), false);
    broker.addTurn("a", "에이", "1");
    broker.addTurn("b", "비", "2");
    assert.equal(broker.isFinished(), true);
  });

  test("할당량을 소진한 참가자는 폴링 대상에서 빠진다", async () => {
    const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
        quota: { maxTurnsPerAgent: 1 } },
      {},
    );
    broker.addTurn("a", "에이", "소진");
    await broker.pollAgents();
    const polled = new Set(gw.calls.map((c) => c.agentId));
    assert.equal(polled.has("a"), false, "할당량 소진자는 폴링되지 않아야 한다");
    assert.equal(polled.has("b"), true);
  });
});

describe("MeetingBroker 기준선 — 모드와 개입", () => {
  test("setMode가 유효한 모드만 받아들인다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    broker.setMode("manual");
    broker.setMode("존재하지-않는-모드");
    // 잘못된 모드는 커맨드 큐에 들어가지 않는다 — drain 후 mode가 manual로 유지되는지 확인
    const { directNpcId } = (broker as unknown as { _drainCommands(): { directNpcId: string | null } })._drainCommands();
    assert.equal(directNpcId, null);
    assert.equal((broker as unknown as { mode: string }).mode, "manual");
  });

  test("addUserMessage가 연속 PASS 카운터를 초기화한다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    (broker as unknown as { consecutivePasses: number }).consecutivePasses = 1;
    broker.addUserMessage("단테", "계속하세요");
    assert.equal((broker as unknown as { consecutivePasses: number }).consecutivePasses, 0);
  });

  test("stop이 실행 상태를 내린다", () => {
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m" },
      {},
    );
    (broker as unknown as { running: boolean }).running = true;
    broker.stop();
    assert.equal(broker.isRunning(), false);
  });
});
