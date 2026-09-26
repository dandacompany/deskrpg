import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";
import { seedQuestion } from "@/lib/hermes/fake-ask-user-routes";

setupThrowawaySqlite("npc-questions");
const servers: FakePluginServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function fixture({ askUser = true } = {}) {
  const capabilities = ["kanban", "cron", "events", ...(askUser ? ["ask_user"] : [])];
  const server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { noah: "profile-key-1234567890" },
    info: { capabilities },
  });
  servers.push(server);
  const owner = await seedUser(`q-${Math.random().toString(36).slice(2, 8)}`);
  const other = await seedUser(`q-${Math.random().toString(36).slice(2, 8)}`);
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const { db, gatewayResources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({ pluginInfoJson: JSON.stringify({ plugin: "deskrpg", version: "0.23.0", capabilities }) })
    .where(eq(gatewayResources.id, gateway.id));
  const channel = await seedChannel(owner.id, "questions");
  const profile = await seedHermesProfile(gateway.id, { profileName: "noah", displayName: "Noah" });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  const state = server.askUser("noah");
  const ask = (userId: string, sessionId = `sess-${userId}`) => {
    state.sessions.set(sessionId, { userId, npcId: npc.id, channelId: channel.id });
    return seedQuestion(state, {
      sessionId,
      question: "Which format?",
      choices: ["Summary", "Table"],
    });
  };
  return { server, owner, other, channel, npc, state, ask };
}

test("registering a session sends the user, NPC and channel as context", async () => {
  const f = await fixture();
  const { registerAskUserSession } = await import("./npc-questions");
  const ok = await registerAskUserSession({
    npcId: f.npc.id,
    sessionId: "sess-9",
    userId: f.owner.id,
    channelId: f.channel.id,
  });
  assert.equal(ok, true);
  assert.deepEqual(f.state.sessions.get("sess-9"), {
    userId: f.owner.id,
    npcId: f.npc.id,
    channelId: f.channel.id,
  });
});

test("without the ask_user capability nothing is registered", async () => {
  const f = await fixture({ askUser: false });
  const { registerAskUserSession } = await import("./npc-questions");
  assert.equal(
    await registerAskUserSession({
      npcId: f.npc.id,
      sessionId: "s",
      userId: f.owner.id,
      channelId: f.channel.id,
    }),
    false,
  );
});

test("a user answers their own question and it leaves the list", async () => {
  const f = await fixture();
  const q = f.ask(f.owner.id);
  const { answerNpcQuestion, listUserQuestions } = await import("./npc-questions");
  const [row] = await listUserQuestions(f.channel.id, f.owner.id);
  assert.deepEqual(
    { id: row.id, npcId: row.npcId, npcName: row.npcName, choices: row.choices },
    { id: q.id, npcId: f.npc.id, npcName: "Noah", choices: ["Summary", "Table"] },
  );
  assert.equal(
    await answerNpcQuestion({
      userId: f.owner.id,
      npcId: f.npc.id,
      questionId: q.id,
      response: "Table",
    }),
    "answered",
  );
  assert.equal(f.state.answers.get(q.id), "Table");
  assert.deepEqual(await listUserQuestions(f.channel.id, f.owner.id), []);
});

test("someone else neither sees nor answers the question", async () => {
  const f = await fixture();
  const q = f.ask(f.owner.id);
  const { answerNpcQuestion, listUserQuestions } = await import("./npc-questions");
  assert.deepEqual(await listUserQuestions(f.channel.id, f.other.id), []);
  assert.equal(
    await answerNpcQuestion({
      userId: f.other.id,
      npcId: f.npc.id,
      questionId: q.id,
      response: "Table",
    }),
    "not_found",
  );
  assert.equal(f.state.answers.size, 0);
});

test("a question from another channel is not listed here", async () => {
  const f = await fixture();
  f.state.sessions.set("sess-x", {
    userId: f.owner.id,
    npcId: f.npc.id,
    channelId: "other-channel",
  });
  seedQuestion(f.state, { sessionId: "sess-x", question: "Q", choices: ["A", "B"] });
  const { listUserQuestions } = await import("./npc-questions");
  assert.deepEqual(await listUserQuestions(f.channel.id, f.owner.id), []);
});

test("an off-list answer to a choices-only question comes back invalid", async () => {
  const f = await fixture();
  f.state.sessions.set("sess-o", { userId: f.owner.id, npcId: f.npc.id, channelId: f.channel.id });
  const q = seedQuestion(f.state, {
    sessionId: "sess-o",
    question: "Q",
    choices: ["A", "B"],
    allowOther: false,
  });
  const { answerNpcQuestion } = await import("./npc-questions");
  assert.equal(
    await answerNpcQuestion({
      userId: f.owner.id,
      npcId: f.npc.id,
      questionId: q.id,
      response: "C",
    }),
    "invalid",
  );
});
