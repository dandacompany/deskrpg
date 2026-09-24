import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

// NPC skill management REST (`/api/channels/:id/npcs/:npcId/skills/**`).
//
// What we pin: the permission table (read = channel member; changes, Hub, curator control, graph node operations and memory nodes = gateway
// owner), that the NPC must be an active NPC of this channel, that only the list works without the capability, that fixed segments
// come before skill names, that plugin error codes pass through as is, and that responses carry no keys.
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class and misses the *.test.ts inside it.
setupThrowawaySqlite("skill-routes-test");

const FULL_INFO = {
  capabilities: ["kanban", "cron", "events", "profile_skills", "profile_skill_admin"],
  version: "0.15.0",
};

let server: FakePluginServer;
let route: typeof import("./[id]/npcs/[npcId]/skills/[[...path]]/route");

before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
  server.setInfo(FULL_INFO);
  route = await import("./[id]/npcs/[npcId]/skills/[[...path]]/route");
});
after(async () => server.close());

async function seed() {
  const owner = await seedUser("skill-owner");
  const member = await seedUser("skill-member");
  const stranger = await seedUser("skill-stranger");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "스킬 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId: channel.id, userId: member.id });
  const profile = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: "소피",
  });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  const other = await seedChannel(owner.id, "다른 채널");
  await seedNpc({ channelId: other.id, hermesProfileId: profile.id, positionX: 0, positionY: 0 });
  return { owner, member, stranger, channel, npc, profile, gateway };
}

type Handler = (r: NextRequest, c: unknown) => Promise<Response>;

