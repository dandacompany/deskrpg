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

// ---------------------------------------------------------------------------
// 아래부터는 review-t1.md가 지적한 "조각은 맞아도 run() 안에서의 조합은
// 검증되지 않는다"는 갭을 메우기 위해 추가된 테스트다. 기존 9개는 그대로 두고
// run() 전체 사이클, 세 가지 모드, grantFloor, 그리고 콜백 3종
// (onError/onModeChanged/onWaitingInput)을 pin 한다.
// ---------------------------------------------------------------------------

describe("MeetingBroker 기준선 — run() 전체 사이클(발언 happy path)", () => {
  test(
    "누군가 손들고 발언하면 run()이 onTurnStart→onTurnChunk→onTurnEnd→다음 폴링까지 전부 수행한다",
    { timeout: 5000 },
    async () => {
      // a는 첫 폴링에서 SPEAK, 발언 턴에서 실제 발화 텍스트, 이후 폴링에서는 PASS.
      // b는 항상 PASS. cooldownMs:0, maxConsecutivePasses:2로 all-PASS 2라운드 뒤 자연 종료되게 해
      // 테스트가 결정적으로 끝나도록 quota로 경계를 둔다.
      const gw = mockGateway({
        a: [
          { text: "SPEAK: 발언하고 싶어요" },
          { text: "제 생각에는 이렇게 하면 좋겠어요" },
          { text: "PASS" },
        ],
        b: [{ text: "PASS" }],
      });

      const turnStarts: string[] = [];
      const turnChunks: Array<{ agentId: string; chunk: string }> = [];
      const turnEnds: Array<{ agentId: string; response: string }> = [];
      let ended = false;

      const broker = new MeetingBroker(
        {
          topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
          quota: { maxTurnsPerAgent: 5, maxConsecutivePasses: 2, cooldownMs: 0 },
        },
        {
          onTurnStart: (agent: { agentId: string }) => turnStarts.push(agent.agentId),
          onTurnChunk: (agentId: string, chunk: string) => turnChunks.push({ agentId, chunk }),
          onTurnEnd: (agentId: string, response: string) => turnEnds.push({ agentId, response }),
          onMeetingEnd: () => { ended = true; },
        },
      );

      assert.equal(broker.getRemainingTurns("a"), 5);

      await broker.run();

      assert.deepEqual(turnStarts, ["a"], "a만 발언 턴을 시작해야 한다");
      assert.equal(turnChunks.length >= 1, true, "onTurnChunk가 최소 한 번은 스트리밍되어야 한다");
      assert.equal(turnChunks[0]?.agentId, "a");
      assert.equal(turnChunks[0]?.chunk, "제 생각에는 이렇게 하면 좋겠어요");
      assert.deepEqual(turnEnds, [{ agentId: "a", response: "제 생각에는 이렇게 하면 좋겠어요" }]);

      // 발언 한 번 = 남은 턴 1 차감 (transcript에 실제로 실렸는지의 관찰 가능한 증거)
      assert.equal(broker.getRemainingTurns("a"), 4);

      // 폴링 메시지("알림")는 포함하지만 발언 메시지("의견을 말씀해")는 아닌 호출만 센다
      const pollCallsForA = gw.calls.filter((c) => c.agentId === "a" && c.message.includes("알림"));
      assert.equal(
        pollCallsForA.length >= 2,
        true,
        "발언 후 루프가 종료되지 않고 최소 한 번 더 폴링으로 돌아가야 한다",
      );

      assert.equal(ended, true);
      assert.equal(broker.isRunning(), false);
    },
  );

  test(
    "연속 PASS 종료는 maxConsecutivePasses에서 정확히 멈춘다(더 일찍도 늦게도 아님)",
    { timeout: 5000 },
    async () => {
      const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
      const broker = new MeetingBroker(
        {
          topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
          quota: { maxConsecutivePasses: 2, cooldownMs: 0 },
        },
        {},
      );
      await broker.run();

      const pollsFor = (id: string) => gw.calls.filter((c) => c.agentId === id).length;
      assert.equal(pollsFor("a"), 2, "정확히 2라운드 폴링 후 끝나야 한다 — 1라운드면 첫 PASS에서 조기 종료된 것");
      assert.equal(pollsFor("b"), 2);
      assert.equal(
        gw.calls.some((c) => c.message.includes("의견을 말씀해")),
        false,
        "전원 PASS이므로 발언 턴은 한 번도 열리지 않아야 한다",
      );
    },
  );
});

