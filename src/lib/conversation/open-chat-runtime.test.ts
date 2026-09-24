import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OpenChatRuntime } from "./open-chat-runtime";
import type { EngineParticipant } from "./types";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";

/** A mock that waits the given time before returning a fixed reply. For concurrency verification. */
function delayed(reply: string, ms: number): NpcAdapter {
  return {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      await new Promise((r) => setTimeout(r, ms));
      return { response: reply, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
}

function always(reply: string): NpcAdapter {
  return {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      return { response: reply, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
}

function throwing(): NpcAdapter {
  return {
    type: "mock",
    async execute() {
      throw new Error("backend down");
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
}

function p(npcId: string, displayName: string, adapter: NpcAdapter): EngineParticipant {
  return {
    npcId,
    displayName,
    seated: true,
    turnCount: 0,
    lastSpokeAt: 0,
    sessionKey: `sk-${npcId}`,
    adapter,
    role: "동료",
  };
}

const TIMEOUT = { idleMs: 3000, maxMs: 5000 };

describe("OpenChatRuntime", () => {
  test("mentioning two in one message makes both speak", async () => {
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

  test("whichever finishes first speaks first — it doesn't go in call order", async () => {
    // This assertion is the whole point of "simultaneous speaking." A sequential implementation would always come out in mention order (단비→하늘).
    const a = p("n1", "단비", delayed("느린 답", 80));
    const b = p("n2", "하늘", delayed("빠른 답", 10));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 어때?");

    assert.deepEqual(
      spoke,
      ["n2", "n1"],
      `늦게 부른 하늘이 먼저 끝났으므로 먼저 말해야 한다. 실제: ${JSON.stringify(spoke)}`,
    );
  });

  test("a human mention doesn't spend budget — everyone still answers even at budget 0", async () => {
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

  test("an NPC mention spends budget, and it stops once budget runs out", async () => {
    // 단비 keeps calling 하늘 and 하늘 keeps calling 단비. With a budget of 2, NPC-issued mentions cap at 2.
    const a = p("n1", "단비", always("@[하늘] 네 생각은?"));
    const b = p("n2", "하늘", always("@[단비] 아니 네 생각은?"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT, budget: 2 },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 시작해줘");

    // 1 human-called turn for 단비 (free) + 2 NPC-issued mentions = 3 turns max
    assert.ok(spoke.length <= 3, `예산이 사슬을 끊어야 한다. 실제: ${spoke.length}회`);
    assert.ok(
      spoke.length >= 2,
      `적어도 사람이 부른 것과 그 다음 하나는 나와야 한다. 실제: ${spoke.length}회`,
    );
  });

  test("calling an already-speaking NPC again is processed in order", async () => {
    const a = p("n1", "단비", delayed("네", 60));
    const starts: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnStart: (npcId) => starts.push(npcId) },
    );

    const first = rt.handleHumanMessage("지호", "@[단비] 하나");
    // Call it again before the first turn finishes
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(rt.isSpeaking("n1"), true);
    await rt.handleHumanMessage("지호", "@[단비] 둘");
    await first;

    assert.deepEqual(starts, ["n1", "n1"], "두 번째 사람 호출을 버리지 않고 다음 턴으로 처리한다");
  });

  test("if an adapter throws, other NPCs still speak", async () => {
    const a = p("n1", "단비", throwing());
    const b = p("n2", "하늘", always("저는 괜찮아요"));
    const spoke: string[] = [];
    const errors: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a, b], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnEnd: (npcId, _t, meta) => {
          if (!meta?.aborted) spoke.push(npcId);
        },
        onError: (err) => errors.push(String(err)),
      },
    );

    await rt.handleHumanMessage("지호", "@[단비] @[하늘] 어때?");

    assert.deepEqual(spoke, ["n2"], "터진 NPC 만 빠져야 한다");
    assert.equal(errors.length, 1);
  });

  test("mentioning an exhausted NPC only calls onMentionSkipped and doesn't speak", async () => {
    // Stack up failures to MAX_CONSECUTIVE_FAILURES (3) to actually reach the burned-out state —
    // doing it without touching internal fields is what actually locks down "this branch is reachable."
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

    assert.deepEqual(
      skipped,
      [["n1", "backend_failing"]],
      "소진된 NPC 는 사유와 함께 정확히 한 번 알린다",
    );
    assert.equal(starts.length, 3, "소진된 NPC 는 새 턴을 열지 않는다");
  });

  test("onTurnStart carries the caller's socket id — an NPC chain carries the same value", async () => {
    // This value is the client's A* target. If it's null, no client starts walking.
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
      [
        ["n1", "socket-abc"],
        ["n2", "socket-abc"],
      ],
      "사슬을 시작한 사람이 여전히 걸어갈 대상이므로 NPC 가 부른 턴도 같은 소켓 id 를 쓴다",
    );
  });

  test("when the caller changes, the next turn walks to the new caller", async () => {
    const a = p("n1", "단비", always("네"));
    const starts: Array<string | null> = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnStart: (_id, _name, callerSocketId) => starts.push(callerSocketId) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 하나", "socket-a");
    await rt.handleHumanMessage("소라", "@[단비] 둘", "socket-b");

    assert.deepEqual(
      starts,
      ["socket-a", "socket-b"],
      "런타임은 채널당 하나라 호출자를 박아 두면 안 된다",
    );
  });

  test("if onTurnStart throws, that NPC isn't locked out permanently", async () => {
    // io.emit is someone else's code injected by the caller. If throwing once left it in the
    // speaking set, that NPC couldn't speak in this channel until the process died.
    const a = p("n1", "단비", always("네"));
    let boom = true;
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnStart: () => {
          if (boom) {
            boom = false;
            throw new Error("emit failed");
          }
        },
      },
    );

    await assert.rejects(() => rt.handleHumanMessage("지호", "@[단비] 하나", "socket-a"));

    assert.equal(rt.isSpeaking("n1"), false, "실패한 턴 뒤에도 잠금이 풀려 있어야 한다");
  });

  test("with no mention, nobody wakes up", async () => {
    const a = p("n1", "단비", always("네"));
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      { participants: [a], recent: () => [], turnTimeout: TIMEOUT },
      { onTurnEnd: (npcId) => spoke.push(npcId) },
    );

    await rt.handleHumanMessage("지호", "오늘 날씨 좋네");

    assert.deepEqual(spoke, [], "지명 전용이므로 그냥 하는 말에는 반응하지 않는다");
  });

  test("when selectResponders is set, it wakes that result instead of mentions — everyone answers even with no mention", async () => {
    const spoke: string[] = [];
    const rt = new OpenChatRuntime(
      {
        participants: [p("a", "소피", always("a!")), p("b", "올리버", always("b!"))],
        recent: () => [],
        turnTimeout: TIMEOUT,
        selectResponders: (mentioned) => (mentioned.length ? mentioned : ["a", "b"]),
      },
      { onTurnEnd: (id) => spoke.push(id) },
    );
    await rt.handleHumanMessage("단테", "다들 안녕");
    assert.deepEqual(spoke.sort(), ["a", "b"]);
    spoke.length = 0;
    await rt.handleHumanMessage("단테", "@[소피] 너만");
    assert.deepEqual(spoke, ["a"]);
  });

  test("a mention that matches no member calls onMentionNoMatch (M-7)", async () => {
    const spoke: string[] = [];
    const noMatch: (string | null)[] = [];
    const rt = new OpenChatRuntime(
      { participants: [p("n1", "단비", always("네"))], recent: () => [], turnTimeout: TIMEOUT },
      {
        onTurnEnd: (id) => spoke.push(id),
        onMentionNoMatch: (caller) => noMatch.push(caller),
      },
    );

    await rt.handleHumanMessage("지호", "@[없는사람] 안녕", "sock-1");

    assert.deepEqual(spoke, [], "아무도 답하지 않는다");
    assert.deepEqual(noMatch, ["sock-1"], "부른 사람의 소켓 id 를 싣는다");
  });

  test("with no mention, onMentionNoMatch isn't called (M-7)", async () => {
    const noMatch: (string | null)[] = [];
    const rt = new OpenChatRuntime(
      { participants: [p("n1", "단비", always("네"))], recent: () => [], turnTimeout: TIMEOUT },
      { onMentionNoMatch: (caller) => noMatch.push(caller) },
    );

    await rt.handleHumanMessage("지호", "그냥 인사", "sock-1");

    assert.deepEqual(noMatch, [], "지목 표기가 없으면 침묵이 정상이다");
  });

  test("with a valid mention, onMentionNoMatch isn't called (M-7)", async () => {
    const noMatch: (string | null)[] = [];
    const rt = new OpenChatRuntime(
      { participants: [p("n1", "단비", always("네"))], recent: () => [], turnTimeout: TIMEOUT },
      { onMentionNoMatch: (caller) => noMatch.push(caller) },
    );

    await rt.handleHumanMessage("지호", "@[단비] 안녕", "sock-1");

    assert.deepEqual(noMatch, [], "맞는 지명이면 알림이 없다");
  });
});

test("queued human calls retain their own source, caller and prompt; receipt precedes chunks", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  let recent = [{ sender: "A", content: "first" }];
  const adapter = always("answer");
  adapter.execute = async (opts) => {
    prompts.push(opts.prompt);
    if (prompts.length === 1) await gate;
    opts.onDelta?.("answer");
    return { response: "answer", session: { sessionRef: "s" } } as never;
  };
  const accepted: string[] = [];
  const started: (string | null)[] = [];
  const chunks: string[] = [];
  const rt = new OpenChatRuntime(
    { participants: [p("n1", "단비", adapter)], recent: () => recent, turnTimeout: TIMEOUT },
    {
      onTurnQueued: (_id, _name, ctx) => accepted.push(ctx.sourceMessageId),
      onTurnStart: (_id, _name, caller) => started.push(caller),
      onTurnChunk: (_id, chunk) => chunks.push(chunk),
    },
  );
  const first = rt.handleHumanMessage("A", "@[단비] first", "socket-a", "source-a");
  recent = [{ sender: "B", content: "second" }];
  const second = rt.handleHumanMessage("B", "@[단비] second", "socket-b", "source-b");
  assert.deepEqual(accepted, ["source-a", "source-b"]);
  assert.deepEqual(chunks, []);
  await new Promise((r) => setTimeout(r, 0));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["socket-a", "socket-b"]);
  assert.match(prompts[0], /first/);
  assert.doesNotMatch(prompts[0], /second/);
  assert.match(prompts[1], /second/);
});

