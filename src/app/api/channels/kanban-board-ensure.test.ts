import { after, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";
import {
  authHeaders,
  seedChannel,
  seedGateway,
  seedUser,
  setupThrowawaySqlite,
  startStubHermesGateway,
} from "@/test-setup/npc-seed";

// T4. The moment a channel is bound to a gateway, DeskRPG secures a kanban board on that gateway.
//
// - Hermes is the source of truth for boards. All we keep here is the (channel, gateway, slug) link record.
// - A failure to secure does not block binding — the reason goes to `last_error` and it retries on the next entry.
// - When the gateway changes, cards and cron jobs stay on the previous gateway (a warning is included in the response).
//
// Kept outside the `[id]` segment — the node test runner mistakes `[id]` for a character class and misses
// the *.test.ts inside it (same reason as gateway-bind-hires.test.ts).
setupThrowawaySqlite("kanban-board-ensure-test");

// Must match the owner key `seedGateway` plants so the fake server opens the owner paths.
const OWNER_TOKEN = "gateway-owner-key-1234567890";
const SLUG_RE = /^deskrpg-[0-9a-f]{32}$/;

const servers: FakePluginServer[] = [];
async function startPlugin(info?: { version?: string; capabilities?: string[] }) {
  const server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: { sophie: "profile-key-1234567890" },
    info,
  });
  servers.push(server);
  return server;
}
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function bindRequest(channelId: string, userId: string, gatewayId: string) {
  return new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
    method: "PUT",
    body: JSON.stringify({ gatewayId }),
    headers: authHeaders(userId),
  });
}

async function bind(channelId: string, userId: string, gatewayId: string) {
  const { PUT } = await import("./[id]/gateway/route");
  return PUT(bindRequest(channelId, userId, gatewayId), {
    params: Promise.resolve({ id: channelId }),
  });
}

async function rename(channelId: string, userId: string, name: string) {
  const { PUT } = await import("./[id]/route");
  return PUT(
    new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: channelId }) },
  );
}

async function readBoardRow(channelId: string) {
  const { getChannelBoard } = await import("@/lib/kanban-boards");
  return getChannelBoard(channelId);
}

function boardRequests(server: FakePluginServer) {
  return server.requests().filter((r) => r.path.startsWith("/deskrpg/kanban/boards"));
}

test("channelBoardSlug — `deskrpg-` + the 32-character lowercase UUID without hyphens", async () => {
  const { channelBoardSlug } = await import("@/lib/kanban-boards");
  assert.equal(
    channelBoardSlug("0F8FAD5B-D9CB-469F-A165-70867728950E"),
    "deskrpg-0f8fad5bd9cb469fa16570867728950e",
  );
  assert.match(channelBoardSlug(crypto.randomUUID()), SLUG_RE);
});

test("the first binding creates the board — slug rule, display name = channel name, link row recorded", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "기획팀 채널");

  const res = await bind(channel.id, user.id, gateway.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warning, undefined, "최초 바인딩에는 경고가 없다");

  const created = boardRequests(plugin).filter((r) => r.method === "POST");
  assert.equal(created.length, 1, "POST /deskrpg/kanban/boards 한 번");
  const sent = created[0].json as { slug: string; name: string };
  assert.match(sent.slug, SLUG_RE);
  assert.equal(sent.slug, `deskrpg-${channel.id.replace(/-/g, "").toLowerCase()}`);
  assert.equal(sent.name, "기획팀 채널");
  assert.equal(created[0].status, 201);

  const row = await readBoardRow(channel.id);
  assert.ok(row, "channel_kanban_boards 행이 있어야 한다");
  assert.equal(row.gatewayId, gateway.id);
  assert.equal(row.boardSlug, sent.slug);
  assert.equal(row.lastError, null);
  assert.ok(row.boardNameSyncedAt, "이름을 맞춘 시각이 찍힌다");
});

