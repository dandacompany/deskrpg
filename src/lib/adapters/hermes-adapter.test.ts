// src/lib/adapters/hermes-adapter.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HermesAdapter } from "./hermes-adapter";
import { HermesClient } from "@/lib/hermes/hermes-client";

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
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => handler(String(u), init);
  return new HermesClient({
    baseUrl: "http://gw:8642", profileName: "sophie", token: "t",
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

  test("uses the runs path when conversation history is supplied", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r9" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"제 의견은"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const result = await adapter.execute({
      sessionKey: "meeting-1",
      prompt: "발언하세요",
      conversationHistory: [{ role: "user", content: "주제: 배포 전략" }],
    });

    assert.equal(result.response, "제 의견은");
    assert.ok(urls[0].endsWith("/p/sophie/v1/runs"), urls[0]);
    assert.ok(urls[1].includes("/v1/runs/r9/events"), urls[1]);
  });

  test("reports the run handle so callers can abort", async () => {
    const client = clientWith((url) => {
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r5" }), { status: 202 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"ok"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    const seen: string[] = [];
    await adapter.execute({
      sessionKey: "m", prompt: "p",
      conversationHistory: [{ role: "user", content: "c" }],
      onRunStarted: (id) => seen.push(id),
    });
    assert.deepEqual(seen, ["r5"]);
  });

  test("forwards tool progress to the caller", async () => {
    const client = clientWith(() => sseResponse([
      'event: tool.progress\ndata: {"tool_name":"read_file","delta":"src/app.ts"}\n\n',
      'event: assistant.completed\ndata: {"content":"완료"}\n\n',
    ]));

    const adapter = new HermesAdapter(client, { sessionId: "s" });
    const progress: Array<[string, string]> = [];
    await adapter.execute({
      sessionKey: "k", prompt: "p",
      onToolProgress: (name, preview) => progress.push([name, preview]),
    });
    assert.deepEqual(progress, [["read_file", "src/app.ts"]]);
  });

  test("abort stops the last run", async () => {
    const urls: string[] = [];
    const client = clientWith((url) => {
      urls.push(url);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "r2" }), { status: 202 });
      if (url.includes("/stop")) return new Response("{}", { status: 200 });
      return sseResponse(['event: assistant.completed\ndata: {"content":"x"}\n\n']);
    });

    const adapter = new HermesAdapter(client);
    await adapter.execute({ sessionKey: "k", prompt: "p", conversationHistory: [{ role: "user", content: "c" }] });
    await adapter.abort("k");
    assert.ok(urls.some((u) => u.endsWith("/v1/runs/r2/stop")), urls.join("\n"));
  });

  test("abort is a no-op when no run is in flight", async () => {
    const adapter = new HermesAdapter(clientWith(() => new Response("{}")));
    await adapter.abort("k"); // must not throw
  });

  test("testConnection reports ok when capabilities are readable", async () => {
    const client = clientWith(() => new Response(
      JSON.stringify({ features: { run_steer: true }, endpoints: {}, version: "0.20.2" }),
      { status: 200 },
    ));
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "ok");
  });

  test("testConnection reports error on 401", async () => {
    const client = clientWith(() => new Response("{}", { status: 401 }));
    const result = await new HermesAdapter(client).testConnection({});
    assert.equal(result.status, "error");
  });
});