describe("MeetingBroker 기준선 — run() 모드별 런타임", () => {
  test(
    "manual 모드는 run() 안에서 onWaitingInput을 호출하고 입력을 기다린다",
    { timeout: 5000 },
    async () => {
      // 전원 PASS라도 manual 모드는 auto처럼 조용히 계속 돌지 않고
      // 매 라운드 사용자 입력을 기다린다. onWaitingInput 콜백에서
      // stop()을 마이크로태스크로 지연 호출해 _waitForInput()이 실제로
      // 걸린 뒤에 풀리도록 한다(동기 호출이면 아직 _waitResolve가 없어 영원히 대기함).
      const gw = mockGateway({ a: [{ text: "PASS" }], b: [{ text: "PASS" }] });
      let waitingInputCalled = 0;
      let broker!: InstanceType<typeof MeetingBroker>;
      broker = new MeetingBroker(
        {
          topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
          settings: { initialMode: "manual" },
          quota: { maxConsecutivePasses: 10, cooldownMs: 0 },
        },
        {
          onWaitingInput: () => {
            waitingInputCalled++;
            Promise.resolve().then(() => broker.stop());
          },
        },
      );

      await broker.run();

      assert.equal(waitingInputCalled >= 1, true, "manual 모드는 폴링 후 반드시 대기해야 한다");
      assert.equal(broker.isRunning(), false);
      // auto였다면 maxConsecutivePasses:10 때문에 훨씬 더 많이 폴링했을 것 —
      // manual은 매 라운드 대기하므로 stop() 전까지 폴링이 1회에 그친다.
      assert.equal(gw.calls.filter((c) => c.agentId === "a").length, 1);
    },
  );

  test(
    "directed 모드에서 directSpeak는 폴링과 무관하게 지정된 참가자를 발언시킨다",
    { timeout: 5000 },
    async () => {
      const gw = mockGateway({ a: [{ text: "지정 발언입니다" }], b: [{ text: "PASS" }] });
      let broker!: InstanceType<typeof MeetingBroker>;
      const turnStarts: string[] = [];
      const turnEnds: Array<{ agentId: string; response: string }> = [];
      broker = new MeetingBroker(
        {
          topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m",
          settings: { initialMode: "directed" },
          quota: { cooldownMs: 0 },
        },
        {
          onTurnStart: (agent: { agentId: string }) => turnStarts.push(agent.agentId),
          onTurnEnd: (agentId: string, response: string) => turnEnds.push({ agentId, response }),
          onWaitingInput: () => { Promise.resolve().then(() => broker.stop()); },
        },
      );

      broker.directSpeak("a");
      await broker.run();

      assert.deepEqual(turnStarts, ["a"]);
      assert.deepEqual(turnEnds, [{ agentId: "a", response: "지정 발언입니다" }]);
      assert.equal(
        gw.calls.some((c) => c.agentId === "b"),
        false,
        "directed 발언은 폴링을 거치지 않으므로 b는 한 번도 호출되지 않아야 한다",
      );
    },
  );

  test("hybrid 모드에서 directSpeak는 즉시 manual로 전환하고 onModeChanged를 발화한다", () => {
    const broker = new MeetingBroker(
      {
        topic: "T", participants, gateway: mockGateway({}), sessionKeyPrefix: "s", meetingId: "m",
        settings: { initialMode: "auto", hybridMode: true },
      },
      {},
    );
    const modeChanges: Array<[string, string]> = [];
    (broker as unknown as { callbacks: Record<string, unknown> }).callbacks.onModeChanged =
      (mode: string, source: string) => modeChanges.push([mode, source]);

    broker.directSpeak("a");

    assert.equal((broker as unknown as { mode: string }).mode, "manual");
    assert.deepEqual(modeChanges, [["manual", "system"]]);
  });
});

