import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChannelRuntime } from "./channel-runtime";
import type { EngineParticipant } from "./channel-runtime";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

/** A mock adapter that answers on script. Records the call arguments. */
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

/** A mock that always raises its hand on poll but always blows up on the actual turn. For testing failure isolation. */
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
 * A mock that always raises its hand on poll and gives back the script in order on the
 * actual turn. Unlike mockAdapter, a poll call never consumes the script queue — in a
 * meeting where another participant keeps winning, polling happens many times per round
 * while actual speaking is rare, so sharing the queue (as mockAdapter does) would drain
 * the script before ever actually speaking and lose the "SPEAK:" signal. For testing
 * failure isolation.
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

function participant(
  npcId: string,
  replies: string[],
  over: Partial<EngineParticipant> = {},
): EngineParticipant {
  return {
    npcId,
    displayName: npcId,
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    adapter: mockAdapter(replies),
    sessionKey: `sk-${npcId}`,
    ...over,
  };
}

describe("ConversationEngine — peer mode", () => {
  test("alternates speaking without polling", async () => {
    const a = participant("a", ["안녕"]);
    const b = participant("b", ["반가워"]);
    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "peer",
        topic: "T",
        participants: [a, b],
        quota: { maxTotalTurns: 4, maxTurnsPerAgent: 10, cooldownMs: 0 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.deepEqual(spoken, ["a", "b", "a", "b"], "교대로 4턴");

    // Proves there was no polling: each adapter's call count == that participant's speak count
    const aCalls = (a.adapter as unknown as { calls: unknown[] }).calls.length;
    assert.equal(aCalls, 2, "peer는 발언당 1회만 호출한다(폴링 호출 없음)");
  });
});

describe("ConversationEngine — meeting mode", () => {
  test("ends once everyone PASSes for the cap number of rounds", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["PASS"]);
    let ended = false;
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
      },
      {
        onEnd: () => {
          ended = true;
        },
      },
    );
    await engine.run();
    assert.equal(ended, true);
    assert.equal(engine.isRunning(), false);
  });

  test("only a participant who SPEAKs gets the floor", async () => {
    const a = participant("a", ["SPEAK: 하겠습니다", "말합니다", "PASS"]);
    const b = participant("b", ["PASS"]);
    const spoken: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 2, maxTurnsPerAgent: 20 },
      },
      { onTurnEnd: (npcId: string) => spoken.push(npcId) },
    );
    await engine.run();
    assert.ok(spoken.includes("a"), "손든 a가 발언해야 한다");
    assert.equal(spoken.includes("b"), false, "PASS한 b는 발언하지 않는다");
  });
});