test("rebinding to the same gateway reuses the board — no duplicate creation", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "재사용 채널");

  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);
  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);

  const { ensureChannelBoard } = await import("@/lib/kanban-boards");
  const again = await ensureChannelBoard(channel.id);
  assert.equal(again.ok, true, "멱등 — 다시 불러도 성공");

  const posts = boardRequests(plugin).filter((r) => r.method === "POST");
  assert.ok(posts.length >= 2, "재시도마다 POST 는 나가지만");
  assert.deepEqual(
    posts.slice(1).map((r) => r.status),
    posts.slice(1).map(() => 200),
    "두 번째부터는 기존 보드를 200 으로 돌려준다",
  );

  const { createOwnerPluginClient } = await import("@/lib/hermes/plugin-client");
  const client = createOwnerPluginClient({ baseUrl: plugin.baseUrl, ownerToken: OWNER_TOKEN });
  const boards = await client.kanban.listBoards();
  assert.ok(boards.ok);
  assert.equal(boards.data.boards.length, 1, "보드는 하나뿐");
});

test("without the plugin (404) binding still succeeds and the row records the reason — no kanban calls", async () => {
  const stub = await startStubHermesGateway();
  try {
    const user = await seedUser("board-owner");
    const gateway = await seedGateway(user.id, stub.baseUrl);
    const channel = await seedChannel(user.id, "플러그인 없음");

    const res = await bind(channel.id, user.id, gateway.id);
    assert.equal(res.status, 200, "확보 실패는 바인딩을 막지 않는다");

    const row = await readBoardRow(channel.id);
    assert.ok(row);
    assert.equal(row.gatewayId, gateway.id);
    assert.match(row.boardSlug, SLUG_RE, "slug 는 계산된 값으로 둔다");
    assert.equal(row.lastError, "plugin_absent");
    assert.equal(row.boardNameSyncedAt, null);
  } finally {
    stub.close();
  }
});

test("with a wrong owner key (401) binding succeeds and last_error is plugin_unauthorized", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const { db, gatewayResources } = await import("@/db");
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: user.id,
      displayName: "Wrong Key Gateway",
      baseUrl: plugin.baseUrl,
      tokenEncrypted: encryptGatewayToken("not-the-owner-key"),
    })
    .returning();
  const channel = await seedChannel(user.id, "권한 없음");

  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.equal(row.lastError, "plugin_unauthorized");
  assert.equal(boardRequests(plugin).length, 0, "칸반 경로는 건드리지 않는다");
});

test("below plugin 0.6.0 it does not try to secure and records plugin_upgrade_required", async () => {
  const plugin = await startPlugin({ version: "0.5.9" });
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "버전 미달");

  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.equal(row.lastError, "plugin_upgrade_required");
  assert.equal(boardRequests(plugin).length, 0, "칸반 경로는 건드리지 않는다");

  // The basis of the verdict (the info block) stays in the gateway cache.
  const { db, gatewayResources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [cached] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, gateway.id));
  assert.equal(cached.pluginStatus, "plugin_ready");
  assert.equal(cached.pluginVersion, "0.5.9");
  assert.ok(cached.pluginInfoJson, "plugin_info_json 이 채워진다");
  assert.deepEqual(JSON.parse(cached.pluginInfoJson as string).capabilities, [
    "kanban",
    "cron",
    "events",
    "swarm",
    "kanban_views",
    "initial_status",
    "kanban_review_policy_v1",
    "event_cursor_handoff",
    "card_proposals",
  ]);
});

test("a fresh plugin_ready cache without info_json is reprobed, then the board is secured", async () => {
  // The cache shape the setup wizard (setup/service.ts) used to leave — only status/version, no info.
  // Reading it as "contract not met" blocks board securing for an hour (flagged by independent review).
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "캐시만 있는 채널");
  const { db, gatewayResources, nowForDb } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db
    .update(gatewayResources)
    .set({
      pluginStatus: "plugin_ready",
      pluginVersion: "0.6.0",
      pluginCheckedAt: nowForDb(),
      pluginInfoJson: null,
    })
    .where(eq(gatewayResources.id, gateway.id));

  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);

  const paths = plugin.requests().map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes("GET /deskrpg/info"), "info 를 다시 찌른다");
  assert.ok(paths.includes("POST /deskrpg/kanban/boards"), "그 뒤 보드를 확보한다");

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.equal(row.lastError, null);

  const [cached] = await db
    .select()
    .from(gatewayResources)
    .where(eq(gatewayResources.id, gateway.id));
  assert.ok(cached.pluginInfoJson, "재프로브 결과의 info 가 캐시에 채워진다");
});

