import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setupThrowawaySqlite, seedChannel, seedGateway, seedUser } from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

setupThrowawaySqlite("project-archive");
const servers: FakePluginServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const BASE_CAPABILITIES = [
  "kanban",
  "cron",
  "events",
  "swarm",
  "kanban_views",
  "initial_status",
  "kanban_review_policy_v1",
  "event_cursor_handoff",
  "card_proposals",
];

type FakeClient = Awaited<ReturnType<typeof fixture>>["client"];

async function fixture({ archive = true } = {}) {
  const server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: {},
    info: {
      capabilities: archive ? [...BASE_CAPABILITIES, "board_archive"] : BASE_CAPABILITIES,
    },
  });
  servers.push(server);
  const user = await seedUser("archive");
  const gateway = await seedGateway(user.id, server.baseUrl);
  const channel = await seedChannel(user.id, "archive");
  const { bindGatewayToChannel } = await import("./gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: user.id,
  });
  const { ensureChannelBoard, listChannelBoards, resolveChannelBoard } =
    await import("./kanban-boards");
  await ensureChannelBoard(channel.id, undefined, "archive-second");
  const [carrier, second] = await listChannelBoards(channel.id);
  const { ensureProjectRow } = await import("./project-registry");
  const carrierProject = await ensureProjectRow(carrier);
  const secondProject = await ensureProjectRow(second);
  const resolved = await resolveChannelBoard(channel.id);
  assert.ok(resolved.ok);
  return {
    server,
    channel,
    carrier,
    second,
    carrierProject,
    secondProject,
    client: resolved.ownerClient,
  };
}

/** A card the gateway worker is running: created, made ready, then picked up by dispatch. */
async function startRunningCard(client: FakeClient, board: string) {
  const created = await client.kanban.createTask(board, { title: "In flight", assignee: "alice" });
  assert.ok(created.ok);
  const ready = await client.kanban.updateTask(board, created.data.task.id, { status: "ready" });
  assert.ok(ready.ok);
  const spawned = await client.kanban.dispatch(board);
  assert.ok(spawned.ok && spawned.data.spawned.length === 1);
}

function archivePatches(server: FakePluginServer) {
  return server
    .requests()
    .filter((r) => r.method === "PATCH" && r.path.startsWith("/deskrpg/kanban/boards/"))
    .filter((r) => r.json && typeof r.json === "object" && "archived" in r.json)
    .map((r) => ({ path: r.path, archived: (r.json as { archived: boolean }).archived }));
}

test("archiving a project archives its Hermes board when the plugin supports it", async () => {
  const f = await fixture();
  const { archiveChannelProject, readProject } = await import("./project-registry");
  await archiveChannelProject(f.channel.id, f.secondProject.id, "completed");
  assert.deepEqual(archivePatches(f.server), [
    { path: `/deskrpg/kanban/boards/${encodeURIComponent(f.second.boardSlug)}`, archived: true },
  ]);
  assert.equal((await readProject(f.channel.id, f.secondProject.id)).status, "completed");
});

test("the project list still names an archived project from its Hermes board", async () => {
  const f = await fixture();
  await f.client.kanban.updateBoard(f.second.boardSlug, { name: "Launch plan" });
  const { archiveChannelProject, listChannelProjects } = await import("./project-registry");
  await archiveChannelProject(f.channel.id, f.secondProject.id, "cancelled");
  const projects = await listChannelProjects(f.channel.id, f.client);
  const archived = projects.find((p) => p.id === f.secondProject.id);
  assert.equal(archived?.status, "cancelled");
  assert.equal(archived?.name, "Launch plan");
});

test("a board with running cards refuses the archive and leaves the project and carrier untouched", async () => {
  const f = await fixture();
  await startRunningCard(f.client, f.carrier.boardSlug);
  const { archiveChannelProject, readProject } = await import("./project-registry");
  await assert.rejects(
    () => archiveChannelProject(f.channel.id, f.carrierProject.id, "completed"),
    {
      status: 409,
      code: "board_has_running_cards",
      details: { running: 1 },
    },
  );
  assert.equal((await readProject(f.channel.id, f.carrierProject.id)).status, "planned");
  const { listChannelBoards } = await import("./kanban-boards");
  const rows = await listChannelBoards(f.channel.id);
  assert.equal(rows.find((r) => r.isEventCarrier)?.id, f.carrier.id);
});

test("the archive route answers a running-card refusal with its code and count", async () => {
  const f = await fixture();
  await startRunningCard(f.client, f.second.boardSlug);
  const { NextRequest } = await import("next/server");
  const { postProjectArchive } = await import("./project-routes");
  const res = await postProjectArchive(
    new NextRequest("http://localhost/archive", {
      method: "POST",
      headers: { "x-user-id": f.channel.ownerId },
      body: JSON.stringify({ status: "completed" }),
    }),
    f.channel.id,
    f.secondProject.id,
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "board_has_running_cards");
  assert.equal(body.running, 1);
});

test("an old plugin without board_archive keeps the metadata-only archive", async () => {
  const f = await fixture({ archive: false });
  const { archiveChannelProject, readProject } = await import("./project-registry");
  await archiveChannelProject(f.channel.id, f.secondProject.id, "completed");
  assert.deepEqual(archivePatches(f.server), []);
  assert.equal((await readProject(f.channel.id, f.secondProject.id)).status, "completed");
});

test("reopening an archived project unarchives its Hermes board", async () => {
  const f = await fixture();
  const { archiveChannelProject, updateChannelProject, readProject } =
    await import("./project-registry");
  await archiveChannelProject(f.channel.id, f.secondProject.id, "completed");
  await updateChannelProject(f.channel.id, f.secondProject.id, f.client, { status: "in_progress" });
  assert.deepEqual(
    archivePatches(f.server).map((p) => p.archived),
    [true, false],
  );
  assert.equal((await readProject(f.channel.id, f.secondProject.id)).status, "in_progress");
});

test("a carrier handoff failure after the Hermes archive puts the board back", async () => {
  const f = await fixture();
  f.server.failNext("/deskrpg/events/handoff", 1);
  const { archiveChannelProject, readProject } = await import("./project-registry");
  await assert.rejects(() => archiveChannelProject(f.channel.id, f.carrierProject.id, "completed"));
  assert.deepEqual(
    archivePatches(f.server).map((p) => p.archived),
    [true, false],
  );
  assert.equal((await readProject(f.channel.id, f.carrierProject.id)).status, "planned");
});