describe("ConversationEngine — poll prompt content", () => {
  test("participant.passPolicy is carried in the poll prompt's [발언 지침] block (same as the old broker)", async () => {
    const a = participant("a", ["PASS"], { passPolicy: "근거 없으면 PASS 하세요" });
    const b = participant("b", ["PASS"]);
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "분기 계획",
        participants: [a, b],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 7, maxTurnsPerAgent: 20 },
      },
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

describe("ConversationEngine — consecutive-failure budget", () => {
  function alwaysThrows(npcId: string): EngineParticipant {
    return {
      npcId,
      displayName: npcId,
      seated: true,
      turnCount: 0,
      lastSpokeAt: 0,
      sessionKey: `sk-${npcId}`,
      adapter: {
        type: "mock",
        async execute() {
          throw new Error("backend down");
        },
        async testConnection() {
          return { status: "ok" as const };
        },
      },
    };
  }

  test(
    "in meeting mode, a poll that reaches nobody is a failure, not a round of silence",
    { timeout: 5000 },
    async () => {
      // Live on staging: with the gateway stopped every poll rejected, the round counted as
      // "all passed", and the meeting ended after two rounds as consecutive_passes with no
      // error on screen. The user could not tell a dead gateway from a quiet room.
      const down = Object.assign(new Error("fetch failed"), { code: "unreachable" });
      const unreachable = (npcId: string): EngineParticipant => ({
        ...alwaysThrows(npcId),
        adapter: {
          type: "mock",
          async execute() {
            throw down;
          },
          async testConnection() {
            return { status: "ok" as const };
          },
        },
      });
      const errors: unknown[] = [];
      let endReason: string | null = null;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [unreachable("a"), unreachable("b")],
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onError: (err: unknown) => {
            errors.push(err);
            if (errors.length > 10) engine.stop(); // hard guard
          },
          onEnd: (_turns: unknown, reason: string) => {
            endReason = reason;
          },
        },
      );
      await engine.run();
      assert.equal(endReason, "consecutive_failures");
      assert.equal(
        errors.length,
        1,
        "one report per unreachable streak, not one per NPC per round",
      );
      assert.equal(errors[0] === down, true, "the adapter's own error is reported");
    },
  );

  test(
    "in meeting mode, a poll where someone answers is still a round of silence",
    { timeout: 5000 },
    async () => {
      const errors: unknown[] = [];
      let endReason: string | null = null;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [alwaysThrows("a"), participant("b", ["PASS"])],
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onError: (err: unknown) => errors.push(err),
          onEnd: (_turns: unknown, reason: string) => {
            endReason = reason;
          },
        },
      );
      await engine.run();
      assert.equal(endReason, "consecutive_passes");
      assert.equal(errors.length, 0);
    },
  );

  test(
    "in peer mode, if every turn fails, everyone exhausts their budget and it ends instead of looping forever",
    { timeout: 5000 },
    async () => {
      // Before the fix, a failed turn left nothing in the transcript, so maxTotalTurns
      // never advanced, and peer has no polling so consecutivePasses never rose either —
      // the loop ran forever.
      // Hard guard: on a regression, this fails fast at this assertion instead of hanging CI.
      //
      // Back when the failure budget was engine-global it was "3 total". Now each
      // participant has its own budget of 3, so it takes a total of 6 failures (participant
      // count × MAX_CONSECUTIVE_FAILURES) before both exhaust theirs and it ends — confirmed
      // by measurement (the hard-guard threshold of 10 is kept as-is, well above 6).
      const errors: string[] = [];
      let endReason: string | null = null;
      const engine = new ChannelRuntime(
        {
          mode: "peer",
          topic: "T",
          participants: [alwaysThrows("a"), alwaysThrows("b")],
          quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 },
        },
        {
          onError: (err: unknown) => {
            errors.push(String(err));
            if (errors.length > 10) engine.stop(); // hard guard
          },
          onEnd: (_turns: unknown, reason: string) => {
            endReason = reason;
          },
        },
      );
      await engine.run();

      assert.equal(
        errors.length,
        6,
        `참가자 2명 × 예산 3 = 6회 실패 후 멈춰야 한다(실측: ${errors.length}회)`,
      );
      assert.equal(endReason, "consecutive_failures", "종료 사유가 다른 종료와 구분되어야 한다");
    },
  );

  test(
    "an adapter that only returns empty responses (without throwing) also ends the loop once everyone's budget is exhausted",
    { timeout: 5000 },
    async () => {
      // A clean resolve + no usable text = nothing gets added to the transcript. If the
      // break were only on the exception path, this path would loop forever (observed in
      // review: 20+ iterations with maxTotalTurns of 3).
      // Same reasoning as the test above: expected is participants (2) × budget (3) = 6 (confirmed by measurement).
      function silent(npcId: string): EngineParticipant {
        return {
          npcId,
          displayName: npcId,
          seated: true,
          turnCount: 0,
          lastSpokeAt: 0,
          sessionKey: `sk-${npcId}`,
          adapter: {
            type: "mock",
            async execute(options: AdapterExecuteOptions) {
              return { response: "", session: { sessionRef: options.sessionKey } };
            },
            async testConnection() {
              return { status: "ok" as const };
            },
          },
        };
      }
      let turnStarts = 0;
      let endReason: string | null = null;
      const engine = new ChannelRuntime(
        {
          mode: "peer",
          topic: "T",
          participants: [silent("a"), silent("b")],
          quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 },
        },
        {
          onTurnStart: () => {
            turnStarts++;
            if (turnStarts > 20) engine.stop(); // hard guard — on regression, breaks here instead of hanging
          },
          onEnd: (_turns: unknown, reason: string) => {
            endReason = reason;
          },
        },
      );
      await engine.run();

      assert.equal(
        turnStarts,
        6,
        `참가자 2명 × 예산 3 = 6회에서 멈춰야 한다(실측: ${turnStarts}회)`,
      );
      assert.equal(endReason, "consecutive_failures");
    },
  );

  test("calling run() again resets the failure budget", { timeout: 5000 }, async () => {
    // If the previous run()'s counter survives, the second run() would end on its first failure.
    // Participants (2) × budget (3) = 6 (confirmed by measurement, same reasoning as above).
    let errors = 0;
    const engine = new ChannelRuntime(
      {
        mode: "peer",
        topic: "T",
        participants: [alwaysThrows("a"), alwaysThrows("b")],
        quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 },
      },
      {
        onError: () => {
          errors++;
          if (errors > 20) engine.stop();
        },
      }, // hard guard
    );
    await engine.run();
    assert.equal(errors, 6);

    errors = 0;
    await engine.run();
    assert.equal(
      errors,
      6,
      `두 번째 run()도 예산 3(참가자 2명분 6)으로 시작해야 한다(실측: ${errors}회)`,
    );
  });

  test(
    "one successful turn resets the consecutive-failure counter",
    { timeout: 5000 },
    async () => {
      // 2 failures → 1 success → 3 failures. If the counter didn't reset, this would end before the 3rd failure.
      let call = 0;
      const flaky: EngineParticipant = {
        npcId: "a",
        displayName: "a",
        seated: true,
        turnCount: 0,
        lastSpokeAt: 0,
        sessionKey: "sk-a",
        adapter: {
          type: "mock",
          async execute(options: AdapterExecuteOptions) {
            call++;
            if (call === 3)
              return { response: "말합니다", session: { sessionRef: options.sessionKey } };
            throw new Error(`fail ${call}`);
          },
          async testConnection() {
            return { status: "ok" as const };
          },
        },
      };
      const errors: string[] = [];
      let endReason: string | null = null;
      const engine = new ChannelRuntime(
        {
          mode: "peer",
          topic: "T",
          participants: [flaky],
          quota: { cooldownMs: 0, maxTotalTurns: 99, maxTurnsPerAgent: 20 },
        },
        {
          onError: (err: unknown) => {
            errors.push(String(err));
            if (errors.length > 10) engine.stop(); // hard guard
          },
          onEnd: (_turns: unknown, reason: string) => {
            endReason = reason;
          },
        },
      );
      await engine.run();

      assert.equal(
        errors.length,
        5,
        `실패 2 + (성공) + 실패 3 = 5회여야 한다(실측: ${errors.length}회)`,
      );
      assert.equal(endReason, "consecutive_failures");
    },
  );
});

