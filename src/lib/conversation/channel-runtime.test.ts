import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRuntime } from "./channel-runtime";
import type { EngineParticipant } from "./channel-runtime";
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

/** 폴링에는 항상 손을 들고, 실제 발언에서는 항상 터지는 목. 실패 격리 검증용. */
function alwaysFailsToSpeak(): NpcAdapter {
  return {
    type: "mock",
    async execute(options: AdapterExecuteOptions) {
      if (options.sessionKey.endsWith("-poll")) {
        return { response: "SPEAK: 말할래요", session: { sessionRef: options.sessionKey } };
      }
      throw new Error("backend down");
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  };
}

/**
 * 폴링에는 항상 손을 들고, 실제 발언은 대본을 순서대로 내놓는 목. mockAdapter와 달리
 * 폴링 호출이 대본 큐를 소비하지 않는다 — 다른 참가자가 계속 이기는 회의에서는 매 라운드
 * 폴링만 여러 번 일어나고 실제 발언은 드물게 일어나므로, 큐를 공유하면(mockAdapter처럼)
 * 실제로 말하기도 전에 대본이 바닥나 "SPEAK:" 신호를 잃는다. 실패 격리 검증용.
 */
function alwaysRaisesAndSpeaks(replies: string[]): NpcAdapter {
  const queue = [...replies];
  return {
    type: "mock",
    async execute(options: AdapterExecuteOptions) {
      if (options.sessionKey.endsWith("-poll")) {
        return { response: "SPEAK: 계속 말할래요", session: { sessionRef: options.sessionKey } };
      }
      const text = queue.length > 1 ? queue.shift()! : queue[0];
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
    const engine = new ChannelRuntime(
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
    const engine = new ChannelRuntime(
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
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 2, maxTurnsPerAgent: 20 } },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.ok(spoken.includes("a"), "손든 a가 발언해야 한다");
    assert.equal(spoken.includes("b"), false, "PASS한 b는 발언하지 않는다");
  });
});

describe("ConversationEngine — 폴링 프롬프트 내용", () => {
  test("participant.passPolicy가 폴링 프롬프트의 [발언 지침] 블록으로 실린다(옛 브로커와 동일)", async () => {
    const a = participant("a", ["PASS"], { passPolicy: "근거 없으면 PASS 하세요" });
    const b = participant("b", ["PASS"]);
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "분기 계획", participants: [a, b],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 7, maxTurnsPerAgent: 20 } },
      {},
    );
    await engine.run();

    const promptFor = (p: EngineParticipant) =>
      (p.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls[0].prompt;
    const aPrompt = promptFor(a);
    assert.match(aPrompt, /📋 \[회의 알림: 분기 계획\]/);
    assert.match(aPrompt, /발언하고 싶으면 → SPEAK: \(한줄 이유\)/);
    assert.ok(
      aPrompt.includes("[발언 지침] 근거 없으면 PASS 하세요"),
      `passPolicy를 하드코딩 null로 되돌리면 이 단언이 깨진다: ${JSON.stringify(aPrompt)}`,
    );
    assert.equal(
      promptFor(b).includes("[발언 지침]"),
      false,
      "passPolicy가 없는 참가자에게는 [발언 지침] 블록이 붙지 않는다",
    );
  });
});