describe("MeetingBroker 기준선 — grantFloor()", () => {
  test("grantFloor는 원본 청크로 스트리밍하고 SPEAK: 접두를 제거해 반환한다", async () => {
    const gw = mockGateway({ a: [{ text: "SPEAK: 안녕하세요" }] });
    const chunks: Array<{ agentId: string; chunk: string }> = [];
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m" },
      { onTurnChunk: (agentId: string, chunk: string) => chunks.push({ agentId, chunk }) },
    );

    const result = await broker.grantFloor(participants[0]);

    assert.equal(result, "안녕하세요", "반환값은 SPEAK: 접두가 제거된 상태여야 한다");
    // grantFloor는 _speakWithAbort와 달리 청크를 sanitize하지 않고 그대로 흘려보낸다
    assert.deepEqual(chunks, [{ agentId: "a", chunk: "SPEAK: 안녕하세요" }]);
  });

  test("grantFloor는 게이트웨이가 실패하면 null을 반환하고 onError를 호출한다", async () => {
    const failingGateway = {
      calls: [] as Array<{ agentId: string }>,
      async chatSend(agentId: string) {
        failingGateway.calls.push({ agentId });
        throw new Error("게이트웨이 실패");
      },
      async chatAbort() {},
    };
    let errorArg: { error: unknown; agentId: string } | null = null;
    const broker = new MeetingBroker(
      { topic: "T", participants, gateway: failingGateway, sessionKeyPrefix: "s", meetingId: "m" },
      { onError: (error: unknown, agentId: string) => { errorArg = { error, agentId }; } },
    );

    const result = await broker.grantFloor(participants[0]);

    assert.equal(result, null);
    assert.ok(errorArg, "onError가 호출되어야 한다");
    assert.equal((errorArg as unknown as { agentId: string }).agentId, "a");
  });
});

describe("MeetingBroker 기준선 — 알려진 결함(D9로 현행 유지, 수정 아님)", () => {
  test(
    "pollAgents는 게이트웨이 호출이 실패한 참가자를 raises/passes 어디에도 넣지 않고 onError도 호출하지 않는다",
    async () => {
      // 이 테스트는 결함을 고치는 게 아니라 고정하는 것이다.
      // review-t1.md가 지목한 가장 심각한 결함: poll 단계에서 게이트웨이 호출이
      // reject되면 해당 참가자는 그 라운드에서 조용히 사라진다(raises에도 passes에도
      // 없음) — grantFloor/_speakWithAbort와 달리 onError조차 호출되지 않는다.
      // 마이그레이션 이후 별도 태스크로 고칠 후보이며, 지금은 D9(동작 불변)에 따라
      // 있는 그대로 pin한다. 이 동작이 바뀌면 이 테스트가 실패해 "고의로 고쳤는지"를
      // 드러내는 신호가 되어야 한다.
      const calls: Array<{ agentId: string }> = [];
      const gw = {
        calls,
        async chatSend(agentId: string, _sessionKey: string, _message: string, onChunk: (c: string) => void) {
          calls.push({ agentId });
          if (agentId === "a") throw new Error("일시적 장애");
          onChunk("PASS");
          return "PASS";
        },
        async chatAbort() {},
      };
      let errorCalled = false;
      const broker = new MeetingBroker(
        { topic: "T", participants, gateway: gw, sessionKeyPrefix: "s", meetingId: "m", quota: { cooldownMs: 0 } },
        { onError: () => { errorCalled = true; } },
      );

      const { raises, passes } = await broker.pollAgents();

      assert.deepEqual(raises, [], "실패한 a는 raises에 없다");
      assert.deepEqual(passes, ["b"], "실패한 a는 passes에도 없다 — 조용히 소실");
      assert.equal(errorCalled, false, "poll 실패는 onError를 호출하지 않는다(발언 실패와 다른 처리)");
    },
  );
});
