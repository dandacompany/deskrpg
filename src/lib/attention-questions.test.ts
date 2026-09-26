import assert from "node:assert/strict";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

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

setupThrowawaySqlite("attention-questions");
const servers: FakePluginServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const CAPS = ["kanban", "cron", "events", "ask_user"];

async function fixture() {
  const server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { noah: "profile-key-1234567890" },
    info: { capabilities: CAPS },
  });
  servers.push(server);
  const owner = await seedUser(`aq-${Math.random().toString(36).slice(2, 8)}`);
  const member = await seedUser(`aq-${Math.random().toString(36).slice(2, 8)}`);
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const { db, gatewayResources, channelMembers } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({
      pluginInfoJson: JSON.stringify({ plugin: "deskrpg", version: "0.23.0", capabilities: CAPS }),
    })
    .where(eq(gatewayResources.id, gateway.id));
  const channel = await seedChannel(owner.id, "questions");
  await db
    .insert(channelMembers)
    .values({ channelId: channel.id, userId: member.id, role: "member" });
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const profile = await seedHermesProfile(gateway.id, { profileName: "noah", displayName: "Noah" });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  const state = server.askUser("noah");
  state.sessions.set("sess-owner", { userId: owner.id, npcId: npc.id, channelId: channel.id });
  const q = seedQuestion(state, {
    sessionId: "sess-owner",
    question: "Which format?",
    choices: ["A", "B"],
  });
  return { server, owner, member, channel, npc, state, q };
}

const req = (userId: string, url: string, body?: unknown) =>
  new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-user-id": userId, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("the inbox shows an NPC's question to the user it was put to, and to nobody else", async () => {
  const f = await fixture();
  const { getAttentionInbox } = await import("./attention-routes");
  const url = `http://localhost/api/channels/${f.channel.id}/attention`;
  const mine = (await (await getAttentionInbox(req(f.owner.id, url), f.channel.id)).json()).rows;
  assert.deepEqual(
    mine
      .filter((r: { kind: string }) => r.kind === "question")
      .map((r: { id: string; requestedBy: string }) => [r.id, r.requestedBy]),
    [[f.q.id, "Noah"]],
  );
  const theirs = (await (await getAttentionInbox(req(f.member.id, url), f.channel.id)).json()).rows;
  assert.equal(theirs.filter((r: { kind: string }) => r.kind === "question").length, 0);
});

test("the user answers from the inbox; a second answer and anyone else get 404", async () => {
  const f = await fixture();
  const { postQuestionAnswer } = await import("./attention-routes");
  const url = `http://localhost/api/channels/${f.channel.id}/attention/questions/${f.q.id}/answer`;
  const other = await postQuestionAnswer(
    req(f.member.id, url, { npcId: f.npc.id, response: "A" }),
    f.channel.id,
    f.q.id,
  );
  assert.equal(other.status, 404);
  const ok = await postQuestionAnswer(
    req(f.owner.id, url, { npcId: f.npc.id, response: "A" }),
    f.channel.id,
    f.q.id,
  );
  assert.equal(ok.status, 200);
  assert.equal(f.state.answers.get(f.q.id), "A");
  const again = await postQuestionAnswer(
    req(f.owner.id, url, { npcId: f.npc.id, response: "A" }),
    f.channel.id,
    f.q.id,
  );
  assert.equal(again.status, 404);
});

test("a malformed body is 400 and an NPC outside the channel is 404", async () => {
  const f = await fixture();
  const { postQuestionAnswer } = await import("./attention-routes");
  const url = `http://localhost/api/channels/${f.channel.id}/attention/questions/${f.q.id}/answer`;
  const bad = await postQuestionAnswer(
    req(f.owner.id, url, { npcId: f.npc.id }),
    f.channel.id,
    f.q.id,
  );
  assert.equal(bad.status, 400);
  const elsewhere = await postQuestionAnswer(
    req(f.owner.id, url, { npcId: "npc-elsewhere", response: "A" }),
    f.channel.id,
    f.q.id,
  );
  assert.equal(elsewhere.status, 404);
  assert.equal(f.state.answers.size, 0);
});