test("switching gateways secures a board on the new gateway and the old board remains + warning", async () => {
  const pluginA = await startPlugin();
  const pluginB = await startPlugin();
  const user = await seedUser("board-owner");
  const gatewayA = await seedGateway(user.id, pluginA.baseUrl);
  const gatewayB = await seedGateway(user.id, pluginB.baseUrl);
  const channel = await seedChannel(user.id, "이사 가는 채널");

  assert.equal((await bind(channel.id, user.id, gatewayA.id)).status, 200);
  const res = await bind(channel.id, user.id, gatewayB.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warning, "previous_board_retained");

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.equal(row.gatewayId, gatewayB.id, "행은 새 게이트웨이로 대체된다");
  assert.equal(row.lastError, null);

  assert.equal(boardRequests(pluginB).filter((r) => r.method === "POST").length, 1);
  assert.equal(
    boardRequests(pluginA).filter((r) => r.method === "DELETE").length,
    0,
    "이전 게이트웨이의 보드는 지우지 않는다",
  );

  // Re-saving the same gateway is not a switch — no warning.
  const same = await (await bind(channel.id, user.id, gatewayB.id)).json();
  assert.equal(same.warning, undefined);
});

test("disconnecting the gateway leaves the link row (the board also stays in Hermes)", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "해제 채널");
  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);

  const { DELETE } = await import("./[id]/gateway/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/channels/${channel.id}/gateway`, {
      method: "DELETE",
      headers: authHeaders(user.id),
    }),
    { params: Promise.resolve({ id: channel.id }) },
  );
  assert.equal(res.status, 200);
  assert.ok(await readBoardRow(channel.id), "연결 기록은 유지한다");
  assert.equal(boardRequests(plugin).filter((r) => r.method === "DELETE").length, 0);
});

test("renaming the channel matches the board name with a PATCH and updates synced_at", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "옛 이름");
  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);
  const before = (await readBoardRow(channel.id))!.boardNameSyncedAt as unknown as string;
  await new Promise((r) => setTimeout(r, 5));

  const res = await rename(channel.id, user.id, "새 이름");
  assert.equal(res.status, 200);

  const patch = plugin.lastRequest();
  assert.ok(patch);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, `/deskrpg/kanban/boards/${channelBoardSlugOf(channel.id)}`);
  assert.deepEqual(patch.json, { name: "새 이름" });

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.notEqual(row.boardNameSyncedAt, before, "synced_at 이 앞으로 간다");
  assert.equal(row.lastError, null);

  const { createOwnerPluginClient } = await import("@/lib/hermes/plugin-client");
  const client = createOwnerPluginClient({ baseUrl: plugin.baseUrl, ownerToken: OWNER_TOKEN });
  const boards = await client.kanban.listBoards();
  assert.ok(boards.ok);
  assert.equal(boards.data.boards[0].name, "새 이름");
});

test("a PUT with an unchanged name does not touch the board", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "같은 이름");
  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);
  const countBefore = plugin.requests().length;

  assert.equal((await rename(channel.id, user.id, "같은 이름")).status, 200);
  assert.equal(plugin.requests().length, countBefore, "요청이 나가지 않는다");
});

test("if the board name sync fails, the channel rename is still 200 and synced_at stays", async () => {
  const plugin = await startPlugin();
  const user = await seedUser("board-owner");
  const gateway = await seedGateway(user.id, plugin.baseUrl);
  const channel = await seedChannel(user.id, "끊길 채널");
  assert.equal((await bind(channel.id, user.id, gateway.id)).status, 200);
  const before = (await readBoardRow(channel.id))!.boardNameSyncedAt;

  // The gateway dies. The plugin verdict cache is still fresh, so it gets as far as the PATCH and fails there.
  await plugin.close();
  servers.splice(servers.indexOf(plugin), 1);

  const res = await rename(channel.id, user.id, "바뀐 이름");
  assert.equal(res.status, 200, "개명은 성공한다");
  assert.equal((await res.json()).channel.name, "바뀐 이름");

  const row = await readBoardRow(channel.id);
  assert.ok(row);
  assert.equal(row.boardNameSyncedAt, before, "synced_at 은 바뀌지 않는다");
  assert.equal(row.lastError, "unreachable", "다음 폴링이 재시도할 이유를 남긴다");
});

function channelBoardSlugOf(channelId: string) {
  return `deskrpg-${channelId.replace(/-/g, "").toLowerCase()}`;
}