describe("ConversationEngine — 연속 실패 예산", () => {
  function alwaysThrows(npcId: string): EngineParticipant {
    return {
      npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0,
      sessionKey: `sk-${npcId}`,
      adapter: {
        type: "mock",
        async execute() { throw new Error("backend down"); },
        async testConnection() { return { status: "ok" as const }; },
      },
    };
  }

  test("peer 모드에서 모든 턴이 실패하면 무한 루프 대신 전원이 예산을 소진하고 끝난다", { timeout: 5000 }, async () => {
    // 수정 전에는 실패한 턴이 트랜스크립트에 아무것도 남기지 않아 maxTotalTurns가 전진하지
    // 못했고, peer는 폴링이 없어 consecutivePasses도 오르지 않는다 — 루프가 영영 돌았다.
    // 하드 가드: 회귀 시 CI가 매달리는 대신 이 단언에서 빠르게 실패한다.
    //
    // 실패 예산이 엔진 전역이던 시절엔 "합쳐서 3회"였다. 지금은 참가자마다 예산 3을 따로
    // 가지므로, 2명이 각자 소진할 때까지 총 6회(참가자 수 × MAX_CONSECUTIVE_FAILURES) 실패해야
    // 끝난다 — 실측으로 확인했다(하드 가드 임계값 10은 6보다 넉넉히 남겨 그대로 둔다).
    const errors: string[] = [];
    let endReason: string | null = null;
    const engine = new ChannelRuntime(
      { mode: "peer", topic: "T", participants: [alwaysThrows("a"), alwaysThrows("b")],
        quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 } },
      {
        onError: (err: unknown) => {
          errors.push(String(err));
          if (errors.length > 10) engine.stop(); // 하드 가드
        },
        onEnd: (_turns: unknown, reason: string) => { endReason = reason; },
      },
    );
    await engine.run();

    assert.equal(errors.length, 6, `참가자 2명 × 예산 3 = 6회 실패 후 멈춰야 한다(실측: ${errors.length}회)`);
    assert.equal(endReason, "consecutive_failures", "종료 사유가 다른 종료와 구분되어야 한다");
  });

  test("빈 응답만 돌려주는 어댑터도(예외를 던지지 않아도) 전원 예산 소진으로 루프를 끝낸다", { timeout: 5000 }, async () => {
    // 정상 resolve + 쓸 만한 텍스트 없음 = 트랜스크립트에 아무것도 안 남는다. 예외 경로에만
    // 브레이크를 걸면 이 경로는 그대로 무한 루프였다(리뷰 실측: maxTotalTurns 3에 20회 이상).
    // 위 테스트와 같은 이유로 기대치는 참가자 2명 × 예산 3 = 6이다(실측으로 확인).
    function silent(npcId: string): EngineParticipant {
      return {
        npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0,
        sessionKey: `sk-${npcId}`,
        adapter: {
          type: "mock",
          async execute(options: AdapterExecuteOptions) {
            return { response: "", session: { sessionRef: options.sessionKey } };
          },
          async testConnection() { return { status: "ok" as const }; },
        },
      };
    }
    let turnStarts = 0;
    let endReason: string | null = null;
    const engine = new ChannelRuntime(
      { mode: "peer", topic: "T", participants: [silent("a"), silent("b")],
        quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 } },
      {
        onTurnStart: () => {
          turnStarts++;
          if (turnStarts > 20) engine.stop(); // 하드 가드 — 회귀 시 매달리지 않고 여기서 깨진다
        },
        onEnd: (_turns: unknown, reason: string) => { endReason = reason; },
      },
    );
    await engine.run();

    assert.equal(turnStarts, 6, `참가자 2명 × 예산 3 = 6회에서 멈춰야 한다(실측: ${turnStarts}회)`);
    assert.equal(endReason, "consecutive_failures");
  });

  test("run()을 다시 부르면 실패 예산이 초기화된다", { timeout: 5000 }, async () => {
    // 이전 run()의 카운터가 남아 있으면 두 번째 run()은 첫 실패에서 바로 끝난다.
    // 참가자 2명 × 예산 3 = 6(위 테스트와 동일한 이유로 실측 확인).
    let errors = 0;
    const engine = new ChannelRuntime(
      { mode: "peer", topic: "T", participants: [alwaysThrows("a"), alwaysThrows("b")],
        quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 } },
      { onError: () => { errors++; if (errors > 20) engine.stop(); } }, // 하드 가드
    );
    await engine.run();
    assert.equal(errors, 6);

    errors = 0;
    await engine.run();
    assert.equal(errors, 6, `두 번째 run()도 예산 3(참가자 2명분 6)으로 시작해야 한다(실측: ${errors}회)`);
  });

  test("성공한 턴 하나가 연속 실패 카운터를 되돌린다", { timeout: 5000 }, async () => {
    // 실패 2회 → 성공 1회 → 실패 3회. 카운터가 리셋되지 않으면 3회 실패 전에 끝난다.
    let call = 0;
    const flaky: EngineParticipant = {
      npcId: "a", displayName: "a", seated: true, turnCount: 0, lastSpokeAt: 0,
      sessionKey: "sk-a",
      adapter: {
        type: "mock",
        async execute(options: AdapterExecuteOptions) {
          call++;
          if (call === 3) return { response: "말합니다", session: { sessionRef: options.sessionKey } };
          throw new Error(`fail ${call}`);
        },
        async testConnection() { return { status: "ok" as const }; },
      },
    };
    const errors: string[] = [];
    let endReason: string | null = null;
    const engine = new ChannelRuntime(
      { mode: "peer", topic: "T", participants: [flaky],
        quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 } },
      {
        onError: (err: unknown) => {
          errors.push(String(err));
          if (errors.length > 10) engine.stop(); // 하드 가드
        },
        onEnd: (_turns: unknown, reason: string) => { endReason = reason; },
      },
    );
    await engine.run();

    assert.equal(errors.length, 5, `실패 2 + (성공) + 실패 3 = 5회여야 한다(실측: ${errors.length}회)`);
    assert.equal(endReason, "consecutive_failures");
  });
});

describe("ConversationEngine — 턴 타임아웃", () => {
  test("타임아웃으로 끊긴 턴도 onTurnEnd로 닫힌다(중단 사유를 함께 실어서)", { timeout: 5000 }, async () => {
    // onError만 보내고 끝내면 클라이언트의 스트리밍 말풍선이 done:true를 영영 못 받는다.
    const hang: NpcAdapter = {
      type: "mock",
      // 절대 resolve하지 않고 delta도 보내지 않는다 — idle 타이머가 발화하는 유일한 조건.
      execute: () => new Promise(() => {}),
      async abort() {},
      async testConnection() { return { status: "ok" as const }; },
    };
    const a: EngineParticipant = {
      npcId: "a", displayName: "a", seated: true, turnCount: 0, lastSpokeAt: 0,
      adapter: hang, sessionKey: "sk-a",
    };
    const ends: Array<[string, string, unknown]> = [];
    const errors: string[] = [];
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a], initialRunMode: "directed",
        turnTimeout: { idleMs: 10, maxMs: 1000 },
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {
        onTurnEnd: (npcId: string, text: string, meta?: unknown) => ends.push([npcId, text, meta]),
        onError: (err: unknown) => errors.push(String(err)),
        onWaitingInput: () => { engine.stop(); },
      },
    );
    engine.directSpeak("a");
    await engine.run();

    assert.equal(errors.length, 1, "타임아웃은 여전히 onError로도 보고된다");
    assert.deepEqual(ends, [["a", "", { aborted: true, reason: "timeout:idle" }]]);
  });
});