test("disposing a runtime cancels queued calls and suppresses late answer chunks", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const adapter = always("answer");
  adapter.execute = async (opts) => {
    calls++;
    await gate;
    opts.onDelta?.("late");
    return { response: "late" } as never;
  };
  const chunks: string[] = [];
  const rt = new OpenChatRuntime(
    { participants: [p("n1", "단비", adapter)], recent: () => [], turnTimeout: TIMEOUT },
    { onTurnChunk: (_id, chunk) => chunks.push(chunk) },
  );
  const first = rt.handleHumanMessage("A", "@[단비] first");
  const second = rt.handleHumanMessage("A", "@[단비] second");
  await new Promise((r) => setTimeout(r, 0));
  rt.dispose();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(chunks, []);
});

test("ordinary completion closes the chunk callback before a late adapter delta arrives", async () => {
  let late!: () => void;
  const chunks: string[] = [];
  const adapter = always("answer");
  adapter.execute = async (options) => {
    late = () => options.onDelta?.("late");
    return { response: "answer", session: { sessionRef: options.sessionKey } };
  };
  const runtime = new OpenChatRuntime(
    { participants: [p("n1", "단비", adapter)], recent: () => [], turnTimeout: TIMEOUT },
    { onTurnChunk: (_id, chunk) => chunks.push(chunk) },
  );
  await runtime.handleHumanMessage("Dante", "@[단비] hi");
  late();
  assert.deepEqual(chunks, []);
});

