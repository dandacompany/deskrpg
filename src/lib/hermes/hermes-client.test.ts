import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HermesClient, HermesError } from "./hermes-client";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("HermesClient.url", () => {
  test("prefixes named profiles", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t" });
    assert.equal(c.url("/v1/runs"), "http://gw:8642/p/sophie/v1/runs");
  });

  test("omits the prefix for the default profile", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t" });
    assert.equal(c.url("/v1/runs"), "http://gw:8642/v1/runs");
  });

  test("strips a trailing slash from baseUrl", () => {
    const c = new HermesClient({ baseUrl: "http://gw:8642/", profileName: "danvi", token: "t" });
    assert.equal(c.url("/health"), "http://gw:8642/p/danvi/health");
  });
});

describe("HermesClient auth and errors", () => {
  test("sends the profile token as a bearer header", async () => {
    let seen: Headers | undefined;
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ features: {}, endpoints: {} }), { status: 200 });
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await c.getCapabilities();
    assert.equal(seen?.get("Authorization"), "Bearer secret-key");
  });

  test("maps 401 to unauthorized", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await assert.rejects(
      () => c.getCapabilities(),
      (err: HermesError) => {
        assert.equal(err.code, "unauthorized");
        assert.equal(err.status, 401);
        return true;
      },
    );
  });

  test("maps 404 to unknown_profile", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "Unknown or unconfigured profile" }), { status: 404 });
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "ghost",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await assert.rejects(
      () => c.getCapabilities(),
      (err: HermesError) => {
        assert.equal(err.code, "unknown_profile");
        return true;
      },
    );
  });

  test("maps a network throw to unreachable", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: null,
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await assert.rejects(
      () => c.getCapabilities(),
      (err: HermesError) => {
        assert.equal(err.code, "unreachable");
        return true;
      },
    );
  });
});

describe("HermesClient.streamSessionChat", () => {
  test("accumulates deltas and returns the final text with run_id", async () => {
    const fetchImpl = async () =>
      sseResponse([
        'event: run.started\ndata: {"run_id":"run-1","seq":1}\n\n',
        'event: assistant.delta\ndata: {"delta":"안녕","run_id":"run-1","seq":2}\n\n',
        'event: assistant.delta\ndata: {"delta":"하세요","run_id":"run-1","seq":3}\n\n',
        'event: assistant.completed\ndata: {"content":"안녕하세요","session_id":"sess-9","run_id":"run-1","seq":4}\n\n',
        'event: run.completed\ndata: {"run_id":"run-1","seq":5}\n\n',
      ]);
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const names: string[] = [];
    const result = await c.streamSessionChat({
      sessionId: "sess-9",
      message: "안녕",
      onEvent: (e) => names.push(e.event),
    });

    assert.equal(result.text, "안녕하세요");
    assert.equal(result.runId, "run-1");
    assert.equal(result.sessionId, "sess-9");
    assert.deepEqual(names, [
      "run.started",
      "assistant.delta",
      "assistant.delta",
      "assistant.completed",
      "run.completed",
    ]);
  });

  test("prefers assistant.completed content over accumulated deltas", async () => {
    const fetchImpl = async () =>
      sseResponse([
        'event: assistant.delta\ndata: {"delta":"부분"}\n\n',
        'event: assistant.completed\ndata: {"content":"완성본"}\n\n',
        "event: done\ndata: {}\n\n",
      ]);
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: null,
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "완성본");
  });

  test("returns accumulated deltas when the stream ends without a completed event", async () => {
    const fetchImpl = async () =>
      sseResponse([
        'event: assistant.delta\ndata: {"delta":"끊긴 "}\n\n',
        'event: assistant.delta\ndata: {"delta":"응답"}\n\n',
      ]);
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: null,
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "끊긴 응답");
  });

  test("rejects on run.failed", async () => {
    const fetchImpl = async () =>
      sseResponse(['event: run.failed\ndata: {"message":"provider exploded"}\n\n']);
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: null,
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await assert.rejects(
      () => c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} }),
      (err: unknown) => {
        assert.match((err as Error).message, /provider exploded/);
        assert.equal((err as { code?: string }).code, "run_failed");
        return true;
      },
    );
  });

  test("sends the long-term memory scope header when a session key is given", async () => {
    let seen: Headers | undefined;
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return sseResponse(["event: done\ndata: {}\n\n"]);
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await c.streamSessionChat({
      sessionId: "s",
      message: "m",
      sessionKey: "npc-42",
      onEvent: () => {},
    });
    assert.equal(seen?.get("X-Hermes-Session-Key"), "npc-42");
  });

  test(
    "stops reading the outer loop once a terminal event arrives (does not hang on a held-open connection)",
    { timeout: 5000 },
    async () => {
      // A real Hermes server can keep the HTTP connection open past a terminal
      // event (run.completed/done/etc). Simulate that: one chunk carries a
      // non-terminal event followed by the terminal event, and the underlying
      // stream is never closed and never enqueues anything further. If
      // HermesClient's outer `reader.read()` loop is still running after the
      // terminal event (i.e. only the inner `for...of` was broken), it would
      // call read() again here and hang forever, since nothing more ever
      // arrives and the stream never completes.
      const enc = new TextEncoder();
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue(
            enc.encode(
              'event: assistant.delta\ndata: {"delta":"부분"}\n\n' +
                'event: run.completed\ndata: {"run_id":"run-1"}\n\n',
            ),
          );
          // Deliberately never closed — mimics a server holding the connection open.
        },
      });
      const realReader = stream.getReader();
      let readCallCount = 0;
      let cancelled = false;
      const wrappedReader = {
        read: () => {
          readCallCount += 1;
          return realReader.read();
        },
        cancel: (reason?: unknown) => {
          cancelled = true;
          return realReader.cancel(reason);
        },
      };
      const response = new Response(new ReadableStream(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      Object.defineProperty(response, "body", { value: { getReader: () => wrappedReader } });
      const fetchImpl = async () => response;

      const c = new HermesClient({
        baseUrl: "http://gw:8642",
        profileName: null,
        token: "t",
        fetchImpl: fetchImpl as typeof fetch,
      });
      const names: string[] = [];
      const result = await c.streamSessionChat({
        sessionId: "s",
        message: "m",
        onEvent: (e) => names.push(e.event),
      });

      assert.equal(result.runId, "run-1");
      assert.deepEqual(names, ["assistant.delta", "run.completed"]);
      assert.equal(
        readCallCount,
        1,
        "the outer read loop must not call read() again after the terminal event",
      );
      assert.equal(cancelled, true, "the stream reader must be cancelled after the terminal event");
      void controllerRef;
    },
  );
});

