import assert from "node:assert/strict";
import test from "node:test";

import { createSseParser, type SseEvent } from "../../src/lib/hermes/sse";
import { startMockHermes } from "./mock-hermes";
import { createOwnerPluginClient } from "../../src/lib/hermes/plugin-client";

const headers = {
  Authorization: "Bearer readme-capture-sophie-token",
  "Content-Type": "application/json",
};

test("the real owner client creates a card and consumes its completion once by cursor", async (t) => {
  const server = await startServer(t);
  const client = createOwnerPluginClient({
    baseUrl: server.baseUrl,
    ownerToken: "readme-capture-gateway-token",
  });
  const info = await client.info();
  assert.equal(info.ok, true);
  assert.equal((await client.kanban.createBoard({ slug: "capture", name: "Office" })).ok, true);
  const created = await client.kanban.createTask("capture", {
    title: "릴리스 점검",
    assignee: "sophie",
  });
  assert.ok(created.ok);
  const before = await client.events.poll({ board: "capture" });
  assert.ok(before.ok);
  assert.deepEqual(before.data.events, []);
  const completed = await client.kanban.updateTask("capture", created.data.task.id, {
    status: "done",
  });
  assert.ok(completed.ok);
  const after = await client.events.poll({ board: "capture", cursor: before.data.cursor });
  assert.ok(after.ok);
  assert.equal(after.data.events.length, 1);
  assert.deepEqual(after.data.events[0].payload, {
    from: "todo",
    to: "done",
    title: "릴리스 점검",
    assignee: "sophie",
    parent_count: 0,
  });
  const next = await client.events.poll({ board: "capture", cursor: after.data.cursor });
  assert.ok(next.ok);
  assert.deepEqual(next.data.events, []);
  const detail = await client.kanban.getTask("capture", created.data.task.id);
  assert.ok(detail.ok);
  assert.equal(detail.data.task.status, "done");
});

test("supports the real unauthenticated gateway discovery handshake", async (t) => {
  const server = await startServer(t);
  assert.equal((await fetch(`${server.baseUrl}/health`)).status, 200);
  const models = await fetch(`${server.baseUrl}/v1/models`);
  assert.equal(models.status, 401);
  assert.match(models.headers.get("content-type") ?? "", /json/);
});

test("room-scoped multi-party runs stream the small-talk script rather than meeting lines", async (t) => {
  const server = await startServer(t);
  const response = await fetch(`${server.baseUrl}/p/sophie/v1/runs`, {
    method: "POST",
    headers: { ...headers, "X-Hermes-Session-Key": "deskrpg-npc-room-capture" },
    body: JSON.stringify({ input: "좋은 아침이에요" }),
  });
  const { run_id } = (await response.json()) as { run_id: string };
  const started = performance.now();
  const stream = await fetch(`${server.baseUrl}/p/sophie/v1/runs/${run_id}/events`, { headers });
  const reader = stream.body!.getReader();
  const first = await reader.read();
  const firstChunkMs = performance.now() - started;
  const decoder = new TextDecoder();
  let body = decoder.decode(first.value);
  assert.match(body, /message.delta/);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value);
  }
  assert.ok(firstChunkMs >= 600, `thinking hold was only ${firstChunkMs} ms`);
  const events = createSseParser().push(body);
  assert.deepEqual(
    events.filter((e) => e.event === "message.delta").map((e) => e.data.delta),
    ["좋은 ", "아침이에요. ", "오늘 일정부터 함께 확인할게요."],
  );
});

async function startServer(t: test.TestContext) {
  const server = await startMockHermes({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  return server;
}

async function createSession(baseUrl: string, title: string) {
  const response = await fetch(`${baseUrl}/p/sophie/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ session: { id: string } }>;
}

async function startRun(baseUrl: string, profile: "sophie" | "noah") {
  const response = await fetch(`${baseUrl}/p/${profile}/v1/runs`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer readme-capture-${profile}-token`,
    },
    body: JSON.stringify({ input: "회의 발언을 준비해 주세요" }),
  });
  assert.equal(response.status, 202);
  return response.json() as Promise<{ run_id: string }>;
}

async function streamEvents(baseUrl: string, profile: "sophie" | "noah", runId: string) {
  const stream = await fetch(`${baseUrl}/p/${profile}/v1/runs/${runId}/events`, {
    headers: {
      ...headers,
      Authorization: `Bearer readme-capture-${profile}-token`,
    },
  }).then((response) => response.text());
  return createSseParser().push(stream);
}

