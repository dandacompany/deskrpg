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
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "secret-key", fetchImpl: fetchImpl as typeof fetch });
    await c.getCapabilities();
    assert.equal(seen?.get("Authorization"), "Bearer secret-key");
  });

  test("maps 401 to unauthorized", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 });
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unauthorized");
      assert.equal(err.status, 401);
      return true;
    });
  });

  test("maps 404 to unknown_profile", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "Unknown or unconfigured profile" }), { status: 404 });
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "ghost", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unknown_profile");
      return true;
    });
  });

  test("maps a network throw to unreachable", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.getCapabilities(), (err: HermesError) => {
      assert.equal(err.code, "unreachable");
      return true;
    });
  });
});

describe("HermesClient.streamSessionChat", () => {
  test("accumulates deltas and returns the final text with run_id", async () => {
    const fetchImpl = async () => sseResponse([
      'event: run.started\ndata: {"run_id":"run-1","seq":1}\n\n',
      'event: assistant.delta\ndata: {"delta":"안녕","run_id":"run-1","seq":2}\n\n',
      'event: assistant.delta\ndata: {"delta":"하세요","run_id":"run-1","seq":3}\n\n',
      'event: assistant.completed\ndata: {"content":"안녕하세요","session_id":"sess-9","run_id":"run-1","seq":4}\n\n',
      'event: run.completed\ndata: {"run_id":"run-1","seq":5}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });

    const names: string[] = [];
    const result = await c.streamSessionChat({
      sessionId: "sess-9",
      message: "안녕",
      onEvent: (e) => names.push(e.event),
    });

    assert.equal(result.text, "안녕하세요");
    assert.equal(result.runId, "run-1");
    assert.equal(result.sessionId, "sess-9");
    assert.deepEqual(names, ["run.started", "assistant.delta", "assistant.delta", "assistant.completed", "run.completed"]);
  });

  test("prefers assistant.completed content over accumulated deltas", async () => {
    const fetchImpl = async () => sseResponse([
      'event: assistant.delta\ndata: {"delta":"부분"}\n\n',
      'event: assistant.completed\ndata: {"content":"완성본"}\n\n',
      'event: done\ndata: {}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "완성본");
  });

  test("returns accumulated deltas when the stream ends without a completed event", async () => {
    const fetchImpl = async () => sseResponse([
      'event: assistant.delta\ndata: {"delta":"끊긴 "}\n\n',
      'event: assistant.delta\ndata: {"delta":"응답"}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} });
    assert.equal(result.text, "끊긴 응답");
  });

  test("rejects on run.failed", async () => {
    const fetchImpl = async () => sseResponse([
      'event: run.failed\ndata: {"message":"provider exploded"}\n\n',
    ]);
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    await assert.rejects(() => c.streamSessionChat({ sessionId: "s", message: "m", onEvent: () => {} }), /provider exploded/);
  });

  test("sends the long-term memory scope header when a session key is given", async () => {
    let seen: Headers | undefined;
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return sseResponse(['event: done\ndata: {}\n\n']);
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.streamSessionChat({ sessionId: "s", message: "m", sessionKey: "npc-42", onEvent: () => {} });
    assert.equal(seen?.get("X-Hermes-Session-Key"), "npc-42");
  });

  test("stops reading the outer loop once a terminal event arrives (does not hang on a held-open connection)", async () => {
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
        controller.enqueue(enc.encode(
          'event: assistant.delta\ndata: {"delta":"부분"}\n\n' +
          'event: run.completed\ndata: {"run_id":"run-1"}\n\n',
        ));
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
    const response = new Response(new ReadableStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    Object.defineProperty(response, "body", { value: { getReader: () => wrappedReader } });
    const fetchImpl = async () => response;

    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: null, token: "t", fetchImpl: fetchImpl as typeof fetch });
    const names: string[] = [];
    const result = await c.streamSessionChat({ sessionId: "s", message: "m", onEvent: (e) => names.push(e.event) });

    assert.equal(result.runId, "run-1");
    assert.deepEqual(names, ["assistant.delta", "run.completed"]);
    assert.equal(readCallCount, 1, "the outer read loop must not call read() again after the terminal event");
    assert.equal(cancelled, true, "the stream reader must be cancelled after the terminal event");
    void controllerRef;
  });
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
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "danvi", token: "t", fetchImpl: fetchImpl as typeof fetch });

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
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.stopRun("run-3");
    assert.equal(calledUrl, "http://gw:8642/p/sophie/v1/runs/run-3/stop");
  });

  test("steerRun sends the guidance text", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    };
    const c = new HermesClient({ baseUrl: "http://gw:8642", profileName: "sophie", token: "t", fetchImpl: fetchImpl as typeof fetch });
    await c.steerRun("run-3", "짧게 답하세요");
    assert.equal(body.text, "짧게 답하세요");
  });
});