describe("ConversationEngine — turn timeout", () => {
  test(
    "a turn cut off by timeout is also closed via onTurnEnd (carrying the abort reason)",
    { timeout: 5000 },
    async () => {
      // Ending with only onError means the client's streaming bubble never gets done:true.
      const hang: NpcAdapter = {
        type: "mock",
        // Never resolves and never sends a delta — the only condition under which the idle timer fires.
        execute: () => new Promise(() => {}),
        async abort() {},
        async testConnection() {
          return { status: "ok" as const };
        },
      };
      const a: EngineParticipant = {
        npcId: "a",
        displayName: "a",
        seated: true,
        turnCount: 0,
        lastSpokeAt: 0,
        adapter: hang,
        sessionKey: "sk-a",
      };
      const ends: Array<[string, string, unknown]> = [];
      const errors: string[] = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "directed",
          turnTimeout: { idleMs: 10, maxMs: 1000 },
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onTurnEnd: (npcId: string, text: string, meta?: unknown) =>
            ends.push([npcId, text, meta]),
          onError: (err: unknown) => errors.push(String(err)),
          onWaitingInput: () => {
            engine.stop();
          },
        },
      );
      engine.directSpeak("a");
      await engine.run();

      assert.equal(errors.length, 1, "타임아웃은 여전히 onError로도 보고된다");
      assert.deepEqual(ends, [["a", "", { aborted: true, reason: "timeout:idle" }]]);
    },
  );

  test("a turn waiting on a tool approval is not cut off by idle", { timeout: 5000 }, async () => {
    // The run goes silent while a person decides; only the next progress event re-arms idle.
    const waits: NpcAdapter = {
      type: "mock",
      execute: async (opts: AdapterExecuteOptions) => {
        opts.onApprovalRequest?.({
          runId: "run_1",
          requestId: "req_1",
          command: "mcp_probe_write_note",
          description: "write-capable MCP tool",
          kind: "mcp",
          patternKey: null,
          choices: ["once", "session", "deny"],
        });
        await new Promise((r) => setTimeout(r, 60));
        opts.onToolProgress?.("mcp_probe_write_note", "");
        return { response: "기록했습니다", session: { sessionRef: opts.sessionKey } };
      },
      async abort() {},
      async testConnection() {
        return { status: "ok" as const };
      },
    };
    const a: EngineParticipant = {
      npcId: "a",
      displayName: "a",
      seated: true,
      turnCount: 0,
      lastSpokeAt: 0,
      adapter: waits,
      sessionKey: "sk-a",
    };
    const ends: Array<[string, string, unknown]> = [];
    const errors: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        initialRunMode: "directed",
        turnTimeout: { idleMs: 20, maxMs: 1000 },
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
      },
      {
        onTurnEnd: (npcId: string, text: string, meta?: unknown) => ends.push([npcId, text, meta]),
        onError: (err: unknown) => errors.push(String(err)),
        onWaitingInput: () => {
          engine.stop();
        },
      },
    );
    engine.directSpeak("a");
    await engine.run();
    assert.deepEqual(errors, []);
    assert.equal(ends.length, 1);
    assert.equal(ends[0][1], "기록했습니다");
  });
});

describe("ConversationEngine — participant list in the speak prompt", () => {
  test('a participant\'s actual role is carried in the prompt (not overwritten to "Participant" for everyone)', async () => {
    const a = participant("a", ["SPEAK: 예", "말합니다"], { role: "Facilitator" });
    const b = participant("b", ["PASS"], { role: "Analyst" });
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
      },
      {},
    );
    await engine.run();

    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    const speakPrompt = calls.find((c) => c.prompt.includes("참석자"))!.prompt;
    assert.match(speakPrompt, /a\(Facilitator\), b\(Analyst\)/);
  });

  test("with no role, it falls back to Participant as before", async () => {
    const a = participant("a", ["SPEAK: 예", "말합니다"]);
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
      },
      {},
    );
    await engine.run();
    const calls = (a.adapter as unknown as { calls: AdapterExecuteOptions[] }).calls;
    assert.match(calls.find((c) => c.prompt.includes("참석자"))!.prompt, /a\(Participant\)/);
  });
});

describe("ConversationEngine — seated gate", () => {
  test("an unseated participant neither polls nor speaks", async () => {
    const a = participant("a", ["PASS"]);
    const b = participant("b", ["SPEAK: 저요"], { seated: false });
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
      },
      {},
    );
    await engine.run();
    assert.equal(
      (b.adapter as unknown as { calls: unknown[] }).calls.length,
      0,
      "미착석 참가자는 어댑터가 한 번도 불리지 않아야 한다",
    );
  });
});

describe("ConversationEngine — poll chunking", () => {
  test("splits into chunks when there are more participants than maxConcurrentPolls", async () => {
    const order: string[] = [];
    const many = ["a", "b", "c", "d"].map((id) => {
      const pt = participant(id, ["PASS"]);
      const inner = pt.adapter.execute.bind(pt.adapter);
      pt.adapter.execute = async (o: AdapterExecuteOptions) => {
        order.push(id);
        return inner(o);
      };
      return pt;
    });
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: many,
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
        maxConcurrentPolls: 2,
      },
      {},
    );
    await engine.run();
    assert.equal(order.length, 4, "네 명 모두 폴링된다");
  });
});