describe("HermesClient.startRun", () => {
  test("posts input plus conversation history and returns run_id", async () => {
    let body: Record<string, unknown> = {};
    let calledUrl = "";
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ run_id: "run-7" }), { status: 202 });
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await c.startRun({
      input: "의견 주세요",
      conversationHistory: [{ role: "user", content: "주제: 배포" }],
    });

    assert.equal(result.runId, "run-7");
    assert.equal(calledUrl, "http://gw:8642/p/danvi/v1/runs");
    assert.equal(body.input, "의견 주세요");
    assert.deepEqual(body.conversation_history, [{ role: "user", content: "주제: 배포" }]);
  });
});

describe("HermesClient.stopRun / steerRun", () => {
  test("stopRun posts to the run stop endpoint", async () => {
    let calledUrl = "";
    const fetchImpl = async (u: string | URL | Request) => {
      calledUrl = String(u);
      return new Response("{}", { status: 200 });
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await c.stopRun("run-3");
    assert.equal(calledUrl, "http://gw:8642/p/sophie/v1/runs/run-3/stop");
  });

  test("steerRun sends the guidance text", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      token: "t",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await c.steerRun("run-3", "짧게 답하세요");
    assert.equal(body.text, "짧게 답하세요");
  });
});

describe("HermesClient.createSession", () => {
  function clientReturning(payload: unknown) {
    return new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    });
  }

  test("reads the id out of the nested session object", async () => {
    // 실측한 v0.20.2 응답 형태. 이걸 못 읽어서 1:1 대화가 통째로 죽었다 —
    // 화면에는 "AI 게이트웨이 오류" 만 뜨고 원인은 서버 로그에만 남았다.
    const c = clientReturning({
      object: "hermes.session",
      session: { id: "api_1787291339_b79d5388", source: "api_server", message_count: 0 },
    });
    assert.deepEqual(await c.createSession("t"), { sessionId: "api_1787291339_b79d5388" });
  });

  test("still accepts the flat shapes", async () => {
    assert.deepEqual(await clientReturning({ session_id: "s1" }).createSession("t"), {
      sessionId: "s1",
    });
    assert.deepEqual(await clientReturning({ id: "s2" }).createSession("t"), { sessionId: "s2" });
  });

  test("throws when no shape carries an id", async () => {
    await assert.rejects(
      () => clientReturning({ object: "hermes.session", session: {} }).createSession("t"),
      (err: unknown) => err instanceof HermesError && err.code === "http_error",
    );
  });
});