describe("ConversationEngine — 발언 프롬프트 참석자 목록", () => {
  test("참가자의 실제 role이 프롬프트에 실린다(전원 \"Participant\"로 덮어쓰지 않는다)", async () => {
    const a = participant("a", ["SPEAK: 예", "말합니다"], { role: "Facilitator" });
    const b = participant("b", ["PASS"], { role: "Analyst" });
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 } },
      {},
    );
    await engine.run();

    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    const speakPrompt = calls.find((c) => c.prompt.includes("참석자"))!.prompt;
    assert.match(speakPrompt, /a\(Facilitator\), b\(Analyst\)/);
  });

  test("role이 없으면 종전대로 Participant로 채운다", async () => {
    const a = participant("a", ["SPEAK: 예", "말합니다"]);
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 } },
      {},
    );
    await engine.run();
    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    assert.match(calls.find((c) => c.prompt.includes("참석자"))!.prompt, /a\(Participant\)/);
  });
});

describe("ConversationEngine — 착석 게이트", () => {
  test("착석하지 않은 참가자는 폴링도 발언도 하지 않는다", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["SPEAK: 저요"], { seated: false });
    const engine = new ChannelRuntime(
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
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: many,
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
        maxConcurrentPolls: 2 },
      {},
    );
    await engine.run();
    assert.equal(order.length, 4, "네 명 모두 폴링된다");
  });
});

