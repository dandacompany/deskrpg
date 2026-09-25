import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setupThrowawaySqlite, seedChannel, seedGateway, seedUser } from "@/test-setup/npc-seed";
import { startFakePluginServer, type FakePluginServer } from "@/lib/hermes/fake-plugin-server";

setupThrowawaySqlite("project-target-date");
const servers: FakePluginServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function fixture() {
  const server = await startFakePluginServer({
    ownerToken: "gateway-owner-key-1234567890",
    profileTokens: {},
  });
  servers.push(server);
  const user = await seedUser("target-date");
  const gateway = await seedGateway(user.id, server.baseUrl);
  const channel = await seedChannel(user.id, "target-date");
  const { bindGatewayToChannel } = await import("./gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: user.id,
  });
  const { ensureChannelBoard, listChannelBoards } = await import("./kanban-boards");
  await ensureChannelBoard(channel.id);
  const [board] = await listChannelBoards(channel.id);
  const { ensureProjectRow } = await import("./project-registry");
  const project = await ensureProjectRow(board);
  return { channel, project };
}

async function patch(f: Awaited<ReturnType<typeof fixture>>, userId: string, body: unknown) {
  const { NextRequest } = await import("next/server");
  const { patchProject } = await import("./project-routes");
  return patchProject(
    new NextRequest("http://localhost/project", {
      method: "PATCH",
      headers: { "x-user-id": userId },
      body: JSON.stringify(body),
    }),
    f.channel.id,
    f.project.id,
  );
}

test("the owner sets and then clears a project's target date", async () => {
  const f = await fixture();
  const set = await patch(f, f.channel.ownerId, { targetDate: "2026-10-31" });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).project.targetDate, "2026-10-31");
  const cleared = await patch(f, f.channel.ownerId, { targetDate: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).project.targetDate, null);
});

for (const bad of [
  "2026-02-30",
  "2026-13-01",
  "tomorrow",
  "2026-1-5",
  "2026-10-31T00:00:00Z",
  "",
]) {
  test(`a target date of ${JSON.stringify(bad)} is refused with 400`, async () => {
    const f = await fixture();
    const res = await patch(f, f.channel.ownerId, { targetDate: bad });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_target_date");
    const { readProject } = await import("./project-registry");
    assert.equal((await readProject(f.channel.id, f.project.id)).targetDate, null);
  });
}

test("a member can't change the target date", async () => {
  const f = await fixture();
  const member = await seedUser("target-member");
  const { db, channelMembers } = await import("@/db");
  await db
    .insert(channelMembers)
    .values({ channelId: f.channel.id, userId: member.id, role: "member" });
  const res = await patch(f, member.id, { targetDate: "2026-10-31" });
  assert.equal(res.status, 403);
});
