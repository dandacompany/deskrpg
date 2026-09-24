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

// T6. `createSwarm`/`getBlackboard` — the only authorization boundary for this feature.
// The client sends only NPC ids; the server translates the channel's active NPCs to
// profile names and sends that to Hermes. If even one is outside the channel, nothing
// is created (no partial creation). The capability check (428) comes before NPC resolution.
setupThrowawaySqlite("kanban-routes-swarm-test");

const OWNER_TOKEN = "gateway-owner-key-1234567890";
const PROFILE_TOKEN = "profile-key-1234567890";

let server: FakePluginServer;

before(async () => {
  server = await startFakePluginServer({
    ownerToken: OWNER_TOKEN,
    profileTokens: {
      nova: PROFILE_TOKEN,
      luna: PROFILE_TOKEN,
      sophie: PROFILE_TOKEN,
      dante: PROFILE_TOKEN,
    },
  });
  const { registerAutomationHooks } = await import("@/lib/automation-registry");
  registerAutomationHooks({
    pollNow: async () => null,
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: () => {},
  });
});

after(async () => {
  const { resetAutomationHooksForTests } = await import("@/lib/automation-registry");
  resetAutomationHooksForTests();
  await server.close();
});

const base = (channelId: string) => `http://localhost/api/channels/${channelId}/kanban`;

function req(userId: string, method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: authHeaders(userId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function swarmRequests() {
  return server
    .requests()
    .filter((r) => r.method === "POST" && r.path.startsWith("/deskrpg/kanban/swarm"));
}

/**
 * Creates one channel + a gateway pointing at the fake plugin server (owner = channel
 * owner) + active NPCs in `names` order. Passing `capabilities` narrows the plugin
 * contract to that value for this test (used to reproduce swarm-gate failures).
 */
async function seedChannelWithNpcs(names: string[], opts: { capabilities?: string[] } = {}) {
  server.reset();
  if (opts.capabilities) {
    server.setInfo({ capabilities: opts.capabilities });
  } else {
    server.setInfo({ capabilities: ["kanban", "cron", "events", "swarm"] });
  }

  const owner = await seedUser("swarm-owner");
  const gateway = await seedGateway(owner.id, server.baseUrl);
  const channel = await seedChannel(owner.id, "스웜 채널");
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({
    channelId: channel.id,
    gatewayId: gateway.id,
    boundByUserId: owner.id,
  });

  const npcIds: Record<string, string> = {};
  let column = 0;
  for (const name of names) {
    const profile = await seedHermesProfile(gateway.id, { profileName: name });
    const npc = await seedNpc({
      channelId: channel.id,
      hermesProfileId: profile.id,
      positionX: column++,
      positionY: 0,
    });
    npcIds[name] = npc.id;
  }

  return {
    ownerId: owner.id,
    channelId: channel.id,
    npcIds,
    fakePlugin: {
      lastSwarmBody: () => swarmRequests().at(-1)?.json as Record<string, unknown> | undefined,
      swarmCallCount: () => swarmRequests().length,
    },
  };
}

type SwarmCtx = Awaited<ReturnType<typeof seedChannelWithNpcs>>;

function postRequest(ctx: SwarmCtx, body: unknown) {
  return req(ctx.ownerId, "POST", `${base(ctx.channelId)}/swarm`, body);
}

function getRequest(ctx: SwarmCtx, taskId: string) {
  return req(ctx.ownerId, "GET", `${base(ctx.channelId)}/tasks/${taskId}/blackboard`);
}

test("a new swarm creates no card and returns 428 when there is no policy contract", async () => {
  const { createSwarm } = await import("@/lib/kanban-routes");
  const ctx = await seedChannelWithNpcs(["nova", "sophie", "dante"]);
  const res = await createSwarm(
    postRequest(ctx, {
      goal: "목표",
      workers: [{ npcId: ctx.npcIds.nova, title: "조사" }],
      verifierNpcId: ctx.npcIds.sophie,
      synthesizerNpcId: ctx.npcIds.dante,
    }),
    ctx.channelId,
  );
  assert.equal(res.status, 428);
  assert.equal((await res.json()).code, "swarm_review_policy_unsupported");
  assert.equal(ctx.fakePlugin.swarmCallCount(), 0);
});

test("if the plugin cannot do swarm, getBlackboard also returns 428", async () => {
  // Same gate as createSwarm. The plugin-contract verdict is cached for 1 hour per
  // gateway (R5 · automation-gate.ts), so creating a taskId first on a capable channel
  // and then just flipping the cache and re-querying would still return "swarm present"
  // from the cache and miss this gate. So, the same way as the createSwarm 428 test,
  // this builds a channel **without swarm from the start** and checks only that the gate
  // fires before NPC resolution (the taskId doesn't need to exist — the gate blocks
  // before that).
  const { getBlackboard } = await import("@/lib/kanban-routes");
  const ctx = await seedChannelWithNpcs(["nova", "sophie", "dante"], {
    capabilities: ["kanban", "cron", "events"],
  });
  const res = await getBlackboard(getRequest(ctx, "any-task-id"), ctx.channelId, "any-task-id");
  assert.equal(res.status, 428);
  const body = await res.json();
  assert.equal(body.code, "plugin_upgrade_required");
  assert.deepEqual(body.missing, ["swarm"]);
});

test("returns the blackboard as-is", async () => {
  const { getBlackboard } = await import("@/lib/kanban-routes");
  const ctx = await seedChannelWithNpcs(["nova", "sophie", "dante"]);
  const { resolveKanbanChannelContext } = await import("@/lib/kanban-access");
  const resolved = await resolveKanbanChannelContext({
    userId: ctx.ownerId,
    channelId: ctx.channelId,
  });
  assert.ok(resolved.ok);
  // Seed a swarm that existed before the upgrade into the fake Hermes.
  const created = await resolved.ctx.client.kanban.createSwarm(resolved.ctx.boardSlug, {
    goal: "기존",
    workers: [{ profile: "nova", title: "조사" }],
    verifier: "sophie",
    synthesizer: "dante",
  });
  assert.ok(created.ok);
  const { root_id } = created.data;
  const res = await getBlackboard(getRequest(ctx, root_id), ctx.channelId, root_id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.blackboard.topology, "object");
});
