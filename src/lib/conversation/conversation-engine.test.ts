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

describe("ConversationEngine — 폴링 프롬프트 내용", () => {
  test("participant.passPolicy가 폴링 프롬프트의 [발언 지침] 블록으로 실린다(옛 브로커와 동일)", async () => {
    const a = participant("a", ["PASS"], { passPolicy: "근거 없으면 PASS 하세요" });
    const b = participant("b", ["PASS"]);
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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

describe("ConversationEngine — 컨트롤 서페이스: setMode / nextTurn / directSpeak / abortCurrentTurn", () => {
  test(
    "setMode에 잘못된 값을 주면 조용히 무시된다(보존된 결함 — meeting-broker.js:214를 이식. " +
      "고치지 않고 그대로 옮긴 것이며 별도 후속 수정 후보다)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      let modeChanged = false;
      let waited = false;
      const engine = new ConversationEngine(
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
      const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
      const engine = new ConversationEngine(
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

  test("발언자가 없을 때 abortCurrentTurn은 아무 일도 하지 않는다", () => {
    const a = participant("a", ["PASS"]);
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
    const engine = new ConversationEngine(
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
