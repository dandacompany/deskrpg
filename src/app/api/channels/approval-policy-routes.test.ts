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

// NPC unattended run policy REST (`/api/channels/:id/npcs/:npcId/approval-policy/**`).
// Pins: members read, only the gateway owner writes; 428 without `profile_approval_policy`;
// every response is the policy plus canManage/capabilityReady/sharedChannelCount; plugin
// validation errors pass through; the actor reaches the plugin; no key leaks.
// Kept outside `[id]` — the node test runner reads `[id]` as a glob character class.
setupThrowawaySqlite("approval-policy-routes-test");

const FULL_INFO = {
  capabilities: ["kanban", "cron", "events", "profile_skills", "profile_approval_policy"],
  version: "0.18.0",
};
const OLD_INFO = {
  capabilities: FULL_INFO.capabilities.filter((c) => c !== "profile_approval_policy"),
  version: "0.17.0",
};

let server: FakePluginServer;
let route: typeof import("./[id]/npcs/[npcId]/approval-policy/[[...path]]/route");

before(async () => {
  server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: { sophie: "profile-key-1234567890" },
  });
  server.setInfo(FULL_INFO);
  route = await import("./[id]/npcs/[npcId]/approval-policy/[[...path]]/route");
});
after(async () => server.close());

async function seed() {
  const owner = await seedUser("policy-owner");
  const member = await seedUser("policy-member");
  const stranger = await seedUser("policy-stranger");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "Policy channel");
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
    displayName: "Sophie",
  });
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 0,
    positionY: 0,
  });
  return { owner, member, stranger, channel, npc };
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
  const suffix = path.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const url = `http://localhost/api/channels/${channelId}/npcs/${npcId}/approval-policy${suffix}`;
  const req = new NextRequest(url, {
    method,
    headers: new Headers(authHeaders(userId)),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const handler = (route as unknown as Record<string, Handler>)[method];
  return handler(req, {
    params: Promise.resolve({ id: channelId, npcId, ...(path.length ? { path } : {}) }),
  });
}

test("members read the policy with canManage=false; the owner gets canManage=true", async () => {
  const s = await seed();
  const res = await call(s.member.id, "GET", s.channel.id, s.npc.id, []);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    cronMode: "deny",
    singleQueryMode: "deny",
    allowlist: [],
    timeoutSeconds: 300,
    workerPropagation: true,
    canManage: false,
    capabilityReady: true,
    sharedChannelCount: 0,
  });
  const own = await (await call(s.owner.id, "GET", s.channel.id, s.npc.id, [])).json();
  assert.equal(own.canManage, true);
  const stranger = await call(s.stranger.id, "GET", s.channel.id, s.npc.id, []);
  assert.ok([403, 404].includes(stranger.status));
});

test("members cannot change modes or the allowlist", async () => {
  const s = await seed();
  for (const [method, path, body] of [
    ["PUT", [], { cronMode: "approve" }],
    ["POST", ["allowlist"], { entry: "recursive delete" }],
    ["DELETE", ["allowlist"], { entry: "recursive delete" }],
  ] as const) {
    const res = await call(s.member.id, method, s.channel.id, s.npc.id, [...path], body);
    assert.equal(res.status, 403, `${method} ${path.join("/")}`);
    assert.equal((await res.json()).code, "forbidden");
  }
  assert.equal(server.approvalPolicy("sophie").policy.cronMode, "deny");
});

test("the owner changes modes and the allowlist; every response carries the view fields", async () => {
  const s = await seed();
  const put = await call(s.owner.id, "PUT", s.channel.id, s.npc.id, [], { cronMode: "approve" });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.cronMode, "approve");
  assert.equal(putBody.singleQueryMode, "deny");
  assert.equal(putBody.canManage, true);
  assert.equal(putBody.capabilityReady, true);
  assert.equal(putBody.sharedChannelCount, 0);
  assert.equal(server.approvalPolicy("sophie").lastActor, s.owner.id);

  const add = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["allowlist"], {
    entry: "recursive delete",
  });
  assert.equal(add.status, 200);
  assert.deepEqual((await add.json()).allowlist, ["recursive delete"]);
  const del = await call(s.owner.id, "DELETE", s.channel.id, s.npc.id, ["allowlist"], {
    entry: "recursive delete",
  });
  assert.equal(del.status, 200);
  const delBody = await del.json();
  assert.deepEqual(delBody.allowlist, []);
  assert.equal(delBody.canManage, true);
  server.approvalPolicy("sophie").policy.cronMode = "deny";
});

