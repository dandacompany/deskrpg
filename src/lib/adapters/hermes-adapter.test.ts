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

  test("forwards approval.request from the 1:1 stream without the always choice", async () => {
    const client = clientWith(() =>
      sseResponse([
        'event: approval.request\ndata: {"run_id":"r1","request_id":"q1","command":"rm -r /tmp/x","pattern_key":"recursive delete","choices":["once","session","always","deny"]}\n\n',
        'event: assistant.completed\ndata: {"content":"done","session_id":"sess-1","run_id":"r1"}\n\n',
      ]),
    );
    const seen: unknown[] = [];
    await new HermesAdapter(client, { sessionId: "sess-1" }).execute({
      sessionKey: "npc-1-dm-user-9",
      prompt: "x",
      onApprovalRequest: (e) => seen.push(e),
    });
    assert.deepEqual(seen, [
      {
        runId: "r1",
        requestId: "q1",
        command: "rm -r /tmp/x",
        description: "",
        kind: "command",
        patternKey: "recursive delete",
        choices: ["once", "session", "deny"],
      },
    ]);
  });

  test("resolveRunApproval posts the choice to the profile-scoped run", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = clientWith((url, init) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(JSON.stringify({ resolved: 1 }), { status: 200 });
    });
    assert.deepEqual(await client.resolveRunApproval("r1", { choice: "once", request_id: "q1" }), {
      resolved: 1,
    });
    assert.ok(calls[0].url.endsWith("/p/sophie/v1/runs/r1/approval"), calls[0].url);
    assert.deepEqual(JSON.parse(calls[0].body), { choice: "once", request_id: "q1" });
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
    // A poll call and a meeting's first turn look exactly like this — if the branch were
    // decided by history length, both would silently leak into a persistent session (H2).
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

  test("real tool use comes through as tool.started/completed", async () => {
    // Measured live (2026-08-28, 3 tool uses): started 3, completed 3, progress was
    // `_thinking` once. Looking only at tool.progress shows almost none of the real tool use.
    const client = clientWith(() =>
      sseResponse([
        'event: tool.started\ndata: {"tool_name":"web_search","preview":"쿼리 문자열"}\n\n',
        'event: tool.completed\ndata: {"tool_name":"web_search","preview":null}\n\n',
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
    // Only the name is passed. It's not cleared by completed — if started and completed get
    // batched together, the intermediate state never renders and nothing shows up on screen.
    assert.deepEqual(progress, [["web_search", ""]]);
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

describe("ConversationEngine × HermesAdapter — transport path", () => {
  test(
    "both the first poll and the first speaking turn take the runs path (a persistent session is never used)",
    { timeout: 5000 },
    async () => {
      // The inverse of the review's repro (final-review.md:109-116). The call log used to be
      // createSession → streamSessionChat(poll) → streamSessionChat(first speech) →
      // startRun(second speech) — the poll exchange piled up in the NPC's long-lived session,
      // and the transport path differed between turn 1 and turn 2.
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

// A live-measured regression — Hermes v0.20.2's `_thinking` tool sends the entire finished
// answer once more in tool.progress's delta. The sequence below is copied straight from a
// real gateway response ("print only 사과딸기" → 4 deltas + a full tool.progress echo +
// completed).
// If these two channels get merged when writing to the screen, the user sees the answer
// exactly twice.
describe("HermesAdapter — tool.progress is not the answer body", () => {
  const THINKING_ECHO = [
    'event: assistant.delta\ndata: {"delta":"사"}\n\n',
    'event: assistant.delta\ndata: {"delta":"과"}\n\n',
    'event: assistant.delta\ndata: {"delta":"딸"}\n\n',
    'event: assistant.delta\ndata: {"delta":"기"}\n\n',
    'event: tool.progress\ndata: {"tool_name":"_thinking","delta":"사과딸기"}\n\n',
    'event: assistant.completed\ndata: {"content":"사과딸기"}\n\n',
  ];

  test("the text streamed via onDelta matches the final response — not doubled", async () => {
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

  test("_thinking's full echo only goes out via onToolProgress", async () => {
    const client = clientWith(() => sseResponse(THINKING_ECHO));
    const adapter = new HermesAdapter(client, { sessionId: "s" });

    const progress: Array<[string, string]> = [];
    await adapter.execute({
      sessionKey: "k",
      prompt: "p",
      onToolProgress: (name, preview) => progress.push([name, preview]),
    });

    // Despite the name "preview", the content isn't a preview at all — it's the entire
    // finished answer. So it's never passed through — removing any chance a consumer could
    // mistake it for the actual body.
    assert.deepEqual(progress, [["_thinking", ""]]);
    assert.ok(!progress.some(([, preview]) => preview.includes("사과딸기")));
  });
});

describe("HermesAdapter — delta event name on the meeting path", () => {
  test("message.delta also flows through onDelta", async () => {
    // Measured live (v0.20.2): /v1/runs/<id>/events uses message.delta, not
    // assistant.delta. Because only assistant.* was being watched, onDelta was never called
    // even once in meetings — the response arrived via execute()'s return value so the NPC
    // did speak, but the client's stream buffer was empty, leaving no bubble to finalize on
    // done:true, so nothing appeared on screen.
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
