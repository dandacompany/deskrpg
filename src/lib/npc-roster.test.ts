import assert from "node:assert/strict";
import test from "node:test";

import {
  setupThrowawaySqlite,
  seedChannelWithProfiles,
  seedGatewayBoundToChannels,
  seedProfile,
} from "@/test-setup/npc-seed";
import { buildOfficeEnvironment } from "@/game/three/office-environments";

// `db` is a lazily-initialized singleton, and node:test splits into a separate process per
// file, so setting up a temporary DB once at module top level means every test in this file
// uses that DB.
setupThrowawaySqlite("npc-roster-test");

test("in a channel whose map can't be read, hiring still succeeds and leaves no position assigned", async () => {
  const { hireGatewayProfilesIntoChannel } = await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");

  const { channelId, gatewayId } = await seedChannelWithProfiles({ profiles: 3, placedActive: 0 });
  const first = await hireGatewayProfilesIntoChannel(channelId, gatewayId);
  assert.deepEqual(first, { created: 3, reactivated: 0 });
  const rows = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.positionX === null && r.active));

  const again = await hireGatewayProfilesIntoChannel(channelId, gatewayId);
  assert.deepEqual(again, { created: 0, reactivated: 0 });
  assert.equal((await selectChannelNpcs(channelId, { roster: true })).length, 3);
});

test("connecting creates an employee per profile and seats them at a desk right away", async () => {
  const { hireGatewayProfilesIntoChannel } = await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");
  const { channelId, gatewayId } = await seedChannelWithProfiles({
    profiles: 3,
    mapData: buildOfficeEnvironment("executive"),
  });
  assert.deepEqual(await hireGatewayProfilesIntoChannel(channelId, gatewayId), {
    created: 3,
    reactivated: 0,
  });
  const onMap = await selectChannelNpcs(channelId);
  assert.equal(onMap.length, 3, "자리 없는 직원이 없다 — 전부 맵에 나온다");
});

test("an employee that had no position while asleep gets one back once revived", async () => {
  const { setNpcActive } = await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");
  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { channelId, npcIds } = await seedChannelWithProfiles({
    unplaced: 1,
    mapData: buildOfficeEnvironment("executive"),
  });
  await db.update(npcs).set({ active: false }).where(eq(npcs.id, npcIds[0]));
  await setNpcActive(npcIds[0], true);
  const [row] = await selectChannelNpcs(channelId);
  assert.ok(row && row.positionX !== null);
});

test("reconnecting after dormancy restores the position", async () => {
  const { hireGatewayProfilesIntoChannel, sleepChannelNpcs } = await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");

  const { channelId, gatewayId } = await seedChannelWithProfiles({ placedActive: 1 });
  const [n] = await selectChannelNpcs(channelId, { roster: true });
  await sleepChannelNpcs(channelId, gatewayId);
  assert.equal((await selectChannelNpcs(channelId)).length, 0, "맵에서 빠진다");
  const r = await hireGatewayProfilesIntoChannel(channelId, gatewayId);
  assert.deepEqual(r, { created: 0, reactivated: 1 });
  const [back] = await selectChannelNpcs(channelId);
  assert.equal(back.positionX, n.positionX, "자리가 보존된다");
});

test("a new profile shows up for work in every already-bound channel", async () => {
  const { hireProfileIntoBoundChannels } = await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");

  const { gatewayId, channelIds } = await seedGatewayBoundToChannels({ channels: 2 });
  const profileId = await seedProfile(gatewayId);
  const r = await hireProfileIntoBoundChannels(profileId);
  assert.deepEqual(r, { created: 2 });
  for (const c of channelIds) {
    assert.equal((await selectChannelNpcs(c, { roster: true })).length, 1);
  }
});

test("M3: showing up, leaving, and toggling all refresh updated_at", async () => {
  const { hireGatewayProfilesIntoChannel, sleepChannelNpcs, setNpcActive } =
    await import("./npc-roster");
  const { selectChannelNpcs } = await import("./npc-projection");
  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { isPostgres } = await import("@/db");
  const STALE = (isPostgres
    ? new Date("2020-01-01T00:00:00Z")
    : "2020-01-01T00:00:00.000Z") as unknown as Date;

  // `updated_at` is the criterion migration uses to pick "the most recent one." If a
  // state-changing path leaves it untouched, that judgment ends up made on a stale value.
  const { channelId, gatewayId } = await seedChannelWithProfiles({ placedActive: 1 });
  const [seeded] = await selectChannelNpcs(channelId, { roster: true });

  async function updatedAt(id: string) {
    const [row] = await db
      .select({ updatedAt: npcs.updatedAt })
      .from(npcs)
      .where(eq(npcs.id, id))
      .limit(1);
    return row.updatedAt;
  }

  await db.update(npcs).set({ updatedAt: STALE }).where(eq(npcs.id, seeded.id));
  const stale = await updatedAt(seeded.id);

  await sleepChannelNpcs(channelId, gatewayId);
  const afterSleep = await updatedAt(seeded.id);
  assert.notDeepEqual(afterSleep, stale, "퇴근이 updated_at 을 갱신한다");

  await db.update(npcs).set({ updatedAt: STALE }).where(eq(npcs.id, seeded.id));
  await hireGatewayProfilesIntoChannel(channelId, gatewayId);
  assert.notDeepEqual(await updatedAt(seeded.id), stale, "재출근이 updated_at 을 갱신한다");

  await db.update(npcs).set({ updatedAt: STALE }).where(eq(npcs.id, seeded.id));
  await setNpcActive(seeded.id, false);
  assert.notDeepEqual(await updatedAt(seeded.id), stale, "토글이 updated_at 을 갱신한다");
});