test(
  "serves profile capabilities and deterministic session chat SSE",
  { timeout: 5_000 },
  async (t) => {
    const server = await startServer(t);
    const caps = await fetch(`${server.baseUrl}/p/sophie/v1/capabilities`, { headers });
    assert.equal(caps.status, 200);

    const session = await createSession(server.baseUrl, "readme");
    const stream = await fetch(
      `${server.baseUrl}/p/sophie/api/sessions/${session.session.id}/chat/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "좋은 아침이에요" }),
      },
    ).then((response) => response.text());
    const events = createSseParser().push(stream);

    assert.ok(events.some((event) => event.event === "assistant.delta"));
    assert.equal(events.at(-1)?.event, "run.completed");
    assert.deepEqual(
      events.filter((event) => event.event === "assistant.delta").map((event) => event.data.delta),
      ["좋은 ", "아침이에요. ", "오늘 일정부터 함께 확인할게요."],
    );
  },
);

test("rejects requests without a bearer fixed capture token", async (t) => {
  const server = await startServer(t);
  const missing = await fetch(`${server.baseUrl}/p/sophie/v1/capabilities`);
  const malformed = await fetch(`${server.baseUrl}/p/sophie/v1/capabilities`, {
    headers: { Authorization: "NotAuthreadme-capture-sophie-token" },
  });

  assert.equal(missing.status, 401);
  assert.equal(malformed.status, 401);
});

test("creates unique nested session ids", async (t) => {
  const server = await startServer(t);
  const first = await createSession(server.baseUrl, "first");
  const second = await createSession(server.baseUrl, "second");

  assert.match(first.session.id, /^session-/);
  assert.match(second.session.id, /^session-/);
  assert.notEqual(first.session.id, second.session.id);
});

test("rejects inherited object keys as unknown profiles", async (t) => {
  const server = await startServer(t);
  const response = await fetch(`${server.baseUrl}/p/toString/v1/capabilities`, { headers });
  assert.equal(response.status, 404);
});

test(
  "streams deterministic profile meeting lines with the run SSE dialect",
  { timeout: 10_000 },
  async (t) => {
    const server = await startServer(t);
    const firstSophieRun = await startRun(server.baseUrl, "sophie");
    const secondSophieRun = await startRun(server.baseUrl, "sophie");
    const noahRun = await startRun(server.baseUrl, "noah");

    assert.match(firstSophieRun.run_id, /^run-/);
    assert.notEqual(firstSophieRun.run_id, secondSophieRun.run_id);

    const [firstSophieEvents, secondSophieEvents, noahEvents] = await Promise.all([
      streamEvents(server.baseUrl, "sophie", firstSophieRun.run_id),
      streamEvents(server.baseUrl, "sophie", secondSophieRun.run_id),
      streamEvents(server.baseUrl, "noah", noahRun.run_id),
    ]);
    const text = (events: SseEvent[]) =>
      events
        .filter((event) => event.event === "message.delta")
        .map((event) => event.data.delta)
        .join("");

    assert.equal(text(firstSophieEvents), "SPEAK: 오전에는 릴리스 점검부터 진행하겠습니다.");
    assert.equal(text(secondSophieEvents), "SPEAK: 오전에는 릴리스 점검부터 진행하겠습니다.");
    assert.equal(text(noahEvents), "SPEAK: 저는 사용자 피드백을 정리해 공유하겠습니다.");
    assert.equal(firstSophieEvents.at(-1)?.event, "run.completed");
  },
);

test("rejects non-loopback listen hosts", async () => {
  await assert.rejects(() => startMockHermes({ host: "0.0.0.0", port: 0 }), /loopback/i);
});

test("a priming room request stays busy briefly and later greetings are not mistaken for priming", async (t) => {
  const server = await startServer(t);
  for (const [input, expected, minimumMs] of [
    ["잠깐 준비해 주세요.", "준비됐어요.", 3300],
    [
      "[최근 대화]\nDante: 잠깐 준비해 주세요.\nDante: 좋은 아침이에요\n\n[답하는 법]\n짧게 답하세요.",
      "좋은 아침이에요. 오늘 일정부터 함께 확인할게요.",
      600,
    ],
    [
      "[Recent conversation]\nDante: 잠깐 준비해 주세요.\nDante: 좋은 아침이에요\n\n[How to reply]\nReply briefly.",
      "좋은 아침이에요. 오늘 일정부터 함께 확인할게요.",
      600,
    ],
  ] as const) {
    const response = await fetch(`${server.baseUrl}/p/sophie/v1/runs`, {
      method: "POST",
      headers: { ...headers, "X-Hermes-Session-Key": "deskrpg-npc-room-capture" },
      body: JSON.stringify({ input }),
    });
    const { run_id } = (await response.json()) as { run_id: string };
    const started = performance.now();
    const events = await streamEvents(server.baseUrl, "sophie", run_id);
    assert.ok(performance.now() - started >= minimumMs);
    assert.equal(
      events
        .filter((e) => e.event === "message.delta")
        .map((e) => e.data.delta)
        .join(""),
      expected,
    );
  }
});
