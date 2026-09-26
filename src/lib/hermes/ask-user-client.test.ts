import assert from "node:assert/strict";
import { after, test } from "node:test";

import { HermesClient } from "./hermes-client";
import { startFakePluginServer, type FakePluginServer } from "./fake-plugin-server";
import { seedQuestion } from "./fake-ask-user-routes";
import { createProfilePluginClient } from "./plugin-client";
import { supportsAskUser } from "./plugin-capability";

const servers: FakePluginServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function fixture(capabilities = ["kanban", "cron", "events", "ask_user"]) {
  const server = await startFakePluginServer({
    ownerToken: "owner-token-1234567890",
    profileTokens: { noah: "noah-token-1234567890" },
    info: { capabilities },
  });
  servers.push(server);
  const client = createProfilePluginClient({
    baseUrl: server.baseUrl,
    profileName: "noah",
    profileToken: "noah-token-1234567890",
  });
  return { server, client };
}

test("a registered session's question lists with the registered context and takes one answer", async () => {
  const { server, client } = await fixture();
  const registered = await client.askUser.registerSession("sess-1", {
    userId: "u-1",
    npcId: "n-1",
  });
  assert.equal(registered.ok, true);
  const q = seedQuestion(server.askUser("noah"), {
    sessionId: "sess-1",
    question: "Which format?",
    choices: ["Summary", "Table"],
  });

  const listed = await client.askUser.listQuestions("sess-1");
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.data.questions.map((x) => [x.id, x.context]),
    [[q.id, { userId: "u-1", npcId: "n-1" }]],
  );
  const other = await client.askUser.listQuestions("sess-2");
  assert.ok(other.ok && other.data.questions.length === 0);

  const answered = await client.askUser.answer(q.id, "Table");
  assert.equal(answered.ok, true);
  assert.equal(server.askUser("noah").answers.get(q.id), "Table");
  const again = await client.askUser.answer(q.id, "Table");
  assert.ok(!again.ok);
  assert.equal(again.status, 404);
});

test("an off-list answer is refused when the question takes only its choices", async () => {
  const { server, client } = await fixture();
  const q = seedQuestion(server.askUser("noah"), {
    sessionId: "s",
    question: "Which?",
    choices: ["A", "B"],
    allowOther: false,
  });
  const res = await client.askUser.answer(q.id, "C");
  assert.ok(!res.ok);
  assert.equal(res.status, 400);
});

test("an old plugin has no ask_user capability and its routes are absent", async () => {
  const { client } = await fixture(["kanban", "cron", "events"]);
  assert.equal(supportsAskUser({ capabilities: ["kanban"] } as never), false);
  const res = await client.askUser.registerSession("s", {});
  assert.ok(!res.ok);
});

test("a run's Hermes session id comes from GET /v1/runs/{id}", async () => {
  const seen: string[] = [];
  const client = new HermesClient({
    baseUrl: "http://hermes.test",
    profileName: "noah",
    token: "t",
    fetchImpl: (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ run_id: "run_2", session_id: "run_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(await client.getRunSessionId("run_2"), "run_1");
  assert.ok(seen[0].endsWith("/p/noah/v1/runs/run_2"), seen[0]);
});