describe("ConversationEngine — 컨트롤 서페이스: setMode / nextTurn / directSpeak / abortCurrentTurn", () => {
  test(
    "setMode에 잘못된 값을 주면 조용히 무시된다(보존된 결함 — meeting-broker.js:214를 이식. " +
      "고치지 않고 그대로 옮긴 것이며 별도 후속 수정 후보다)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      let modeChanged = false;
      let waited = false;
      const engine = new ChannelRuntime(
        { mode: "meeting", topic: "T", participants: [a],
          quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
        { onModeChanged: () => { modeChanged = true; }, onWaitingInput: () => { waited = true; } },
      );
      engine.setMode("bogus-mode"); // 유효하지 않은 문자열 — 에러도 콜백도 없이 무시되어야 한다
      await engine.run();
      assert.equal(modeChanged, false, "잘못된 mode는 onModeChanged를 트리거하지 않는다");
      assert.equal(waited, false, "runMode는 기본값 auto로 남아 대기 없이 전원 PASS로 자연 종료된다");
    },
  );

  test(
    "directSpeak에 알 수 없는 npcId를 주면 아무도 발언하지 않고 조용히 대기로 돌아간다" +
      "(보존된 결함 — meeting-broker.js의 run()이 agent를 못 찾을 때와 동일한 무음 실패. 고치지 않는다)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      const engine = new ChannelRuntime(
        { mode: "meeting", topic: "T", participants: [a], initialRunMode: "directed",
          quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
        { onWaitingInput: () => { engine.stop(); } },
      );
      engine.directSpeak("no-such-npc");
      await engine.run();
      assert.equal(
        (a.adapter as unknown as { calls: unknown[] }).calls.length, 0,
        "참가자 목록에 없는 npcId는 어댑터를 한 번도 호출하지 않는다",
      );
    },
  );

  test("manual 모드는 매 라운드 뒤 항상 대기하고 nextTurn()으로 재개한다", { timeout: 5000 }, async () => {
    const a = participant("a", ["SPEAK: 하나", "SPEAK: 둘", "PASS"]);
    const spoken: string[] = [];
    let waitCount = 0;
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a], initialRunMode: "manual",
        // maxConsecutivePasses는 두 번째 라운드(PASS)에서 바로 break되지 않을 만큼 넉넉하게 둔다 —
        // manual은 break되지 않는 한 발언 여부와 무관하게 매 라운드 뒤 대기한다는 것을 보고 싶어서다.
        quota: { maxConsecutivePasses: 5, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {
        onTurnEnd: (npcId: string) => spoken.push(npcId),
        onWaitingInput: () => {
          waitCount++;
          if (waitCount < 2) engine.nextTurn();
          else engine.stop();
        },
      },
    );
    await engine.run();
    assert.ok(waitCount >= 2, "매 라운드 뒤 대기했다");
    assert.ok(spoken.length >= 1, "대기 사이 라운드에서 발언이 일어났다");
  });

  test("nextTurn은 manual 모드가 아닐 때 아무 효과가 없다", () => {
    const a = participant("a", ["PASS"]);
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {},
    );
    assert.doesNotThrow(() => engine.nextTurn());
  });

  test("directed 모드는 폴링 없이 directSpeak로 지정된 NPC만 발언한다", { timeout: 5000 }, async () => {
    const a = participant("a", ["SPEAK: 예", "PASS"]);
    const b = participant("b", ["PASS"]);
    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a, b], initialRunMode: "directed",
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {
        onTurnEnd: (npcId: string) => spoken.push(npcId),
        onWaitingInput: () => { engine.stop(); },
      },
    );
    engine.directSpeak("a");
    await engine.run();
    assert.deepEqual(spoken, ["a"]);
    assert.equal(
      (b.adapter as unknown as { calls: unknown[] }).calls.length, 0,
      "directed는 폴링하지 않으므로 지정되지 않은 참가자의 어댑터는 한 번도 불리지 않는다",
    );
  });

  test("hybridMode: auto 중 directSpeak을 받으면 manual로 전환된다(system 발신)", { timeout: 5000 }, async () => {
    const a = participant("a", ["SPEAK: 예", "PASS"]);
    const modeChanges: Array<[string, string]> = [];
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a], initialRunMode: "auto",
        hybridMode: true, hybridAutoResumeMs: 100000,
        quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {
        onModeChanged: (mode: string, source: string) => { modeChanges.push([mode, source]); engine.stop(); },
        onWaitingInput: () => { engine.stop(); },
      },
    );
    engine.directSpeak("a");
    await engine.run();
    assert.deepEqual(modeChanges, [["manual", "system"]]);
  });

  test(
    "hybridMode: manual 대기 재개 이후 유휴 시간이 지나면 자동으로 auto로 복귀한다" +
      "(meeting-broker.js:162-167 그대로 이식 — 최초 대기가 아니라 재개된 대기부터 타이머가 걸리고, " +
      "자동 복귀도 setMode()를 거치므로 drainCommands가 source를 \"user\"로 통지한다. 둘 다 원본의 " +
      "특이 동작이며 고치지 않는다)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      const modeChanges: Array<[string, string]> = [];
      let waitCount = 0;
      const engine = new ChannelRuntime(
        { mode: "meeting", topic: "T", participants: [a], initialRunMode: "manual",
          hybridMode: true, hybridAutoResumeMs: 10,
          quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
        {
          onModeChanged: (mode: string, source: string) => {
            modeChanges.push([mode, source]);
            if (mode === "auto") engine.stop();
          },
          onWaitingInput: () => {
            waitCount++;
            if (waitCount === 1) engine.nextTurn(); // 첫 대기를 재개해야 재개-대기용 타이머가 걸린다
          },
        },
      );
      await engine.run();
      assert.deepEqual(modeChanges, [["auto", "user"]]);
      assert.equal(waitCount, 2, "재개 후 두 번째 대기에서 타이머가 만료되어 자동 복귀한다");
    },
  );

  test(
    "hybridMode: 자동 복귀 타이머가 걸린 도중 directSpeak을 받으면 타이머가 취소된다(회귀)",
    { timeout: 5000 },
    async () => {
      // waitCount1에서 nextTurn()으로 재개-대기 타이머를 건다. 그 타이머가 만료되기 전,
      // waitCount2에서 directSpeak("b")를 호출한다 — 예전 drainCommands는 이 커맨드를 다음
      // 드레인에서 소비하며 clearAutoResumeTimer()를 불렀지만, FloorInbox로 갈아끼운 뒤에는
      // 그 취소 호출이 사라져 타이머가 그대로 살아남았다(이번 라운드에서 고친 회귀).
      // stop()을 hybridAutoResumeMs보다 한참 뒤에 호출해, 고쳐지지 않았다면 그 사이에
      // 타이머가 만료돼 onModeChanged("auto", ...)가 뜰 시간을 충분히 준다.
      const a = participant("a", ["PASS"]);
      const b = participant("b", ["PASS", "안녕하세요"]);
      const modeChanges: Array<[string, string]> = [];
      const spoken: string[] = [];
      let waitCount = 0;
      let stopScheduled = false;
      const engine = new ChannelRuntime(
        { mode: "meeting", topic: "T", participants: [a, b], initialRunMode: "manual",
          hybridMode: true, hybridAutoResumeMs: 20,
          quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
        {
          onModeChanged: (mode: string, source: string) => modeChanges.push([mode, source]),
          onTurnEnd: (npcId: string) => spoken.push(npcId),
          onWaitingInput: () => {
            waitCount++;
            if (waitCount === 1) {
              engine.nextTurn(); // 재개-대기 타이머를 건다
            } else if (waitCount === 2) {
              engine.directSpeak("b"); // 타이머 만료 전에 지목 — 타이머가 취소돼야 한다
            } else if (!stopScheduled) {
              stopScheduled = true;
              setTimeout(() => engine.stop(), 60); // hybridAutoResumeMs(20)보다 한참 뒤
            }
          },
        },
      );
      await engine.run();

      assert.deepEqual(spoken, ["b"], "지목된 b가 발언해야 한다");
      assert.ok(
        !modeChanges.some(([mode]) => mode === "auto"),
        `directSpeak으로 지목한 뒤에는 자동 복귀 타이머가 취소돼 auto로 전환되면 안 된다. 실제: ${JSON.stringify(modeChanges)}`,
      );
    },
  );

  test("발언자가 없을 때 abortCurrentTurn은 아무 일도 하지 않는다", () => {
    const a = participant("a", ["PASS"]);
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      {},
    );
    assert.doesNotThrow(() => engine.abortCurrentTurn());
  });

  test("abortCurrentTurn은 현재 발언 중인 참가자의 어댑터에 세션키와 함께 abort를 호출한다", { timeout: 5000 }, async () => {
    let resolveExecute: (() => void) | null = null;
    let abortedWith: string | null = null;
    const adapter: NpcAdapter = {
      type: "mock",
      async execute(options: AdapterExecuteOptions) {
        await new Promise<void>((resolve) => { resolveExecute = resolve; });
        return { response: "PASS", session: { sessionRef: options.sessionKey } };
      },
      async abort(sessionKey: string) { abortedWith = sessionKey; },
      async testConnection() { return { status: "ok" as const }; },
    };
    const a: EngineParticipant = {
      npcId: "a", displayName: "a", seated: true, turnCount: 0, lastSpokeAt: 0,
      adapter, sessionKey: "sk-a",
    };
    const engine = new ChannelRuntime(
      { mode: "meeting", topic: "T", participants: [a], initialRunMode: "directed",
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 } },
      { onWaitingInput: () => { engine.stop(); } },
    );
    engine.directSpeak("a");
    const runPromise = engine.run();
    // speak()가 adapter.execute를 호출해 pending 상태로 들어갈 때까지 한 틱 양보한다.
    await new Promise((r) => setTimeout(r, 0));
    engine.abortCurrentTurn();
    assert.equal(abortedWith, "sk-a", "발언 중인 참가자의 세션키로 abort가 호출된다");
    resolveExecute!();
    await runPromise;
  });
});

