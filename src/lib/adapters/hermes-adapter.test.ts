// src/lib/adapters/hermes-adapter.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HermesAdapter } from "./hermes-adapter";
import { HermesClient } from "@/lib/hermes/hermes-client";
import { ConversationEngine } from "@/lib/conversation/conversation-engine";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function clientWith(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit) =>
    handler(String(u), init);
  return new HermesClient({
    baseUrl: "http://gw:8642",
    profileName: "sophie",
    token: "t",
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe("HermesAdapter", () => {
  test("type is 'hermes'", () => {
    assert.equal(new HermesAdapter(clientWith(() => new Response("{}"))).type, "hermes");
  });

  test("uses the session chat path for 1:1 conversation", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      return sseResponse([
        'event: assistant.delta\ndata: {"delta":"반갑","run_id":"r1"}\n\n',
        'event: assistant.completed\ndata: {"content":"반갑습니다","session_id":"sess-1","run_id":"r1"}\n\n',
      ]);
    });

    const adapter = new HermesAdapter(client, { sessionId: "sess-1" });
    const chunks: string[] = [];
    const result = await adapter.execute({
      sessionKey: "npc-1-dm-user-9",
      prompt: "안녕",
      onDelta: (c) => chunks.push(c),
    });

    assert.equal(result.response, "반갑습니다");
    assert.equal(result.session.sessionRef, "sess-1");
    assert.deepEqual(chunks, ["반갑"]);
    assert.ok(urls[0].includes("/p/sophie/api/sessions/sess-1/chat/stream"), urls[0]);
  });

  test("uses the runs path when the caller declares a multi-party turn", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs"))
        return new Response(JSON.stringify({ run_id: "r9" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"제 의견은"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const result = await adapter.execute({
      sessionKey: "meeting-1",
      prompt: "발언하세요",
      multiParty: true,
      conversationHistory: [{ role: "user", content: "주제: 배포 전략" }],
    });

    assert.equal(result.response, "제 의견은");
    assert.ok(urls[0].endsWith("/p/sophie/v1/runs"), urls[0]);
    assert.ok(urls[1].includes("/v1/runs/r9/events"), urls[1]);
  });

  test("takes the runs path on a multi-party turn even when the history is empty", async () => {
    // 폴 호출과 회의의 첫 턴이 정확히 이 모양이다 — 히스토리 길이로 갈래를 정하면
    // 둘 다 조용히 영속 세션으로 새어 들어간다(H2).
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs"))
        return new Response(JSON.stringify({ run_id: "r7" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"PASS"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    await adapter.execute({
      sessionKey: "meeting-1-poll",
      prompt: "SPEAK 또는 PASS",
      multiParty: true,
    });

    assert.ok(urls[0].endsWith("/p/sophie/v1/runs"), urls.join("\n"));
    assert.equal(
      urls.some((u) => u.includes("/api/sessions")),
      false,
      "다자 대화 턴은 영속 세션을 만들지도, 쓰지도 않아야 한다",
    );
  });

  test("reports the run handle so callers can abort", async () => {
    const client = clientWith((url) => {
      if (url.endsWith("/v1/runs"))
        return new Response(JSON.stringify({ run_id: "r5" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"ok"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const seen: string[] = [];
    await adapter.execute({
      sessionKey: "m",
      prompt: "p",
      multiParty: true,
      conversationHistory: [{ role: "user", content: "c" }],
      onRunStarted: (id) => seen.push(id),
    });
    assert.deepEqual(seen, ["r5"]);
  });

  test("forwards tool progress to the caller", async () => {
    const client = clientWith(() =>
      sseResponse([
        'event: tool.progress\ndata: {"tool_name":"read_file","delta":"src/app.ts"}\n\n',
        'event: assistant.completed\ndata: {"content":"완료"}\n\n',
      ]),
    );

    const adapter = new HermesAdapter(client, { sessionId: "s" });
    const progress: Array<[string, string]> = [];
    await adapter.execute({
      sessionKey: "k",
      prompt: "p",
      onToolProgress: (name, preview) => progress.push([name, preview]),
    });
    assert.deepEqual(progress, [["read_file", "src/app.ts"]]);
  });

  test("abort stops the last run", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs"))
        return new Response(JSON.stringify({ run_id: "r2" }), { status: 202 });
      if (url.includes("/stop")) return new Response("{}", { status: 200 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"x"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    await adapter.execute({
      sessionKey: "k",
      prompt: "p",
      multiParty: true,
      conversationHistory: [{ role: "user", content: "c" }],
    });
    await adapter.abort("k");
    assert.ok(
      urls.some((u) => u.endsWith("/v1/runs/r2/stop")),
      urls.join("\n"),
    );
  });

  test("abort is a no-op when no run is in flight", async () => {
    const adapter = new HermesAdapter(clientWith(() => new Response("{}")));
    await adapter.abort("k"); // must not throw
  });

  test("testConnection reports ok when capabilities are readable", async () => {
    const client = clientWith(
      () =>
        new Response(
          JSON.stringify({ features: { run_steer: true }, endpoints: {}, version: "0.20.2" }),
          { status: 200 },
        ),
    );
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "ok");
  });

  test("testConnection reports error on 401", async () => {
    const client = clientWith(() => new Response("{}", { status: 401 }));
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "error");
  });
});

describe("ConversationEngine × HermesAdapter — 전송 경로", () => {
  test(
    "첫 폴과 첫 발언 턴이 모두 runs 경로를 탄다(영속 세션은 한 번도 쓰지 않는다)",
    { timeout: 5000 },
    async () => {
      // 리뷰의 재현(final-review.md:109-116)을 뒤집은 형태다. 예전에는 호출 로그가
      // createSession → streamSessionChat(poll) → streamSessionChat(첫 발언) → startRun(둘째 발언)
      // 이었다 — 폴 문답이 NPC의 장기 세션에 쌓이고, 1턴과 2턴의 전송 경로가 달랐다.
      const log: string[] = [];
      let runSeq = 0;
      const replies = ["SPEAK: 하겠습니다", "제 의견은 이렇습니다"];
      const client = clientWith((url) => {
        if (url.endsWith("/v1/runs")) {
          log.push("startRun");
          return new Response(JSON.stringify({ run_id: `r${++runSeq}` }), { status: 202 });
        }
        if (url.includes("/v1/runs/")) {
          const text = replies[Math.min(runSeq - 1, replies.length - 1)];
          return sseResponse([
            `event: assistant.completed\ndata: ${JSON.stringify({ content: text })}\n\n`,
          ]);
        }
        log.push(`session:${url}`);
        return sseResponse([
          'event: assistant.completed\ndata: {"content":"PASS","session_id":"sess-1"}\n\n',
        ]);
      });

      const adapter = new HermesAdapter(client);
      const engine = new ConversationEngine(
        {
          mode: "meeting",
          topic: "T",
          participants: [
            {
              npcId: "a",
              displayName: "에이",
              seated: true,
              turnCount: 0,
              lastSpokeAt: 0,
              adapter,
              sessionKey: "sk-a",
            },
          ],
          quota: { maxConsecutivePasses: 2, cooldownMs: 0, maxTotalTurns: 1, maxTurnsPerAgent: 20 },
        },
        {},
      );
      await engine.run();

      assert.deepEqual(
        log,
        ["startRun", "startRun"],
        `첫 폴과 첫 발언 모두 startRun이어야 한다: ${JSON.stringify(log)}`,
      );
    },
  );
});

// 실측 회귀 — Hermes v0.20.2 의 `_thinking` 툴은 완성된 답변 전체를 tool.progress 의
// delta 에 한 번 더 실어 보낸다. 아래 시퀀스는 실제 게이트웨이 응답을 그대로 옮긴 것이다
// ("사과딸기만 출력해" → delta 4개 + tool.progress 통짜 + completed).
// 이 두 통로를 합쳐서 화면에 쓰면 사용자에게 답이 정확히 두 번 보인다.
describe("HermesAdapter — tool.progress 는 답변 본문이 아니다", () => {
  const THINKING_ECHO = [
    'event: assistant.delta\ndata: {"delta":"사"}\n\n',
    'event: assistant.delta\ndata: {"delta":"과"}\n\n',
    'event: assistant.delta\ndata: {"delta":"딸"}\n\n',
    'event: assistant.delta\ndata: {"delta":"기"}\n\n',
    'event: tool.progress\ndata: {"tool_name":"_thinking","delta":"사과딸기"}\n\n',
    'event: assistant.completed\ndata: {"content":"사과딸기"}\n\n',
  ];

  test("onDelta 로 흐르는 텍스트는 최종 응답과 같다 — 두 배가 아니다", async () => {
    const client = clientWith(() => sseResponse(THINKING_ECHO));
    const adapter = new HermesAdapter(client, { sessionId: "s" });

    let streamed = "";
    const { response } = await adapter.execute({
      sessionKey: "k",
      prompt: "p",
      onDelta: (chunk) => {
        streamed += chunk;
      },
      onToolProgress: () => {},
    });

    assert.equal(response, "사과딸기");
    assert.equal(
      streamed,
      "사과딸기",
      "본문 스트림에 tool.progress 가 섞였다 — 화면에 두 번 보인다",
    );
  });

  test("_thinking 의 통짜 에코는 onToolProgress 로만 나간다", async () => {
    const client = clientWith(() => sseResponse(THINKING_ECHO));
    const adapter = new HermesAdapter(client, { sessionId: "s" });

    const progress: Array<[string, string]> = [];
    await adapter.execute({
      sessionKey: "k",
      prompt: "p",
      onToolProgress: (name, preview) => progress.push([name, preview]),
    });

    // preview 라는 이름과 달리 내용은 "미리보기"가 아니라 완성된 답변 전체다.
    // 소비자가 이걸 본문으로 착각하지 않도록 이 사실 자체를 고정해 둔다.
    assert.deepEqual(progress, [["_thinking", "사과딸기"]]);
  });
});

describe("HermesAdapter — 회의 경로의 델타 이벤트 이름", () => {
  test("message.delta 도 onDelta 로 흘린다", async () => {
    // 실측(v0.20.2): /v1/runs/<id>/events 는 assistant.delta 가 아니라 message.delta 를
    // 쓴다. assistant.* 만 보던 탓에 회의에서는 onDelta 가 한 번도 불리지 않았다 —
    // 응답은 execute() 반환값으로 왔으므로 NPC 는 발언했지만, 클라이언트의 스트림 버퍼가
    // 비어 done:true 에 확정할 말풍선이 없었고 화면에는 아무것도 붙지 않았다.
    const client = clientWith((url) => {
      if (url.endsWith("/v1/runs"))
        return new Response(JSON.stringify({ run_id: "r9" }), { status: 202 });
      return sseResponse([
        'data: {"event":"message.delta","delta":"김치"}\n\n',
        'data: {"event":"message.delta","delta":"찌개"}\n\n',
        'data: {"event":"run.completed","output":"김치찌개"}\n\n',
      ]);
    });

    const adapter = new HermesAdapter(client);
    const streamed: string[] = [];
    const { response } = await adapter.execute({
      sessionKey: "m",
      prompt: "p",
      multiParty: true,
      conversationHistory: [],
      onDelta: (c) => streamed.push(c),
    });

    assert.deepEqual(streamed, ["김치", "찌개"], "회의 델타가 onDelta 로 흘러야 화면에 붙는다");
    assert.equal(response, "김치찌개");
  });
});