describe("HermesClient.createSession — 제목 충돌", () => {
  test("제목이 이미 쓰이면 그 세션을 이어 쓴다", async () => {
    // Hermes 는 제목 유일성을 강제한다. 우리 제목은 NPC×사용자 컨텍스트 키이므로
    // 충돌은 "그 대화가 이미 있다"는 뜻이다 — 실패가 아니라 재사용해야 한다.
    const calls: string[] = [];
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              error: { code: "invalid_title", message: "Title already in use by session api_old" },
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ object: "list", data: [{ id: "api_old", title: "npc-1:user-1" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await c.createSession("npc-1:user-1"), { sessionId: "api_old" });
    assert.equal(calls.length, 2, "POST 로 만들어 보고, 충돌하면 GET 으로 찾는다");
  });

  test("충돌인데 그 제목이 목록에 없으면 원래 오류를 던진다", async () => {
    const c = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(JSON.stringify({ error: { code: "invalid_title" } }), { status: 400 })
          : new Response(JSON.stringify({ object: "list", data: [] }), {
              status: 200,
            })) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => c.createSession("없는제목"),
      (e: unknown) => e instanceof HermesError,
    );
  });
});

// 실측 회귀 — 회의 폴링 한 건의 SSE 를 그대로 옮긴 것이다(Hermes v0.20.2).
// NPC 는 "SPEAK: …" 라고 또박또박 답했는데 우리는 빈 문자열을 받아 전원 PASS 로 집계했다.
describe("HermesClient.streamRunEvents — /v1/runs 방언", () => {
  test("message.delta 를 누적한다 — 회의 폴링 응답이 빈 문자열이면 전원 PASS 가 된다", async () => {
    const frames = [
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "SPE"}\n\n',
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "AK: "}\n\n',
      'data: {"event": "message.delta", "run_id": "run_1", "delta": "김치찌개"}\n\n',
      'data: {"event": "reasoning.available", "run_id": "run_1"}\n\n',
      'data: {"event": "run.completed", "run_id": "run_1"}\n\n',
    ];
    const client = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const f of frames) c.enqueue(new TextEncoder().encode(f));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        )) as unknown as typeof fetch,
    });

    const { text } = await client.streamRunEvents("run_1", () => {});
    assert.equal(text, "SPEAK: 김치찌개");
  });
});

describe("drain — 종료 이벤트 뒤 취소가 끝나지 않는 스트림", () => {
  /**
   * 실측(v0.20.2): 회의 경로 /v1/runs/<id>/events 는 run.completed 를 보낸 뒤에도 연결을
   * 열어 둔다. 그 상태에서 reader.cancel() 을 await 하면 resolve 도 reject 도 하지 않고
   * 영영 멈춘다. 회의는 폴링 응답을 Promise.allSettled 로 모으므로 참가자 하나가 거기
   * 걸리면 회의 전체가 첫 턴도 못 내고 멈춘다 — 실제로 그렇게 멈춰 있었다.
   *
   * cancel() 이 절대 settle 하지 않는 본문을 만들어 그 상황을 고정한다.
   */
  function neverCancellingSse(frames: string[]): Response {
    const enc = new TextEncoder();
    let i = 0;
    const body = {
      getReader() {
        return {
          read: async () =>
            i < frames.length
              ? { done: false, value: enc.encode(frames[i++]) }
              : { done: true, value: undefined },
          // 영영 settle 하지 않는다 — await 하면 그 자리에서 멈춘다.
          cancel: () => new Promise<void>(() => {}),
        };
      },
    };
    return { ok: true, status: 200, body } as unknown as Response;
  }

  test("취소를 기다리지 않고 누적한 텍스트를 돌려준다", async () => {
    const client = new HermesClient({
      baseUrl: "http://gw:8642",
      profileName: "danvi",
      token: "t",
      fetchImpl: (async () =>
        neverCancellingSse([
          'data: {"event":"message.delta","delta":"사"}\n\n',
          'data: {"event":"message.delta","delta":"과"}\n\n',
          'data: {"event":"run.completed","output":"사과"}\n\n',
        ])) as unknown as typeof fetch,
    });

    const result = await Promise.race([
      client.streamRunEvents("run_1", () => {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("drain 이 취소를 기다리다 멈췄습니다")), 3000),
      ),
    ]);

    assert.equal(result.text, "사과");
  });
});