describe("ConversationEngine — 공정성(가장 오래 발언하지 않은 참가자)", () => {
  /** 폴링·발언 모두에 항상 같은 텍스트로 답한다(큐가 1개면 절대 shift되지 않으므로 매번 재사용된다) —
   * 매 라운드 전원이 손을 드는 상황을 고정하기 위해서다. */
  function alwaysRaises(npcId: string): EngineParticipant {
    return participant(npcId, ["SPEAK: continue"]);
  }

  test("3인 이상이 매 라운드 전원 손을 들면 발언권이 배열 첫 번째로 고착되지 않고 순환한다", { timeout: 5000 }, async () => {
    const a = alwaysRaises("a");
    const b = alwaysRaises("b");
    const c = alwaysRaises("c");
    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting", topic: "T", participants: [a, b, c],
        // maxConsecutivePasses는 전원이 항상 SPEAK이므로 발동하지 않는다 — maxTotalTurns로 끊는다.
        quota: { maxConsecutivePasses: 99, cooldownMs: 0, maxTotalTurns: 6, maxTurnsPerAgent: 20 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();

    assert.equal(spoken.length, 6, "6턴이 전부 발언으로 채워진다(전원 매 라운드 SPEAK)");
    // 공정성이 살아있다면 첫 3턴 안에 a/b/c가 각각 정확히 한 번씩 나온다 — 고착이면 "a"만 반복된다.
    const firstThree = spoken.slice(0, 3);
    assert.deepEqual(
      [...firstThree].sort(),
      ["a", "b", "c"],
      `첫 3턴에 세 참가자가 각각 한 번씩 나와야 한다(고착 시 재현: ${JSON.stringify(spoken)})`,
    );
    assert.notEqual(spoken.every((id) => id === "a"), true, "공정성이 깨져 있으면 전부 a로 고착된다");
  });

  test("발언 직후에는 selectNextSpeaker에 넘어가는 lastSpokeAt이 0으로 남아있지 않다(엔진↔정책 경계 실측)", { timeout: 5000 }, async () => {
    // participantsView가 파생시키는 값을 간접적으로 검증한다: a가 먼저 한 번 발언한 뒤에도
    // 여전히 a가 손을 들면, "가장 오래 발언하지 않은" b/c보다 뒤로 밀려야 한다.
    const a = alwaysRaises("a");
    const b = alwaysRaises("b");
    const spoken: string[] = [];
    let now = 1000;
    const engine = new ChannelRuntime(
      {
        mode: "meeting", topic: "T", participants: [a, b],
        quota: { maxConsecutivePasses: 99, cooldownMs: 0, maxTotalTurns: 2, maxTurnsPerAgent: 20 },
        now: () => now++,
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.deepEqual(spoken, ["a", "b"], "a가 먼저 발언한 뒤에는 아직 발언하지 않은 b가 이어받아야 한다(a로 고착되면 안 된다)");
  });
});

describe("ConversationEngine — 사용자 개입", () => {
  test("addUserMessage가 트랜스크립트에 들어가 다음 프롬프트에 실린다", async () => {
    const a = participant("a", ["SPEAK: 예", "답변"]);
    const engine = new ChannelRuntime(
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

describe("멘션이 다음 발언권을 정한다", () => {
  test("TO: 로 지목된 참가자가 폴링과 무관하게 다음에 말한다", async () => {
    // a 가 c 를 지목한다. 폴링에서는 b 가 먼저 손을 들지만 지목이 이긴다.
    // a는 meeting 모드라 폴링에서 SPEAK: 로 먼저 손을 들어야 발언 차례가 온다 — 그 다음
    // 실제 발언에서 TO: c 로 지목한다(단일 응답으로는 폴링 단계에서 손을 들지 못해 영영
    // 발언하지 못한다 — 브리프 원안의 단일 응답으로는 a가 폴링을 통과하지 못해 이 테스트가
    // 검증 불능이었다).
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: c\n의견 부탁해요"]);
    const b = participant("b", ["SPEAK: 저요", "저는 반대입니다"]);
    const c = participant("c", ["SPEAK: 네", "말씀하신 대로입니다"]);

    const spoke: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b, c],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 2, cooldownMs: 0 },
      },
      { onTurnStart: (npcId) => spoke.push(npcId) },
    );

    await engine.run();

    assert.equal(spoke[1], "c", `지목된 c 가 아니라 ${spoke[1]} 이 말했습니다`);
  });

  test("트랜스크립트에는 TO: 라인이 빠진 본문만 실린다", async () => {
    const a = participant("a", ["TO: b\n김치찌개가 좋겠습니다"]);
    const b = participant("b", ["알겠습니다"]);

    // 엔진에는 트랜스크립트 getter 가 없다. onEnd 가 turns 배열을 넘겨준다
    // (conversation-engine.ts:388 — this.callbacks.onEnd?.(this.transcript.all(), ...)).
    let turns: Array<{ content: string }> = [];
    const engine = new ChannelRuntime(
      {
        mode: "peer",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 1, cooldownMs: 0 },
      },
      { onEnd: (all: Array<{ content: string }>) => { turns = all; } },
    );

    await engine.run();

    assert.equal(
      turns[0].content,
      "김치찌개가 좋겠습니다",
      "제어 라인이 사용자에게 보이면 안 됩니다",
    );
  });
});

describe("발언권 인박스 — 사용자 지목이 멘션을 밀어내지 않는다", () => {
  test("사용자 지목이 먼저 말하고, 멘션은 그 뒤에 남아 말한다", async () => {
    // a가 발언을 끝내며 b를 멘션한다. 하지만 그 발언이 끝나는 순간(onTurnEnd) 사용자가
    // UI에서 c를 지목한다고 가정한다 — speak()는 onTurnEnd를 먼저 부르고 멘션 커맨드는
    // 그 뒤에 큐에 넣으므로, 콜백에서 동기적으로 directSpeak()를 호출하면 인박스에는
    // [user:c, mention:b] 순서로 쌓인다. 사용자 지목이 먼저 나가고, 멘션은 버려지지 않고
    // 그 뒤에 남아 나간다 — 그게 이 테스트가 지키는 새 동작이다.
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b\n의견 부탁해요"]);
    const b = participant("b", ["PASS", "알겠습니다"]);
    const c = participant("c", ["PASS", "알겠습니다"]);

    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b, c],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 3, cooldownMs: 0 },
      },
      {
        onTurnEnd: (npcId: string) => {
          spoken.push(npcId);
          if (npcId === "a") engine.directSpeak("c");
        },
      },
    );

    await engine.run();

    assert.deepEqual(
      spoken,
      ["a", "c", "b"],
      "사용자가 지목한 c 가 먼저, 멘션된 b 가 그 뒤에 말해야 한다",
    );
  });

  test("멘션 사슬이 순서대로 전부 처리된다 — 하나도 버려지지 않는다", async () => {
    // a 가 한 번의 발언에서 b 를 지목하고, b 가 발언하며 c 를 지목한다.
    // 예전 단일 슬롯에서는 이 사슬 중 하나만 살아남았다.
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b\n먼저 b 의견 부탁해요"]);
    const b = participant("b", ["PASS", "TO: c\n저는 이렇게 봅니다"]);
    const c = participant("c", ["PASS", "저도 동의합니다"]);

    const spoke: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b, c],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 3, cooldownMs: 0 },
      },
      { onTurnStart: (npcId) => spoke.push(npcId) },
    );

    await engine.run();

    assert.deepEqual(
      spoke,
      ["a", "b", "c"],
      `지목 사슬이 순서대로 이어져야 합니다. 실제: ${JSON.stringify(spoke)}`,
    );
  });

  test("사용자 지목 없이 멘션만 있으면 멘션이 채택된다(기존 동작 유지)", async () => {
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b\n의견 부탁해요"]);
    const b = participant("b", ["PASS", "넵"]);

    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 2, cooldownMs: 0 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );

    await engine.run();

    assert.deepEqual(spoken, ["a", "b"]);
  });

  test("사용자 지목이 둘이면(멘션 없이) 마지막 것이 이긴다", async () => {
    const a = participant("a", ["첫 번째"]);
    const b = participant("b", ["두 번째"]);

    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 1, cooldownMs: 0 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );

    engine.directSpeak("a");
    engine.directSpeak("b");
    await engine.run();

    assert.deepEqual(spoken, ["b"], "동종(사용자) 지목끼리는 여전히 마지막 것이 이겨야 한다");
    assert.equal(
      (a.adapter as unknown as { calls: unknown[] }).calls.length, 0,
      "먼저 지목된 a는 한 번도 불리지 않아야 한다",
    );
  });
});