describe("ConversationEngine — control surface: setMode / nextTurn / directSpeak / abortCurrentTurn", () => {
  test(
    "setMode silently ignores an invalid value (preserved defect — ported from meeting-broker.js:214. " +
      "Moved as-is without fixing; a candidate for a separate follow-up fix)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      let modeChanged = false;
      let waited = false;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          quota: {
            maxConsecutivePasses: 1,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onModeChanged: () => {
            modeChanged = true;
          },
          onWaitingInput: () => {
            waited = true;
          },
        },
      );
      engine.setMode("bogus-mode"); // an invalid string — must be ignored with no error and no callback
      await engine.run();
      assert.equal(modeChanged, false, "잘못된 mode는 onModeChanged를 트리거하지 않는다");
      assert.equal(
        waited,
        false,
        "runMode는 기본값 auto로 남아 대기 없이 전원 PASS로 자연 종료된다",
      );
    },
  );

  test(
    "directSpeak with an unknown npcId makes no one speak and silently returns to waiting" +
      " (preserved defect — the same silent failure as meeting-broker.js run() when it cannot find the agent. Not fixed)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "directed",
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onWaitingInput: () => {
            engine.stop();
          },
        },
      );
      engine.directSpeak("no-such-npc");
      await engine.run();
      assert.equal(
        (a.adapter as unknown as { calls: unknown[] }).calls.length,
        0,
        "참가자 목록에 없는 npcId는 어댑터를 한 번도 호출하지 않는다",
      );
    },
  );

  test(
    "manual mode always waits after every round and resumes via nextTurn()",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["SPEAK: 하나", "SPEAK: 둘", "PASS"]);
      const spoken: string[] = [];
      let waitCount = 0;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "manual",
          // maxConsecutivePasses is set generously enough that the second round (PASS)
          // doesn't immediately break — the point is to show that manual waits after every
          // round regardless of whether anyone spoke, as long as it hasn't broken out.
          quota: {
            maxConsecutivePasses: 5,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
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
    },
  );

  test("nextTurn has no effect outside manual mode", () => {
    const a = participant("a", ["PASS"]);
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
      },
      {},
    );
    assert.doesNotThrow(() => engine.nextTurn());
  });

  test(
    "directed mode has no polling — only the NPC named via directSpeak speaks",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["SPEAK: 예", "PASS"]);
      const b = participant("b", ["PASS"]);
      const spoken: string[] = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b],
          initialRunMode: "directed",
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onTurnEnd: (npcId: string) => spoken.push(npcId),
          onWaitingInput: () => {
            engine.stop();
          },
        },
      );
      engine.directSpeak("a");
      await engine.run();
      assert.deepEqual(spoken, ["a"]);
      assert.equal(
        (b.adapter as unknown as { calls: unknown[] }).calls.length,
        0,
        "directed는 폴링하지 않으므로 지정되지 않은 참가자의 어댑터는 한 번도 불리지 않는다",
      );
    },
  );

  test(
    "hybridMode: receiving directSpeak while in auto switches to manual (sourced as system)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["SPEAK: 예", "PASS"]);
      const modeChanges: Array<[string, string]> = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "auto",
          hybridMode: true,
          hybridAutoResumeMs: 100000,
          quota: {
            maxConsecutivePasses: 50,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onModeChanged: (mode: string, source: string) => {
            modeChanges.push([mode, source]);
            engine.stop();
          },
          onWaitingInput: () => {
            engine.stop();
          },
        },
      );
      engine.directSpeak("a");
      await engine.run();
      assert.deepEqual(modeChanges, [["manual", "system"]]);
    },
  );

  test(
    "hybridMode: after a manual wait resumes, it returns to auto once the idle time passes" +
      " (ported as-is from meeting-broker.js:162-167 — the timer starts on a resumed wait, not the first one, " +
      'and the auto return also goes through setMode(), so drainCommands reports source as "user". Both are ' +
      "quirks of the original and are not fixed)",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS"]);
      const modeChanges: Array<[string, string]> = [];
      let waitCount = 0;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "manual",
          hybridMode: true,
          hybridAutoResumeMs: 10,
          quota: {
            maxConsecutivePasses: 50,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onModeChanged: (mode: string, source: string) => {
            modeChanges.push([mode, source]);
            if (mode === "auto") engine.stop();
          },
          onWaitingInput: () => {
            waitCount++;
            if (waitCount === 1) engine.nextTurn(); // resuming the first wait is what arms the resumed-wait timer
          },
        },
      );
      await engine.run();
      assert.deepEqual(modeChanges, [["auto", "user"]]);
      assert.equal(waitCount, 2, "재개 후 두 번째 대기에서 타이머가 만료되어 자동 복귀한다");
    },
  );

  test(
    "hybridMode: receiving directSpeak while the auto-resume timer is armed cancels the timer (regression)",
    { timeout: 5000 },
    async () => {
      // At waitCount1, nextTurn() arms the resumed-wait timer. Before that timer expires,
      // waitCount2 calls directSpeak("b") — the old drainCommands used to consume this
      // command on the next drain and call clearAutoResumeTimer(), but after switching to
      // FloorInbox that cancel call was dropped and the timer survived (the regression
      // fixed in this round). stop() is called well after hybridAutoResumeMs so that, if
      // this weren't fixed, there's enough time in between for the timer to expire and
      // onModeChanged("auto", ...) to fire.
      const a = participant("a", ["PASS"]);
      const b = participant("b", ["PASS", "안녕하세요"]);
      const modeChanges: Array<[string, string]> = [];
      const spoken: string[] = [];
      let waitCount = 0;
      let stopScheduled = false;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b],
          initialRunMode: "manual",
          hybridMode: true,
          hybridAutoResumeMs: 20,
          quota: {
            maxConsecutivePasses: 50,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onModeChanged: (mode: string, source: string) => modeChanges.push([mode, source]),
          onTurnEnd: (npcId: string) => spoken.push(npcId),
          onWaitingInput: () => {
            waitCount++;
            if (waitCount === 1) {
              engine.nextTurn(); // arms the resumed-wait timer
            } else if (waitCount === 2) {
              engine.directSpeak("b"); // called out before the timer expires — the timer must be canceled
            } else if (!stopScheduled) {
              stopScheduled = true;
              setTimeout(() => engine.stop(), 60); // well after hybridAutoResumeMs(20)
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

  test(
    "hybridMode: pressing nextTurn repeatedly orphans the earlier auto-resume timer, which still fires (regression)",
    { timeout: 8000 },
    async () => {
      // The same defect as directSpeak's counterpart (:520) was left on the nextTurn side.
      // The end of a manual round overwrites the field with a new timer **regardless of why**
      // the wait was released, but nextTurn() never called clearAutoResumeTimer(). So the
      // moment a second nextTurn overwrites the field with T2, T1 loses its handle and can't
      // be canceled, and it expires and calls setMode("auto") while the user is still
      // manually driving the meeting.
      //
      // Timing is arranged so this test catches only the orphan — auto-resume after the user
      // lets go is normal behavior and must not be caught as a failure:
      //
      //   t=60,120,180  the user calls nextTurn (rearming the timer each time)
      //   t=210         orphan T1 (armed at 60, +150) expires — auto here is **only from the bug**
      //   t=260         stop. The legitimate timer T3 (armed at 180) isn't due until 330, so it hasn't fired yet
      //
      // So if auto is observed at all, it must be the orphan. Reproduction note: two calls to
      // nextTurn alone won't trigger it — at the time of the first call the timer isn't armed yet, so no orphan is created.
      const a = participant("a", ["PASS"]);
      const b = participant("b", ["PASS"]);
      const modeChanges: Array<[string, string]> = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b],
          initialRunMode: "manual",
          hybridMode: true,
          hybridAutoResumeMs: 150,
          quota: {
            maxConsecutivePasses: 50,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        { onModeChanged: (mode: string, source: string) => modeChanges.push([mode, source]) },
      );

      const running = engine.run();
      for (const at of [60, 120, 180]) {
        await new Promise((r) => setTimeout(r, at === 60 ? 60 : 60));
        engine.nextTurn();
      }
      await new Promise((r) => setTimeout(r, 80)); // t≈260
      engine.stop();
      await running;

      assert.ok(
        !modeChanges.some(([mode]) => mode === "auto"),
        `사용자가 nextTurn으로 회의를 몰고 있는 동안 고아 타이머가 발화했다. 실제: ${JSON.stringify(modeChanges)}`,
      );
    },
  );

  test("abortCurrentTurn does nothing when there is no current speaker", () => {
    const a = participant("a", ["PASS"]);
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        quota: { maxConsecutivePasses: 1, cooldownMs: 0, maxTotalTurns: 50, maxTurnsPerAgent: 20 },
      },
      {},
    );
    assert.doesNotThrow(() => engine.abortCurrentTurn());
  });

  test(
    "abortCurrentTurn calls abort on the current speaker's adapter with its session key",
    { timeout: 5000 },
    async () => {
      let resolveExecute: (() => void) | null = null;
      let abortedWith: string | null = null;
      const adapter: NpcAdapter = {
        type: "mock",
        async execute(options: AdapterExecuteOptions) {
          await new Promise<void>((resolve) => {
            resolveExecute = resolve;
          });
          return { response: "PASS", session: { sessionRef: options.sessionKey } };
        },
        async abort(sessionKey: string) {
          abortedWith = sessionKey;
        },
        async testConnection() {
          return { status: "ok" as const };
        },
      };
      const a: EngineParticipant = {
        npcId: "a",
        displayName: "a",
        seated: true,
        turnCount: 0,
        lastSpokeAt: 0,
        adapter,
        sessionKey: "sk-a",
      };
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a],
          initialRunMode: "directed",
          quota: {
            maxConsecutivePasses: 2,
            cooldownMs: 0,
            maxTotalTurns: 50,
            maxTurnsPerAgent: 20,
          },
        },
        {
          onWaitingInput: () => {
            engine.stop();
          },
        },
      );
      engine.directSpeak("a");
      const runPromise = engine.run();
      // Yields one tick so speak() has called adapter.execute and entered the pending state.
      await new Promise((r) => setTimeout(r, 0));
      engine.abortCurrentTurn();
      assert.equal(abortedWith, "sk-a", "발언 중인 참가자의 세션키로 abort가 호출된다");
      resolveExecute!();
      await runPromise;
    },
  );
});