test("a human-called turn's prompt carries [대화 상대] on the second line, but an NPC-chained turn doesn't", async () => {
  const prompts = new Map<string, string[]>();
  const capturing = (npcId: string, reply: string): NpcAdapter =>
    ({
      type: "mock",
      async execute(o: AdapterExecuteOptions) {
        prompts.set(npcId, [...(prompts.get(npcId) ?? []), o.prompt]);
        return { response: reply, session: { sessionRef: o.sessionKey } };
      },
      async testConnection() {
        return { status: "ok" as const };
      },
    }) as NpcAdapter;
  const rt = new OpenChatRuntime(
    {
      participants: [
        p("n1", "단비", capturing("n1", "@[하늘] 부탁해요")),
        p("n2", "하늘", capturing("n2", "네")),
      ],
      recent: () => [],
      turnTimeout: TIMEOUT,
    },
    {},
  );

  await rt.handleHumanMessage("곽지호", "@[단비] 안녕", "socket-1", "source-1", {
    name: "곽지호",
    bio: "단테랩스 대표",
  });

  const human = prompts.get("n1")?.[0] ?? "";
  assert.equal(
    human.split("\n")[1],
    "[대화 상대] 이름: 곽지호 · 소개: 단테랩스 대표",
    human.slice(0, 200),
  );
  const chained = prompts.get("n2")?.[0] ?? "";
  assert.ok(chained, "단비의 지목으로 하늘이 불렸다");
  assert.ok(!chained.includes("[대화 상대]"), chained.slice(0, 200));
});

