import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  seedGatewayBoundToChannels,
  seedProfile,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

setupThrowawaySqlite("gateway-channel-bindings-test");

// Counts statements the SQLite driver prepares — one per query drizzle runs.
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as { prototype: { prepare: (sql: string) => unknown } };
let queries = 0;
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (this: unknown, sql: string) {
  queries += 1;
  return prepare.call(this, sql);
};

async function seed(channels: number, profiles: number) {
  const { gatewayId, channelIds, userId } = await seedGatewayBoundToChannels({ channels });
  const { hireProfileIntoBoundChannels, setNpcActive } = await import("@/lib/npc-roster");
  for (let i = 0; i < profiles; i += 1)
    await hireProfileIntoBoundChannels(await seedProfile(gatewayId));
  const { db, meetingMinutes, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  // A dormant NPC still counts: it is what goes dormant again if the binding is removed.
  const [dormant] = await db
    .select({ id: npcs.id })
    .from(npcs)
    .where(eq(npcs.channelId, channelIds[0]))
    .limit(1);
  await setNpcActive(dormant.id, false);
  await db.insert(meetingMinutes).values([
    { channelId: channelIds[0], topic: "a", transcript: "t" },
    { channelId: channelIds[0], topic: "b", transcript: "t" },
    { channelId: channelIds[1], topic: "c", transcript: "t" },
  ]);
  return { gatewayId, channelIds, userId };
}

test("channel bindings are counted with a fixed number of queries, however many channels are bound", async () => {
  const { listChannelBindingsForGateway } = await import("./gateway-resources");
  const counts: number[] = [];
  for (const channels of [3, 12]) {
    const { gatewayId, userId } = await seed(channels, 4);
    queries = 0;
    const rows = await listChannelBindingsForGateway(gatewayId, userId);
    counts.push(queries);
    assert.equal(rows.length, channels);
  }
  assert.equal(
    counts[0],
    counts[1],
    `query count grew with the channel count: ${counts.join(" → ")}`,
  );
});

test("each channel's NPC count is the roster's count, and meeting minutes are counted per channel", async () => {
  const { gatewayId, channelIds, userId } = await seed(3, 4);
  const { listChannelBindingsForGateway } = await import("./gateway-resources");
  const { selectChannelNpcs } = await import("./npc-projection");
  const rows = await listChannelBindingsForGateway(gatewayId, userId);
  for (const row of rows) {
    assert.equal(row.npcCount, (await selectChannelNpcs(row.channelId, { roster: true })).length);
    assert.equal(row.canUnbind, true);
  }
  const byId = new Map(rows.map((r) => [r.channelId, r]));
  assert.equal(byId.get(channelIds[0])?.npcCount, 4, "the dormant NPC is included");
  assert.equal(byId.get(channelIds[0])?.meetingMinutesCount, 2);
  assert.equal(byId.get(channelIds[1])?.meetingMinutesCount, 1);
  assert.equal(byId.get(channelIds[2])?.meetingMinutesCount, 0);
});