describe("빈 본문 멘션은 실패 턴으로 처리하되 지목은 살린다", () => {
  test("\"TO: 이름\"만 답하면 트랜스크립트에 빈 항목을 남기지 않는다", async () => {
    // parseMention이 TO: 라인을 걷어내면 본문이 남지 않는다("TO: b"에는 뒤따르는 줄이 없다).
    // sanitizedResponse 자체는 비어있지 않아 게이트는 통과하지만, 화면에 보여줄 말도
    // 트랜스크립트에 남길 발언도 없어야 한다.
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b"]);
    const b = participant("b", ["PASS", "안녕하세요"]);

    const spoken: string[] = [];
    let turns: Array<{ speakerId: string; content: string }> = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 1, cooldownMs: 0 },
      },
      {
        onTurnEnd: (npcId: string) => spoken.push(npcId),
        onEnd: (all: Array<{ speakerId: string; content: string }>) => { turns = all; },
      },
    );

    await engine.run();

    assert.deepEqual(spoken, ["b"], "본문 없는 a의 턴은 onTurnEnd를 트리거하지 않아야 한다");
    assert.equal(turns.length, 1, "트랜스크립트에는 빈 턴이 쌓이면 안 된다");
    assert.equal(turns[0].speakerId, "b");
  });

  test("본문이 없어도 지목 자체는 살아 b가 다음에 말한다", async () => {
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b"]);
    const b = participant("b", ["PASS", "안녕하세요"]);

    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 1, cooldownMs: 0 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );

    await engine.run();

    assert.deepEqual(spoken, ["b"], "본문이 비어 실패 처리되어도 멘션은 커맨드 큐에 반영돼야 한다");
  });
});