test("plugin validation errors pass through", async () => {
  const s = await seed();
  const bad = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["allowlist"], {
    entry: "line one\nline two",
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_allowlist_entry");
  const mode = await call(s.owner.id, "PUT", s.channel.id, s.npc.id, [], { cronMode: "always" });
  assert.equal(mode.status, 400);
  assert.equal((await mode.json()).code, "invalid_field");
});

test("unknown paths are 404", async () => {
  const s = await seed();
  const res = await call(s.owner.id, "GET", s.channel.id, s.npc.id, ["nope"]);
  assert.equal(res.status, 404);
});

test("428 without the capability, even for reading", async () => {
  // Binding caches the plugin info in the gateway row — switch to the old plugin before seeding.
  server.setInfo(OLD_INFO);
  try {
    const s = await seed();
    const res = await call(s.owner.id, "GET", s.channel.id, s.npc.id, []);
    assert.equal(res.status, 428);
    const body = await res.json();
    assert.equal(body.code, "plugin_upgrade_required");
    assert.equal(body.minVersion, "0.18.0");
    assert.deepEqual(body.missing, ["profile_approval_policy"]);
  } finally {
    server.setInfo(FULL_INFO);
  }
});

test("responses never contain the profile key", async () => {
  const s = await seed();
  const text = await (await call(s.owner.id, "GET", s.channel.id, s.npc.id, [])).text();
  assert.ok(!text.includes("profile-key-1234567890"));
});

test("adding a rule from a blocked-run notice marks that notice resolved, and only that one", async () => {
  const s = await seed();
  const { ensureOfficeRoom, appendRoomMessage, recentRoomMessages } =
    await import("@/lib/chat-rooms");
  const office = await ensureOfficeRoom(s.channel.id, s.owner.id);
  const blocked = (patternKey: string) =>
    appendRoomMessage({
      roomId: office.id,
      senderKind: "system",
      senderId: null,
      senderName: "Sophie",
      content: "rm -r /tmp/probe",
      notice: {
        kind: "approval_blocked",
        audience: s.owner.id,
        npcId: s.npc.id,
        npcName: "Sophie",
        source: "cron",
        blockKind: "command",
        tool: "terminal",
        jobId: "job-1",
        patternKey,
      },
    });
  const acted = await blocked("recursive delete");
  const sameRule = await blocked("recursive delete");
  const plain = await appendRoomMessage({
    roomId: office.id,
    senderKind: "system",
    senderId: null,
    senderName: "",
    content: "hello",
  });

  const res = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["allowlist"], {
    entry: "recursive delete",
    noticeMessageId: acted.id,
  });
  assert.equal(res.status, 200);
  // A notice id that is not a blocked-run notice changes nothing, and the add still succeeds.
  const other = await call(s.owner.id, "POST", s.channel.id, s.npc.id, ["allowlist"], {
    entry: "recursive delete",
    noticeMessageId: plain.id,
  });
  assert.equal(other.status, 200);

  const byId = new Map(
    (await recentRoomMessages(office.id, 20, s.owner.id)).map((m) => [m.id, m.notice]),
  );
  const resolved = (id: string) =>
    (byId.get(id) as { resolved?: { allowlisted: string; by: string } } | null)?.resolved;
  assert.deepEqual(
    { allowlisted: resolved(acted.id)?.allowlisted, by: resolved(acted.id)?.by },
    { allowlisted: "recursive delete", by: s.owner.id },
  );
  assert.equal(resolved(sameRule.id), undefined);
  assert.equal(byId.get(plain.id), null);
  server.approvalPolicy("sophie").policy.allowlist = [];
});
