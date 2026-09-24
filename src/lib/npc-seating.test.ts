import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficeEnvironment } from "@/game/three/office-environments";
import {
  setupThrowawaySqlite,
  seedChannelWithProfiles,
  seedGateway,
  seedChannel,
  seedHermesProfile,
  seedNpc,
  seedUser,
} from "@/test-setup/npc-seed";

setupThrowawaySqlite("npc-seating-test");
const executiveMap = () => buildOfficeEnvironment("executive"); // 3 desk seats (excluding the executive seat)

async function positions(channelId: string) {
  const { selectChannelNpcs } = await import("./npc-projection");
  return selectChannelNpcs(channelId, { roster: true });
}

test("seats unplaced employees in number order, and stands them up once full", async () => {
  const { placeUnplacedNpcs, channelSeats } = await import("./npc-seating");
  const { seatNumberAt } = await import("./seat-assignment");
  const { channelId } = await seedChannelWithProfiles({ unplaced: 6, mapData: executiveMap() });

  assert.deepEqual(await placeUnplacedNpcs(channelId), { seated: 3, standing: 3, failed: 0 });
  const seats = (await channelSeats(channelId))!;
  const rows = await positions(channelId);
  assert.ok(rows.every((r) => Number.isInteger(r.positionX) && Number.isInteger(r.positionY)));
  const numbers = rows.map((r) => seatNumberAt(seats, r.positionX, r.positionY));
  assert.deepEqual(numbers.filter((n) => n !== null).sort(), [1, 2, 3]);
  assert.equal(numbers.filter((n) => n === null).length, 3);

  assert.deepEqual(
    await placeUnplacedNpcs(channelId),
    { seated: 0, standing: 0, failed: 0 },
    "멱등",
  );
});

test("doesn't touch an employee who already has a seat, or a dormant employee", async () => {
  const { placeUnplacedNpcs } = await import("./npc-seating");
  const { channelId } = await seedChannelWithProfiles({
    placedActive: 1,
    dormant: 1,
    unplaced: 1,
    mapData: executiveMap(),
  });
  const before = await positions(channelId);
  await placeUnplacedNpcs(channelId);
  const after = await positions(channelId);
  for (const b of before.filter((r) => r.positionX !== null)) {
    const a = after.find((r) => r.id === b.id)!;
    assert.deepEqual([a.positionX, a.positionY], [b.positionX, b.positionY]);
  }
});

test("a channel whose map can't be read counts as failed and doesn't throw", async () => {
  const { placeUnplacedNpcs } = await import("./npc-seating");
  const { channelId } = await seedChannelWithProfiles({ unplaced: 2 });
  assert.deepEqual(await placeUnplacedNpcs(channelId), { seated: 0, standing: 0, failed: 2 });
});

test("doesn't throw for a nonexistent channel either, and returns failed 0", async () => {
  const { placeUnplacedNpcs } = await import("./npc-seating");
  await assert.doesNotReject(async () => {
    const result = await placeUnplacedNpcs("00000000-0000-0000-0000-000000000000");
    assert.deepEqual(result, { seated: 0, standing: 0, failed: 0 });
  });
});

test("an employee with only positionX and no positionY is treated as unplaced, fills both coordinates, and is counted once", async () => {
  const { placeUnplacedNpcs } = await import("./npc-seating");
  const user = await seedUser("half-placed-owner");
  const gateway = await seedGateway(user.id);
  const channel = await seedChannel(user.id, undefined, executiveMap());
  const profile = await seedHermesProfile(gateway.id);
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    positionX: 3,
    positionY: null,
    active: true,
  });

  const result = await placeUnplacedNpcs(channel.id);
  assert.deepEqual(result, { seated: 1, standing: 0, failed: 0 });

  const [row] = await positions(channel.id);
  assert.equal(row.id, npc.id);
  assert.ok(Number.isInteger(row.positionX) && Number.isInteger(row.positionY));
});

test("logs via console.warn when failed > 0", async () => {
  const { placeUnplacedNpcs } = await import("./npc-seating");
  const { channelId } = await seedChannelWithProfiles({ unplaced: 2 }); // no map -> everyone fails
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => calls.push(args);
  try {
    await placeUnplacedNpcs(channelId);
  } finally {
    console.warn = original;
  }
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "[seating] active NPCs left without a spot" &&
        (args[1] as { failed?: number })?.failed === 2,
    ),
  );
});

test("placeAllUnplacedNpcs processes every channel that has unplaced employees", async () => {
  const { placeAllUnplacedNpcs } = await import("./npc-seating");
  const a = await seedChannelWithProfiles({ unplaced: 1, mapData: executiveMap() });
  const b = await seedChannelWithProfiles({ unplaced: 1, mapData: executiveMap() });
  const result = await placeAllUnplacedNpcs();
  assert.ok(result.channels >= 2 && result.seated >= 2);
  for (const c of [a, b])
    assert.ok((await positions(c.channelId)).every((r) => r.positionX !== null));
});

test("an employee already sitting in the executive seat is moved to a different seat during boot migration", async () => {
  const { placeAllUnplacedNpcs, channelSeats } = await import("./npc-seating");
  const { seatNumberAt } = await import("./seat-assignment");
  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  // Reproduces an employee placed back when the executive seat was seat #1: (4,5) in the executive map.
  const { channelId } = await seedChannelWithProfiles({ unplaced: 1, mapData: executiveMap() });
  await db.update(npcs).set({ positionX: 4, positionY: 5 }).where(eq(npcs.channelId, channelId));

  const result = await placeAllUnplacedNpcs();
  assert.ok(result.seated >= 1, "대표석에서 내려와 빈 좌석에 앉는다");

  const [row] = await positions(channelId);
  assert.notDeepEqual([row.positionX, row.positionY], [4, 5]);
  const seats = (await channelSeats(channelId))!;
  assert.notEqual(seatNumberAt(seats, row.positionX, row.positionY), null, "데스크 좌석에 앉는다");

  const again = await placeAllUnplacedNpcs();
  assert.equal(again.seated + again.standing, 0, "멱등");
});