describe("ConversationEngine — fairness (whoever has gone longest without speaking)", () => {
  /** Always answers the same text for both poll and speak (a queue of 1 is never shifted,
   * so it's reused every time) — pins the scenario where everyone raises their hand every round. */
  function alwaysRaises(npcId: string): EngineParticipant {
    return participant(npcId, ["SPEAK: continue"]);
  }

  test(
    "with 3+ participants all raising their hand every round, the floor rotates instead of sticking to the first array element",
    { timeout: 5000 },
    async () => {
      const a = alwaysRaises("a");
      const b = alwaysRaises("b");
      const c = alwaysRaises("c");
      const spoken: string[] = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b, c],
          // maxConsecutivePasses never triggers since everyone always SPEAKs — maxTotalTurns cuts it off instead.
          quota: {
            maxConsecutivePasses: 99,
            cooldownMs: 0,
            maxTotalTurns: 6,
            maxTurnsPerAgent: 20,
          },
        },
        { onTurnEnd: (npcId: string) => spoken.push(npcId) },
      );
      await engine.run();

      assert.equal(spoken.length, 6, "6턴이 전부 발언으로 채워진다(전원 매 라운드 SPEAK)");
      // If fairness holds, a/b/c each appear exactly once within the first 3 turns — if stuck, only "a" repeats.
      const firstThree = spoken.slice(0, 3);
      assert.deepEqual(
        [...firstThree].sort(),
        ["a", "b", "c"],
        `첫 3턴에 세 참가자가 각각 한 번씩 나와야 한다(고착 시 재현: ${JSON.stringify(spoken)})`,
      );
      assert.notEqual(
        spoken.every((id) => id === "a"),
        true,
        "공정성이 깨져 있으면 전부 a로 고착된다",
      );
    },
  );

  test(
    "right after speaking, the lastSpokeAt passed into selectNextSpeaker is no longer 0 (measured at the engine↔policy boundary)",
    { timeout: 5000 },
    async () => {
      // Indirectly verifies the value participantsView derives: even if a keeps raising
      // its hand after speaking once, it must be pushed behind b/c, who have "gone longest without speaking".
      const a = alwaysRaises("a");
      const b = alwaysRaises("b");
      const spoken: string[] = [];
      let now = 1000;
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b],
          quota: {
            maxConsecutivePasses: 99,
            cooldownMs: 0,
            maxTotalTurns: 2,
            maxTurnsPerAgent: 20,
          },
          now: () => now++,
        },
        { onTurnEnd: (npcId: string) => spoken.push(npcId) },
      );
      await engine.run();
      assert.deepEqual(
        spoken,
        ["a", "b"],
        "a가 먼저 발언한 뒤에는 아직 발언하지 않은 b가 이어받아야 한다(a로 고착되면 안 된다)",
      );
    },
  );
});