function call(
  userId: string,
  method: string,
  channelId: string,
  npcId: string,
  path: string[],
  body?: unknown,
  search = "",
) {
  const headers = new Headers(authHeaders(userId));
  const url = `http://localhost/api/channels/${channelId}/npcs/${npcId}/skills/${path.map(encodeURIComponent).join("/")}${search}`;
  const req = new NextRequest(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const handler = (route as unknown as Record<string, Handler>)[method];
  return handler(req, { params: Promise.resolve({ id: channelId, npcId, path }) });
}

test("members read the list with canManage=false, the owner gets true, and the shared channel count is given", async () => {
  const { owner, member, channel, npc } = await seed();
  server.skills("sophie").seed("weekly");
  const m = await call(member.id, "GET", channel.id, npc.id, []);
  assert.equal(m.status, 200);
  const mb = await m.json();
  assert.equal(mb.canManage, false);
  assert.equal(mb.capabilityReady, true);
  assert.equal(mb.sharedChannelCount, 1);
  assert.ok(mb.skills.some((s: { name: string }) => s.name === "weekly"));
  const o = await (await call(owner.id, "GET", channel.id, npc.id, [])).json();
  assert.equal(o.canManage, true);
});

test("unauthenticated 401, non-member 403, another channel's NPC 404", async () => {
  const { stranger, owner, channel, npc } = await seed();
  const anon = await route.GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}/npcs/${npc.id}/skills`),
    { params: Promise.resolve({ id: channel.id, npcId: npc.id }) },
  );
  assert.equal(anon.status, 401);
  assert.equal((await call(stranger.id, "GET", channel.id, npc.id, [])).status, 403);
  const other = await seed();
  const res = await call(owner.id, "GET", channel.id, other.npc.id, []);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "npc_not_found");
});

test("a sleeping NPC is 404 npc_not_found", async () => {
  const { owner, channel, gateway } = await seed();
  const noah = await seedHermesProfile(gateway.id, { profileName: "noah" });
  const sleeping = await seedNpc({
    channelId: channel.id,
    hermesProfileId: noah.id,
    active: false,
  });
  const res = await call(owner.id, "GET", channel.id, sleeping.id, []);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "npc_not_found");
});

test("members_cannot_call_changes_or_memory_nodes", async () => {
  const { member, channel, npc } = await seed();
  server.skills("sophie").seed("weekly");
  server.skills("sophie").memory.splice(0, Infinity, "기억");
  const before = server.requests().length;
  const put = await call(member.id, "PUT", channel.id, npc.id, ["weekly", "file"], {
    path: "SKILL.md",
    content: "x",
    baseHash: null,
  });
  assert.equal(put.status, 403);
  const mem = await call(
    member.id,
    "GET",
    channel.id,
    npc.id,
    ["learning", "node"],
    undefined,
    "?id=memory:memory:0",
  );
  assert.equal(mem.status, 403);
  // The rejection happens before reaching the plugin's skill route.
  const skillCalls = server
    .requests()
    .slice(before)
    .filter((r) => /\/deskrpg\/(skills|learning)/.test(r.path));
  assert.equal(skillCalls.length, 0);

  const graph = await call(member.id, "GET", channel.id, npc.id, ["learning", "graph"]);
  assert.equal(graph.status, 200);
  assert.equal(server.lastRequest()!.path.endsWith("includeMemory=0"), true);
  assert.equal(JSON.stringify(await graph.json()).includes("기억"), false);
  const skillNode = await call(
    member.id,
    "GET",
    channel.id,
    npc.id,
    ["learning", "node"],
    undefined,
    "?id=weekly",
  );
  assert.equal(skillNode.status, 200);
});

test("owner changes carry the user id in X-DeskRPG-Actor and pass plugin codes through as is", async () => {
  const { owner, channel, npc } = await seed();
  server.skills("sophie").seed("weekly");
  const res = await call(owner.id, "PUT", channel.id, npc.id, ["weekly", "file"], {
    path: "SKILL.md",
    content: "x",
    baseHash: "0".repeat(64),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "skill_changed");
  assert.equal(server.skills("sophie").lastActor, owner.id);
});

test("the owner's graph uses includeMemory=1", async () => {
  const { owner, channel, npc } = await seed();
  await call(owner.id, "GET", channel.id, npc.id, ["learning", "graph"]);
  assert.match(server.lastRequest()!.path, /includeMemory=1$/);
});

test("without the capability only the list works and the rest are 428", async () => {
  // Binding a gateway to a channel caches the plugin info in the gateway row — switch to the old plugin before seeding.
  server.setInfo({
    capabilities: ["kanban", "cron", "events", "profile_skills"],
    version: "0.14.0",
  });
  try {
    const { owner, channel, npc } = await seed();
    const list = await (await call(owner.id, "GET", channel.id, npc.id, [])).json();
    assert.equal(list.capabilityReady, false);
    assert.equal(list.canManage, false);
    const res = await call(owner.id, "GET", channel.id, npc.id, ["archive"]);
    assert.equal(res.status, 428);
    assert.equal((await res.json()).minVersion, "0.15.0");
  } finally {
    server.setInfo(FULL_INFO);
  }
});

test("fixed_segments_come_before_names", async () => {
  const { owner, channel, npc } = await seed();
  server.skills("sophie").seed("archive");
  const res = await call(owner.id, "GET", channel.id, npc.id, ["archive"]);
  assert.equal(res.status, 200);
  assert.ok("archived" in (await res.json()));
});

test("a skill whose name contains / goes as one segment", async () => {
  const { owner, channel, npc } = await seed();
  server.skills("sophie").seed("a/b");
  const res = await call(owner.id, "GET", channel.id, npc.id, ["a/b"]);
  assert.equal(res.status, 200);
  assert.equal(server.lastRequest()!.path, "/p/sophie/deskrpg/skills/a%2Fb");
});

test("install passes 202 and jobId through; the job read picks kind by path", async () => {
  const { owner, channel, npc } = await seed();
  const res = await call(owner.id, "POST", channel.id, npc.id, ["hub", "installs"], {
    identifier: "a/b",
  });
  assert.equal(res.status, 202);
  const { jobId } = await res.json();
  const job = await call(owner.id, "GET", channel.id, npc.id, ["hub", "installs", jobId]);
  assert.equal((await job.json()).kind, "hub_install");
});

test("a new skill is 201, an unknown path is 404", async () => {
  const { owner, channel, npc } = await seed();
  const created = await call(owner.id, "POST", channel.id, npc.id, [], {
    name: "fresh",
    content: "---\nname: fresh\n---\n",
  });
  assert.equal(created.status, 201);
  const unknown = await call(owner.id, "GET", channel.id, npc.id, ["fresh", "nope"]);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "not_found");
});

test("responses carry no profile key", async () => {
  const { owner, channel, npc } = await seed();
  const text = await (await call(owner.id, "GET", channel.id, npc.id, [])).text();
  assert.equal(text.includes("profile-key-1234567890"), false);
  assert.equal(text.includes("gateway-owner-key"), false);
});