describe("실패 예산은 NPC 마다 따로다", () => {
  test("한 NPC 가 계속 실패해도 나머지가 회의를 이어간다", async () => {
    const a = participant("a", [], { adapter: alwaysFailsToSpeak() });
    const b = participant("b", [], { adapter: alwaysRaisesAndSpeaks(["저도요", "김치찌개요"]) });

    let turns: Array<{ speakerId: string }> = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 20, maxTotalTurns: 3, cooldownMs: 0 },
        now: () => 0,
      },
      { onEnd: (all: Array<{ speakerId: string }>) => { turns = all; } },
    );

    await engine.run();

    // a 는 예산 3 을 소진하고 후보에서 빠진다. 그 뒤로 b 가 maxTotalTurns 를 채운다.
    assert.equal(turns.length, 3, `a 의 실패가 회의를 죽이면 안 된다. 턴: ${JSON.stringify(turns)}`);
    assert.ok(
      turns.every((t) => t.speakerId === "b"),
      `발언은 전부 b 여야 한다. 실제: ${JSON.stringify(turns.map((t) => t.speakerId))}`,
    );
  });

  test("전원이 실패 예산을 소진하면 consecutive_failures 로 끝난다(운영자에게 no_candidates와 구분해 보인다)", async () => {
    const a = participant("a", [], { adapter: alwaysFailsToSpeak() });
    const b = participant("b", [], { adapter: alwaysFailsToSpeak() });

    let reason: string | null = null;
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 20, maxTotalTurns: 99, cooldownMs: 0 },
        now: () => 0,
      },
      { onEnd: (_all, endReason: string) => { reason = endReason; } },
    );

    await engine.run();

    // 후보가 0이 되는 두 경로(전원 소진 vs 전원 할당량 소진)를 같은 no_candidates로 뭉치면
    // 운영자가 "백엔드가 다 죽었다"를 "정상적으로 회의가 끝났다"로 오독한다.
    assert.equal(reason, "consecutive_failures");
  });

  test("전원이 발언 할당량(remainingTurns)을 소진하면 no_candidates 로 끝난다(예산 소진과 구분)", async () => {
    // maxTurnsPerAgent를 1로 좁혀 둘 다 정상적으로 한 번씩 말하고 할당량을 다 쓰게 만든다 —
    // 실패는 전혀 없으므로 isBurnedOut은 항상 false다. 후보가 0이 되는 원인이 실패 예산이
    // 아니라 순수 할당량이면 no_candidates 여야 한다.
    // alwaysRaisesAndSpeaks를 쓰는 이유: mockAdapter는 폴링과 실제 발언이 대본 큐를 공유해서,
    // 공정성 동률로 a가 먼저 뽑히는 동안 b가 반복 폴링만 당하면 b의 SPEAK 신호가 발언 전에
    // 소진된다(위 "한 NPC 가 계속 실패해도..." 테스트에서 발견한 것과 같은 함정).
    const a = participant("a", [], { adapter: alwaysRaisesAndSpeaks(["제 의견"]) });
    const b = participant("b", [], { adapter: alwaysRaisesAndSpeaks(["제 의견도"]) });

    let reason: string | null = null;
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 1, maxTotalTurns: 99, cooldownMs: 0 },
        now: () => 0,
      },
      { onEnd: (_all, endReason: string) => { reason = endReason; } },
    );

    await engine.run();

    assert.equal(reason, "no_candidates");
  });
});