describe("ConversationEngine — user intervention", () => {
  test("addUserMessage enters the transcript and is carried in the next prompt", async () => {
    const a = participant("a", ["SPEAK: 예", "답변"]);
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
      },
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

describe("a mention decides who gets the floor next", () => {
  test("a participant named via TO: speaks next regardless of polling", async () => {
    // a calls out c. In polling, b raises its hand first, but the call-out wins.
    // Since a is in meeting mode, it must first raise its hand via SPEAK: on the poll to
    // get a turn — only then does it call out TO: c on the actual turn (a single reply
    // would never raise its hand at the polling stage and would never speak — with the
    // brief's original single reply, a couldn't get past polling, which made this test
    // impossible to verify).
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

  test("the transcript carries only the body with the TO: line stripped out", async () => {
    const a = participant("a", ["TO: b\n김치찌개가 좋겠습니다"]);
    const b = participant("b", ["알겠습니다"]);

    // The engine has no transcript getter. onEnd hands over the turns array
    // (conversation-engine.ts:388 — this.callbacks.onEnd?.(this.transcript.all(), ...)).
    let turns: Array<{ content: string }> = [];
    const engine = new ChannelRuntime(
      {
        mode: "peer",
        topic: "T",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 5, maxTotalTurns: 1, cooldownMs: 0 },
      },
      {
        onEnd: (all: Array<{ content: string }>) => {
          turns = all;
        },
      },
    );

    await engine.run();

    assert.equal(
      turns[0].content,
      "김치찌개가 좋겠습니다",
      "제어 라인이 사용자에게 보이면 안 됩니다",
    );
  });
});

describe("the floor inbox — a user call-out does not push out a mention", () => {
  test("the user's call-out speaks first, and the mention survives to speak after it", async () => {
    // a mentions b while finishing its turn. Assume that, right as that turn ends
    // (onTurnEnd), the user calls out c in the UI — speak() calls onTurnEnd first and only
    // queues the mention command afterward, so calling directSpeak() synchronously from the
    // callback stacks the inbox as [user:c, mention:b]. The user's call-out goes out
    // first, and the mention is not dropped — it survives to go out after it. That's the
    // new behavior this test pins.
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

  test("a chain of mentions is processed entirely in order — none is dropped", async () => {
    // a calls out b in one turn, and b calls out c while speaking.
    // With the old single slot, only one link of this chain used to survive.
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

  test("a mention alone, with no user call-out, is adopted (existing behavior preserved)", async () => {
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

  test("with two user call-outs (no mention), the last one wins", async () => {
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
      (a.adapter as unknown as { calls: unknown[] }).calls.length,
      0,
      "먼저 지목된 a는 한 번도 불리지 않아야 한다",
    );
  });
});

describe("an empty-body mention is treated as a failed turn, but the call-out survives", () => {
  test('replying with only "TO: name" leaves no empty entry in the transcript', async () => {
    // Once parseMention strips the TO: line, no body remains ("TO: b" has no following
    // line). sanitizedResponse itself isn't empty so it passes the gate, but there should
    // be neither text to show on screen nor an utterance to leave in the transcript.
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
        // onTurnEnd now means both "spoke" and "closed the bubble" — a failed turn must
        // also be closed, otherwise the client bubble is left open. What this test checks
        // is the former, so calls flagged as aborted are filtered out.
        onTurnEnd: (npcId: string, _text: string, meta?: { aborted: true }) => {
          if (!meta?.aborted) spoken.push(npcId);
        },
        onEnd: (all: Array<{ speakerId: string; content: string }>) => {
          turns = all;
        },
      },
    );

    await engine.run();

    assert.deepEqual(spoken, ["b"], "본문 없는 a의 턴은 발언으로 집계되면 안 된다");
    assert.equal(turns.length, 1, "트랜스크립트에는 빈 턴이 쌓이면 안 된다");
    assert.equal(turns[0].speakerId, "b");
  });

  test("even with no body, the call-out itself survives and b speaks next", async () => {
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
      {
        onTurnEnd: (npcId: string, _text: string, meta?: { aborted: true }) => {
          if (!meta?.aborted) spoken.push(npcId);
        },
      },
    );

    await engine.run();

    assert.deepEqual(spoken, ["b"], "본문이 비어 실패 처리되어도 멘션은 인박스에 반영돼야 한다");
  });
});

describe("the failure budget is separate per NPC", () => {
  test("even if one NPC keeps failing, the rest keep the meeting going", async () => {
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
      {
        onEnd: (all: Array<{ speakerId: string }>) => {
          turns = all;
        },
      },
    );

    await engine.run();

    // a exhausts its budget of 3 and drops out of the candidates. b then fills out maxTotalTurns.
    assert.equal(
      turns.length,
      3,
      `a 의 실패가 회의를 죽이면 안 된다. 턴: ${JSON.stringify(turns)}`,
    );
    assert.ok(
      turns.every((t) => t.speakerId === "b"),
      `발언은 전부 b 여야 한다. 실제: ${JSON.stringify(turns.map((t) => t.speakerId))}`,
    );
  });

  test("when everyone exhausts their failure budget, it ends as consecutive_failures (shown to operators distinct from no_candidates)", async () => {
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
      {
        onEnd: (_all, endReason: string) => {
          reason = endReason;
        },
      },
    );

    await engine.run();

    // Lumping the two paths to zero candidates (everyone exhausted vs. everyone out of
    // quota) into the same no_candidates would make an operator misread "the backend is
    // completely dead" as "the meeting ended normally".
    assert.equal(reason, "consecutive_failures");
  });

  test("when everyone exhausts their speaking quota (remainingTurns), it ends as no_candidates (distinct from budget exhaustion)", async () => {
    // maxTurnsPerAgent is narrowed to 1 so both speak once normally and use up their quota
    // — with no failures at all, isBurnedOut is always false. When the cause of candidates
    // hitting zero is pure quota rather than the failure budget, it must be no_candidates.
    // Why alwaysRaisesAndSpeaks is used: mockAdapter shares the script queue between
    // polling and actual speaking, so while a keeps getting picked first on a fairness
    // tie, b getting polled repeatedly would drain b's SPEAK signal before it ever gets to
    // speak (the same pitfall discovered in the "even if one NPC keeps failing..." test above).
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
      {
        onEnd: (_all, endReason: string) => {
          reason = endReason;
        },
      },
    );

    await engine.run();

    assert.equal(reason, "no_candidates");
  });
});

describe("a mention respects quota, and a skipped call-out is announced", () => {
  test("a call-out to an NPC that has exhausted its quota is skipped and announced", async () => {
    // The brief's original plan had 2 participants (a, b): a calls out b, b uses up its
    // quota (1), then a calls out b again "on every turn" so the second call-out gets
    // skipped. But maxTurnsPerAgent is equally 1 for a too, so a can physically speak only
    // once, and therefore issue only one call-out — the one and only call-out is delivered
    // before b is even exhausted, leaving no way to reproduce "skipped after exhaustion"
    // (measured with a debug script: spoke=[a,b], notices=[] every time). The same kind of
    // pitfall documented in task-3-report.md — but this time not a mockAdapter combination,
    // rather the structural constraint that "the caller's quota equals the callee's
    // quota". A third participant c is added to act as the second caller: after a's
    // call-out uses up b's quota, both a and b are exhausted, so the only remaining
    // candidate c gets picked and calls out b again — this time b is already exhausted, so
    // it must be skipped. The helpers (participant/mockAdapter) and the implementation
    // contract are kept identical to the brief; only the participant makeup within this
    // new test changed.
    //
    // c uses alwaysRaisesAndSpeaks instead of mockAdapter — in turn 1's poll, c raises its
    // hand at the same time as a but loses to a under the fairness tie-break rule (the same
    // pitfall as task-3-report.md). With mockAdapter, that one poll call would already drain
    // c's "SPEAK:" signal (the script queue), so by the time c's turn actually comes, the
    // script's last item ("TO: b...") would be returned repeatedly without the SPEAK:
    // prefix and get mistaken for PASS — c would never get picked and the test wouldn't hold.
    const a = participant("a", ["SPEAK: 의견 있어요", "TO: b\nb 의견 부탁해요"]);
    const b = participant("b", ["PASS", "김치찌개요"]);
    const c = participant("c", [], {
      adapter: alwaysRaisesAndSpeaks(["TO: b\n한 번 더 부탁해요"]),
    });

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

  test("a call-out to an NPC exhausted by consecutive gateway failures is skipped as backend_failing (distinct from quota_exhausted)", async () => {
    // b responds to polls but its actual turn always throws — its quota (remainingTurns)
    // stays intact while only its failure budget gets exhausted. directSpeak uses the
    // inbox's user slot, which bypasses the isEligible check (inbox.ts take()), so calling
    // b repeatedly can deterministically produce 3 consecutive failures
    // (MAX_CONSECUTIVE_FAILURES) even without a natural mention chain. After that, when a
    // mentions b, that call-out must this time go through the eligibility check and be
    // skipped, with the reason being backend_failing rather than quota_exhausted —
    // floor-controller.ts's predicate is still true (since quota remains), but
    // isBurnedOut() is true, so the cause is a dead gateway.
    const a = participant("a", ["TO: b\n한 번 더 부탁해요"]);
    const b = participant("b", [], { adapter: alwaysFailsToSpeak() });

    const notices: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        participants: [a, b],
        quota: { maxTurnsPerAgent: 20, maxTotalTurns: 99, cooldownMs: 0 },
        initialRunMode: "directed",
        now: () => 0,
      },
      { onMentionSkipped: (npcId, reason) => notices.push(`${npcId}:${reason}`) },
    );

    const running = engine.run();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Calling b directly three times fills 3 consecutive failures (its quota of 20 stays
    // intact — a failed turn is never recorded in the transcript, so it doesn't eat into remainingTurns).
    engine.directSpeak("b");
    await wait(20);
    engine.directSpeak("b");
    await wait(20);
    engine.directSpeak("b");
    await wait(20);

    // Calls a to make it mention b — this time it goes through the inbox's mentions queue, so it does get the isEligible check.
    engine.directSpeak("a");
    await wait(20);

    // Once a's turn ends, the loop goes back into waiting via armWait() (directed always
    // waits for the next input after handling a grant) — that wait must be released for the
    // next loop iteration to actually consume b's queued mention via floor.next(). Calling
    // directSpeak again would fill the user slot and get consumed before b's mention
    // (the mentions queue), so setMode is called again with the same mode to release only
    // the wait without touching the user slot.
    engine.setMode("directed");
    await wait(20);

    engine.stop();
    await running;

    assert.deepEqual(
      notices,
      ["b:backend_failing"],
      `실패 예산 소진(할당량은 남음)은 quota_exhausted 가 아니라 backend_failing 으로 알려야 한다. 실제: ${JSON.stringify(notices)}`,
    );
  });

  test("a user call-out speaks even when quota is exhausted", async () => {
    const a = participant("a", ["PASS", "..."]);
    const b = participant("b", ["PASS", "김치찌개요"]);

    const spoke: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "점심",
        // With maxTurnsPerAgent at 0, nobody is a polling candidate — if anyone spoke,
        // it can only be because the user's call-out bypassed quota.
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

describe("a failed turn also closes the chat bubble", () => {
  // The client's streaming bubble closes only via the done:true that onTurnEnd produces
  // (meeting-discussion.ts emits MEETING_NPC_STREAM_EVENT with done:true, and MeetingRoom's
  // handleNpcStream finalizes the buffer then and also clears setCurrentSpeaker(null)).
  // It used to be that, of five branches, only success and timeout called onTurnEnd, so an
  // empty response or a plain error left the bubble open and the "speaking" indicator never cleared.

  /** A mock that resolves cleanly but has no usable text at all. */
  function silent(): NpcAdapter {
    return {
      type: "mock",
      async execute(options: AdapterExecuteOptions) {
        if (options.sessionKey.endsWith("-poll")) {
          return { response: "SPEAK: 말할래요", session: { sessionRef: options.sessionKey } };
        }
        return { response: "", session: { sessionRef: options.sessionKey } };
      },
      async testConnection() {
        return { status: "ok" as const };
      },
    };
  }

  /** A mock that passes polling but returns only TO: on the actual turn — no body. */
  function mentionOnly(target: string): NpcAdapter {
    return {
      type: "mock",
      async execute(options: AdapterExecuteOptions) {
        if (options.sessionKey.endsWith("-poll")) {
          return { response: "SPEAK: 말할래요", session: { sessionRef: options.sessionKey } };
        }
        return { response: `TO: ${target}`, session: { sessionRef: options.sessionKey } };
      },
      async testConnection() {
        return { status: "ok" as const };
      },
    };
  }

  type EndCall = { npcId: string; text: string; reason: string | null };

  function collectEnds(participants: EngineParticipant[], maxTotalTurns = 1) {
    const ends: EndCall[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants,
        quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns, maxTurnsPerAgent: 20 },
        now: () => 0,
      },
      {
        onTurnEnd: (npcId: string, text: string, meta?: { aborted: true; reason: string }) =>
          ends.push({ npcId, text, reason: meta?.reason ?? null }),
      },
    );
    return { engine, ends };
  }

  test("a turn that returned only an empty response is also closed via onTurnEnd", async () => {
    const a = participant("a", [], { adapter: silent() });
    const { engine, ends } = collectEnds([a]);
    // An empty response never grows the transcript, so maxTotalTurns doesn't end it — the failure budget does.
    await engine.run();

    assert.ok(ends.length > 0, "빈 응답 턴에서 onTurnEnd 가 한 번도 불리지 않았습니다");
    assert.equal(ends[0].reason, "empty_response");
  });

  test("a turn with only TO: and no body is also closed, and the call-out survives intact", async () => {
    const a = participant("a", [], { adapter: mentionOnly("b") });
    const b = participant("b", ["PASS", "김치찌개요"]);
    const spoke: string[] = [];
    const ends: EndCall[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a, b],
        quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
        now: () => 0,
      },
      {
        onTurnStart: (npcId: string) => spoke.push(npcId),
        onTurnEnd: (npcId: string, text: string, meta?: { aborted: true; reason: string }) =>
          ends.push({ npcId, text, reason: meta?.reason ?? null }),
      },
    );
    await engine.run();

    const aEnd = ends.find((e) => e.npcId === "a");
    assert.ok(aEnd, `a 의 턴이 닫히지 않았습니다. 실제: ${JSON.stringify(ends)}`);
    assert.equal(aEnd!.reason, "empty_after_mention");
    assert.ok(spoke.includes("b"), "본문이 비어도 지목은 살아 b 가 발언해야 합니다");
  });

  test("a plain throw also closes the bubble, alongside onError", async () => {
    const a = participant("a", [], { adapter: alwaysFailsToSpeak() });
    const errors: string[] = [];
    const ends: EndCall[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
        now: () => 0,
      },
      {
        onError: (err: unknown) => errors.push(String(err)),
        onTurnEnd: (npcId: string, text: string, meta?: { aborted: true; reason: string }) =>
          ends.push({ npcId, text, reason: meta?.reason ?? null }),
      },
    );
    await engine.run();

    assert.ok(errors.length > 0, "onError 가 불려야 합니다");
    assert.ok(ends.length > 0, "throw 한 턴에서 onTurnEnd 가 한 번도 불리지 않았습니다");
    assert.equal(ends[0].reason, "adapter_error");
  });
});

describe("a release that arrives before a wait is armed is not lost", () => {
  // releaseWait() used to silently drop the release if waitResolve was null. A release
  // arriving **before** a wait is armed disappears, and the wait armed right after wakes
  // nobody up — the meeting stalls.
  //
  // This window actually opened once: making MeetingFloorController.next() async let
  // directSpeak() slip in during the one microtask tick that await forces, and at the time
  // it was patched over only for that one path, via the special case "skip next() when
  // directed and the inbox is empty", reverting it to synchronous. This test pins the wait
  // primitive itself, not that special case.

  test(
    "a call-out issued in the same synchronous section as run() starting is still processed",
    { timeout: 5000 },
    async () => {
      const a = participant("a", ["PASS", "..."]);
      const b = participant("b", ["PASS", "김치찌개요"]);
      const spoke: string[] = [];
      const engine = new ChannelRuntime(
        {
          mode: "meeting",
          topic: "T",
          participants: [a, b],
          initialRunMode: "directed",
          quota: {
            maxConsecutivePasses: 50,
            cooldownMs: 0,
            maxTotalTurns: 4,
            maxTurnsPerAgent: 20,
          },
          now: () => 0,
        },
        { onTurnStart: (npcId: string) => spoke.push(npcId) },
      );

      // Calls out immediately **in the same synchronous section**, without awaiting run().
      // run() hasn't reached armWait() yet, so releaseWait() finds no armed wait.
      const running = engine.run();
      engine.directSpeak("b");

      await new Promise((r) => setTimeout(r, 60));
      engine.stop();
      await running;

      assert.deepEqual(
        spoke,
        ["b"],
        `동기 구간의 지목이 유실됐습니다. 실제: ${JSON.stringify(spoke)}`,
      );
    },
  );

  test("a release arriving twice still passes only one wait", { timeout: 5000 }, async () => {
    // If the memory is a **counter** instead of a latch, an accumulated release would pass
    // through subsequent waits one after another, and manual mode would effectively run
    // like auto. One wait must pass through exactly one release.
    //
    // Basis (measured): calling nextTurn() twice in the same synchronous section without
    // awaiting run() runs 2 turns with a latch and 3 turns with a counter — because the
    // second release also swallows the wait that follows. mockAdapter shares the script
    // queue between polling and speaking, so from the second round on it reads as PASS —
    // at that point no more turns run and the difference between latch and counter never
    // shows. So a mock that keeps raising its hand is used instead.
    const a = participant("a", [], { adapter: alwaysRaisesAndSpeaks(["발언"]) });
    const turns: string[] = [];
    const engine = new ChannelRuntime(
      {
        mode: "meeting",
        topic: "T",
        participants: [a],
        initialRunMode: "manual",
        quota: { maxConsecutivePasses: 50, cooldownMs: 0, maxTotalTurns: 20, maxTurnsPerAgent: 20 },
        now: () => 0,
      },
      { onTurnStart: (npcId: string) => turns.push(npcId) },
    );

    const running = engine.run();
    engine.nextTurn();
    engine.nextTurn(); // the second one must be swallowed

    await new Promise((r) => setTimeout(r, 80));
    engine.stop();
    await running;

    assert.equal(
      turns.length,
      2,
      `해제 두 번이 대기 두 번을 통과시켰습니다(카운터 의미). 실제 턴 수: ${turns.length}`,
    );
  });
});
