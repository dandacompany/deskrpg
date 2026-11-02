import test from "node:test";
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
import { buildOfficeEnvironment } from "@/game/three/office-environments";
import { seatingMapFor } from "@/lib/seat-assignment";
import { registerMapRefreshHandler } from "@/lib/channel-map-refresh";
import { parseDbJson } from "@/lib/db-json";

/**
 * Switching the office layout: `PUT /api/channels/:id` with `{ environmentId }`.
 *
 * The client sends only the environment id — the server rebuilds the map from that environment,
 * re-seats every AI coworker on the new desks and coordinates a map refresh so open rooms reload.
 *
 * Kept at the channels API root: the node test runner reads `[id]` as a character class and would
 * never pick up a `*.test.ts` inside that segment.
 */
setupThrowawaySqlite("channel-environment-switch-test");

async function seedOwnedChannel(environmentId: "tech" | "executive") {
  const user = await seedUser("env-switch");
  const gateway = await seedGateway(user.id);
  const profile = await seedHermesProfile(gateway.id, { profileName: "env-switch-npc" });
  const channel = await seedChannel(
    user.id,
    "Switch office",
    buildOfficeEnvironment(environmentId),
  );
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 1,
    positionY: 1,
  });
  return { channel, npc, userId: user.id };
}

function trackMapRefresh() {
  const events: string[] = [];
  registerMapRefreshHandler(async (action) => {
    events.push(action);
    return action === "begin" ? "lease-1" : null;
  });
  return events;
}

async function updateChannel(userId: string, channelId: string, body: Record<string, unknown>) {
  const { PUT } = await import("./[id]/route");
  const response = await PUT(
    new NextRequest(`http://localhost/api/channels/${channelId}`, {
      method: "PUT",
      headers: authHeaders(userId),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: channelId }) },
  );
  return { response, body: (await response.json()) as Record<string, unknown> };
}

test("환경을 바꾸면 지도가 새로 만들어지고 AI 동료가 새 자리에 앉는다", async () => {
  const { channel, npc, userId } = await seedOwnedChannel("tech");
  const events = trackMapRefresh();

  // `executive` is the smallest room — the regression that matters, because carrying the old
  // map config over left its spawn inside a wall and the meeting map refused the room.
  const { response, body } = await updateChannel(userId, channel.id, {
    environmentId: "executive",
  });
  assert.equal(response.status, 200);

  const updated = body.channel as { environmentId: string; mapData: unknown };
  assert.equal(updated.environmentId, "executive");

  const { db, channels, npcs } = await import("@/db");
  const saved = (await db.select().from(channels)).find((row) => row.id === channel.id);
  assert.ok(saved, "channel row must exist");
  const savedMap = parseDbJson<{ width: number; height: number }>(saved.mapData);
  assert.equal(savedMap?.width, 18);
  assert.equal(savedMap?.height, 18);

  // The map config must travel with the layout: size and a spawn inside the new room.
  const savedConfig = parseDbJson<{
    cols: number;
    rows: number;
    spawnCol: number;
    spawnRow: number;
  }>(saved.mapConfig);
  assert.equal(savedConfig?.cols, 18);
  assert.equal(savedConfig?.rows, 18);
  assert.ok(
    (savedConfig?.spawnCol ?? -1) >= 0 && (savedConfig?.spawnCol ?? 99) < 18,
    "spawnCol must be inside the new map",
  );
  assert.ok(
    (savedConfig?.spawnRow ?? -1) >= 0 && (savedConfig?.spawnRow ?? 99) < 18,
    "spawnRow must be inside the new map",
  );

  const seats = seatingMapFor({ mapData: parseDbJson(saved.mapData) })?.seats ?? [];
  assert.ok(seats.length > 0, "the new map must have desk seats");
  const savedNpc = (await db.select().from(npcs)).find((row) => row.id === npc.id);
  assert.equal(savedNpc?.positionX, seats[0].col);
  assert.equal(savedNpc?.positionY, seats[0].row);
  assert.equal(savedNpc?.direction, "down");

  // The room must be paused before the write and reopened after it.
  assert.deepEqual(events, ["begin", "finish"]);
});

test("알 수 없는 환경은 거부되고 지도는 그대로 남는다", async () => {
  const { channel, userId } = await seedOwnedChannel("tech");
  const events = trackMapRefresh();

  const { response, body } = await updateChannel(userId, channel.id, {
    environmentId: "moon-base",
  });
  assert.equal(response.status, 400);
  assert.equal(body.errorCode, "invalid_environment");

  const { db, channels } = await import("@/db");
  const saved = (await db.select().from(channels)).find((row) => row.id === channel.id);
  const savedMap = parseDbJson<{ width: number; height: number }>(saved?.mapData);
  assert.equal(savedMap?.width, 44, "the tech map must not be rebuilt");
  assert.deepEqual(events, [], "a rejected switch must not pause the room");
});

test("같은 환경을 다시 보내면 지도를 다시 만들지 않는다", async () => {
  const { channel, userId } = await seedOwnedChannel("tech");
  const events = trackMapRefresh();

  const { response, body } = await updateChannel(userId, channel.id, { environmentId: "tech" });
  assert.equal(response.status, 200);
  const updated = body.channel as { environmentId: string };
  assert.equal(updated.environmentId, "tech");
  assert.deepEqual(events, [], "an unchanged environment must not trigger a refresh");
});