describe("멘션은 쿼터를 존중하고, 건너뛴 지목을 알린다", () => {
  test("할당량이 소진된 NPC 의 지목은 건너뛰고 안내한다", async () => {
    // 브리프 원안은 참가자 2명(a, b)이었다: a 가 b 를 지목하고 b 가 그 할당량(1)을 쓴 뒤,
    // a 가 "매 발언마다" b 를 다시 지목해 두 번째 지목이 건너뛰어지는 그림이었다. 그런데
    // maxTurnsPerAgent 는 a 에게도 똑같이 1 이라 a 는 물리적으로 딱 한 번만 말할 수 있고,
    // 따라서 지목도 딱 한 번만 나갈 수 있다 — b 가 소진되기도 전에 유일한 지목이 이미
    // 전달돼 버려 "소진 후 건너뜀"을 재현할 방법이 없다(디버그 스크립트로 실측: spoke=[a,b],
    // notices=[] 고정). task-3-report.md 가 문서화한 것과 같은 종류의 함정 — mockAdapter 조합이
    // 아니라 이번엔 "지목자의 할당량이 피지목자의 할당량과 같다"는 구조적 제약. 참가자 c 를
    // 하나 더 두어 c 가 두 번째 지목자 역할을 한다: a 의 지목으로 b 가 할당량을 다 쓴 뒤,
    // a·b 모두 소진돼 유일하게 남은 후보 c 가 뽑혀 b 를 다시 지목한다 — 이번엔 b 가 이미
    // 소진돼 있으므로 건너뛰어야 한다. 헬퍼(participant/mockAdapter)와 구현 계약은 브리프와
    // 동일하게 유지했고, 바뀐 것은 이 새 테스트 안의 참가자 구성뿐이다.
    //
    // c 는 mockAdapter가 아니라 alwaysRaisesAndSpeaks를 쓴다 — c는 turn1의 폴링에서 a와
    // 동시에 손을 들지만 동률 공정성 규칙 때문에 a에게 진다(task-3-report.md와 같은 함정).
    // mockAdapter라면 그 폴링 한 번으로 c의 "SPEAK:" 신호(대본 큐)가 이미 소진돼, 정작
    // c 차례가 왔을 때는 대본 마지막 항목("TO: b...")이 SPEAK: 접두 없이 반복 반환되어
    // PASS로 오인된다 — c가 영영 뽑히지 못해 테스트가 성립하지 않는다.
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b\nb 의견 부탁해요"]);
    const b = participant("b", ["PASS", "김치찌개요"]);
    const c = participant("c", [], { adapter: alwaysRaisesAndSpeaks(["TO: b\n한 번 더 부탁해요"]) });

    const notices: string[] = [];
    const spoke: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        participants: [a, b, c],
        quota: { maxTurnsPerAgent: 1, maxTotalTurns: 4, cooldownMs: 0 },
        now: () => 0,
      },
      {
        onTurnStart: (npcId) => spoke.push(npcId),
        onMentionSkipped: (npcId, reason) => notices.push(`${npcId}:${reason}`),
      },
    );

    await engine.run();

    assert.equal(
      spoke.filter((id) => id === "b").length,
      1,
      `b 는 할당량 1 만큼만 말해야 한다. 실제 발언: ${JSON.stringify(spoke)}`,
    );
    assert.deepEqual(
      notices,
      ["b:quota_exhausted"],
      `건너뛴 지목은 무음이면 안 된다. 안내: ${JSON.stringify(notices)}`,
    );
  });

  test("사용자 지목은 할당량이 소진돼도 말한다", async () => {
    const a = participant("a", ["PASS", "..."]);
    const b = participant("b", ["PASS", "김치찌개요"]);

    const spoke: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        // maxTurnsPerAgent 0 이면 누구도 폴링 후보가 아니다 — 발언이 있었다면
        // 그것은 오직 사용자 지목이 쿼터를 우회했기 때문이다.
        quota: { maxTurnsPerAgent: 0, maxTotalTurns: 4, cooldownMs: 0 },
        participants: [a, b],
        initialRunMode: "directed",
        now: () => 0,
      },
      { onTurnStart: (npcId) => spoke.push(npcId) },
    );

    const running = engine.run();
    engine.directSpeak("b");
    await new Promise((r) => setTimeout(r, 30));
    engine.stop();
    await running;

    assert.deepEqual(spoke, ["b"], "사용자 지목은 할당량 0 이어도 발언해야 한다");
  });
});
