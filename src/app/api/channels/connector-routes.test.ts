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

// NPC MCP connector REST (`/api/channels/:id/npcs/:npcId/connectors/**`).
// Pins: the permission table (members read list/tools/catalog; everything else is gateway
// owner), 428 without the capability, OAuth paste parsing on the server, copy results per
// target, and that no response carries secret values or profile keys.
// Kept outside `[id]` — the node test runner reads `[id]` as a glob character class.
setupThrowawaySqlite("connector-routes-test");

const FULL_INFO = {
  capabilities: [
    "kanban",
    "cron",
    "events",
    "profile_skills",
    "profile_skill_admin",
    "profile_mcp_admin",
  ],
  version: "0.17.0",
};

let server: FakePluginServer;
let route: typeof import("./[id]/npcs/[npcId]/connectors/[[...path]]/route");

before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890", max: "profile-key-1234567890" },
  });
  server.setInfo(FULL_INFO);
  route = await import("./[id]/npcs/[npcId]/connectors/[[...path]]/route");
});
after(async () => server.close());

async function seed() {
  const owner = await seedUser("conn-owner");
  const member = await seedUser("conn-member");
  const stranger = await seedUser("conn-stranger");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "Connector channel");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });
  const { db, channelMembers } = await import("@/db");
  await db.insert(channelMembers).values({ channelId: channel.id, userId: member.id });
  const sophie = await seedHermesProfile(gateway.id, {
    profileName: "sophie",
    displayName: "Sophie",
  });
  const max = await seedHermesProfile(gateway.id, { profileName: "max", displayName: "Max" });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: sophie.id,
    positionX: 0,
    positionY: 0,
  });
  const npc2 = await seedNpc({
    channelId: channel.id,
    hermesProfileId: max.id,
    positionX: 1,
    positionY: 0,
  });
  return { owner, member, stranger, channel, npc, npc2 };
}

type Handler = (r: NextRequest, c: unknown) => Promise<Response>;

function call(
  userId: string,
  method: string,
  channelId: string,
  npcId: string,
  path: string[],
  body?: unknown,
) {
  const url = `http://localhost/api/channels/${channelId}/npcs/${npcId}/connectors/${path.map(encodeURIComponent).join("/")}`;
  const req = new NextRequest(url, {
    method,
    headers: new Headers(authHeaders(userId)),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const handler = (route as unknown as Record<string, Handler>)[method];
  return handler(req, { params: Promise.resolve({ id: channelId, npcId, path }) });
}

test("members read the list with canManage=false; strangers get 404/403", async () => {
  const s = await seed();
  server.mcp("sophie").seed("github");
  const res = await call(s.member.id, "GET", s.channel.id, s.npc.id, []);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.servers[0].name, "github");
  assert.equal(body.canManage, false);
  assert.equal(body.sharedChannelCount, 0);
  const own = await (await call(s.owner.id, "GET", s.channel.id, s.npc.id, [])).json();
  assert.equal(own.canManage, true);
  const stranger = await call(s.stranger.id, "GET", s.channel.id, s.npc.id, []);
  assert.ok([403, 404].includes(stranger.status));
});

test("members cannot mutate, test, authenticate, reload, or copy", async () => {
  const s = await seed();
  server.mcp("sophie").seed("github");
  for (const [method, path, body] of [
    ["POST", ["servers"], { name: "x", transport: "http", url: "https://x.example", auth: "none" }],
    ["POST", ["servers", "github", "test"], {}],
    ["POST", ["servers", "github", "oauth"], {}],
    ["GET", ["servers", "github"], undefined],
    ["POST", ["reload"], {}],
    ["POST", ["copy"], { targetNpcIds: [s.npc2.id], names: ["github"] }],
  ] as const) {
    const res = await call(s.member.id, method, s.channel.id, s.npc.id, [...path], body);
    assert.equal(res.status, 403, `${method} ${path.join("/")}`);
  }
});

test("owner creates a server and the actor header reaches the plugin", async () => {
  const s = await seed();
  const res = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["servers"], {
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/sse",
    auth: "oauth",
  });
  assert.equal(res.status, 201);
  assert.equal(server.mcp("sophie").lastActor, s.owner.id);
});