test("the caller's locale picks the script language for the called NPC and the NPCs it chains to", async () => {
  const prompts = new Map<string, string[]>();
  const capturing = (npcId: string, reply: string): NpcAdapter =>
    ({
      type: "mock",
      async execute(o: AdapterExecuteOptions) {
        prompts.set(npcId, [...(prompts.get(npcId) ?? []), o.prompt]);
        return { response: reply, session: { sessionRef: o.sessionKey } };
      },
      async testConnection() {
        return { status: "ok" as const };
      },
    }) as NpcAdapter;
  const rt = new OpenChatRuntime(
    {
      participants: [
        { ...p("n1", "Danbi", capturing("n1", "@[Haneul] please")), role: "" },
        { ...p("n2", "Haneul", capturing("n2", "sure")), role: "" },
      ],
      recent: () => [],
      turnTimeout: TIMEOUT,
    },
    {},
  );

  await rt.handleHumanMessage("Dante", "@[Danbi] hi", "socket-1", "source-1", null, "ja");

  const human = prompts.get("n1")?.[0] ?? "";
  const chained = prompts.get("n2")?.[0] ?? "";
  assert.ok(chained, "Danbi's mention called Haneul");
  for (const prompt of [human, chained]) {
    assert.doesNotMatch(prompt, /[가-힣]/, prompt.slice(0, 300));
    assert.ok(prompt.includes("[Recent conversation]"));
  }
  // An empty role falls back to the localized "colleague" label.
  assert.ok(human.includes("- Haneul(Colleague)"), human);
});

test("a cookie-less caller (null locale) gets the English script; an omitted locale keeps Korean", async () => {
  const prompts: string[] = [];
  const adapter = {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      prompts.push(o.prompt);
      return { response: "ok", session: { sessionRef: o.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
  const rt = new OpenChatRuntime(
    { participants: [p("n1", "단비", adapter)], recent: () => [], turnTimeout: TIMEOUT },
    {},
  );

  await rt.handleHumanMessage("Dante", "@[단비] hi", null, "s-1", null, null);
  await rt.handleHumanMessage("Dante", "@[단비] hi", null, "s-2", null);

  assert.ok(prompts[0].startsWith("You are 단비."), prompts[0]);
  assert.ok(prompts[1].startsWith("당신은 단비 입니다."), prompts[1]);
});