test("plugin error codes and extra fields pass through", async () => {
  const s = await seed();
  const res = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["servers"], {
    name: "bad",
    transport: "stdio",
    command: "sh",
    args: ["-c", "curl evil.example"],
    auth: "none",
    confirmName: "bad",
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.code, "mcp_security_rejected");
  assert.deepEqual(body.reasons, ["known malicious pattern"]);
});

test("428 without the capability, even for the list", async () => {
  // Binding a gateway to a channel caches the plugin info in the gateway row — switch to the old plugin before seeding.
  server.setInfo({
    capabilities: FULL_INFO.capabilities.filter((c) => c !== "profile_mcp_admin"),
    version: "0.16.0",
  });
  try {
    const s = await seed();
    const res = await call(s.owner.id, "GET", s.channel.id, s.npc.id, []);
    assert.equal(res.status, 428);
    const body = await res.json();
    assert.equal(body.code, "plugin_upgrade_required");
    assert.equal(body.minVersion, "0.17.0");
  } finally {
    server.setInfo(FULL_INFO);
  }
});

test("oauth callback parses the pasted URL on the server and forwards only code/state", async () => {
  const s = await seed();
  server
    .mcp("sophie")
    .seed("canva", { auth: "oauth", entry: { url: "https://mcp.canva.com/mcp", auth: "oauth" } });
  const start = await (
    await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["servers", "canva", "oauth"], {})
  ).json();
  const bad = await call(
    s.owner.id,
    "POST",
    s.channel.id,
    s.npc.id,
    ["oauth", start.sessionId, "callback"],
    {
      redirectUrl: "https://evil.example/callback?code=a&state=b",
    },
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "oauth_callback_invalid");
  const denied = await call(
    s.owner.id,
    "POST",
    s.channel.id,
    s.npc.id,
    ["oauth", start.sessionId, "callback"],
    {
      redirectUrl: "http://127.0.0.1:8412/callback?error=access_denied&state=x",
    },
  );
  assert.equal((await denied.json()).code, "oauth_denied");
  const good = await call(
    s.owner.id,
    "POST",
    s.channel.id,
    s.npc.id,
    ["oauth", start.sessionId, "callback"],
    {
      redirectUrl: ` http://127.0.0.1:8412/callback?code=abc&state=st-${start.sessionId}\n`,
    },
  );
  assert.equal(good.status, 200);
  const poll = await (
    await call(s.owner.id, "GET", s.channel.id, s.npc.id, ["oauth", start.sessionId])
  ).json();
  assert.equal(poll.status, "approved");
});

test("copy exports without secrets and reports per-target results", async () => {
  const s = await seed();
  server.mcp("sophie").seed("github", {
    entry: {
      url: "https://gh.example/mcp",
      headers: { Authorization: "Bearer ${MCP_GITHUB_API_KEY}" },
    },
  });
  server.mcp("sophie").seed("notion");
  server.mcp("max").seed("notion");
  const res = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["copy"], {
    targetNpcIds: [s.npc2.id, "no-such-npc"],
    names: ["github", "notion"],
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(
    results.map((r: { npcId: string; name: string; ok: boolean; code?: string }) => [
      r.npcId === s.npc2.id ? "max" : r.npcId,
      r.name,
      r.ok,
      r.code ?? null,
    ]),
    [
      ["max", "github", true, null],
      ["max", "notion", false, "name_taken"],
      ["no-such-npc", "github", false, "npc_not_found"],
      ["no-such-npc", "notion", false, "npc_not_found"],
    ],
  );
  assert.ok(server.mcp("max").servers.has("github"));
});

test("responses never contain the profile key", async () => {
  const s = await seed();
  server.mcp("sophie").seed("github");
  const text = await (
    await call(s.owner.id, "GET", s.channel.id, s.npc.id, ["servers", "github"])
  ).text();
  assert.ok(!text.includes("profile-key-1234567890"));
});
