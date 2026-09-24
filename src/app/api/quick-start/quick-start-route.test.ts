import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedGateway,
  seedHermesProfile,
  seedNpc,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

/**
 * Contract 4-B "quick start".
 *
 * The focus of verification is **reuse** — this route makes no new domain rules and
 * calls the character, channel and placement routes as is. So what to check here is
 * "what was created", "does calling it twice not add more", and whether the invariant of exactly one
 * `kind=office` room per channel still holds.
 */
setupThrowawaySqlite("quick-start-route-test");

async function seedDefaultGroupAdmin() {
  const user = await seedUser("quick-start");
  const { db, groups, groupMembers } = await import("@/db");
  const [group] = await db
    .insert(groups)
    .values({
      name: "Default",
      slug: `default-${user.id.slice(0, 8)}`,
      description: "quick start test workspace",
      isDefault: true,
      createdBy: user.id,
    })
    .returning();
  await db.insert(groupMembers).values({ groupId: group.id, userId: user.id, role: "group_admin" });
  return { userId: user.id, groupId: group.id };
}

function quickStartRequest(userId?: string) {
  return new NextRequest("http://localhost/api/quick-start", {
    method: "POST",
    headers: userId ? authHeaders(userId) : { "Content-Type": "application/json" },
  });
}

async function callQuickStart(userId?: string) {
  const { POST } = await import("./route");
  const response = await POST(quickStartRequest(userId));
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function countRows(userId: string) {
  const { db, characters, channels } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const chars = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.userId, userId));
  const chans = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.ownerId, userId));
  return { characters: chars.length, channels: chans.length };
}

test("creates a character and channel when there are none", async () => {
  const { userId } = await seedDefaultGroupAdmin();

  const { response, body } = await callQuickStart(userId);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(typeof body.channelId, "string");
  assert.equal(typeof body.characterId, "string");

  assert.deepEqual(await countRows(userId), { characters: 1, channels: 1 });

  // Hard gate: exactly one kind=office room per channel. Evidence that it went through the channel route's
  // `ensureOfficeRoom` as is.
  const { db, chatRooms } = await import("@/db");
  const { and, eq } = await import("drizzle-orm");
  const offices = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.channelId, body.channelId as string), eq(chatRooms.kind, "office")));
  assert.equal(offices.length, 1);
});

test("reuses the existing character and channel when they already exist", async () => {
  const { userId } = await seedDefaultGroupAdmin();

  const first = await callQuickStart(userId);
  assert.equal(first.response.status, 200);
  const second = await callQuickStart(userId);
  assert.equal(second.response.status, 200);

  assert.equal(second.body.channelId, first.body.channelId, "채널을 다시 만들지 않는다");
  assert.equal(second.body.characterId, first.body.characterId, "캐릭터를 다시 만들지 않는다");
  assert.deepEqual(await countRows(userId), { characters: 1, channels: 1 });
});

test("succeeds even with no gateway at all", async () => {
  const { userId } = await seedDefaultGroupAdmin();

  const { db, gatewayResources } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const owned = await db
    .select({ id: gatewayResources.id })
    .from(gatewayResources)
    .where(eq(gatewayResources.ownerUserId, userId));
  assert.equal(owned.length, 0, "전제: 게이트웨이가 없다");

  const { response, body } = await callQuickStart(userId);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(typeof body.channelId, "string");
});

test("after attaching a gateway and clocking in, they sit at desk seats right away", async () => {
  const { userId } = await seedDefaultGroupAdmin();
  const first = await callQuickStart(userId);
  const channelId = first.body.channelId as string;

  // Attach a gateway and clock the profile in — the hiring path already finishes placement.
  const gateway = await seedGateway(userId);
  await seedHermesProfile(gateway.id);
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  const { hireGatewayProfilesIntoChannel } = await import("@/lib/npc-roster");
  await bindGatewayToChannel({ channelId, gatewayId: gateway.id, boundByUserId: userId });
  await hireGatewayProfilesIntoChannel(channelId, gateway.id);

  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const after = await db.select().from(npcs).where(eq(npcs.channelId, channelId));
  assert.equal(after.length, 1);
  assert.ok(
    Number.isInteger(after[0].positionX) && Number.isInteger(after[0].positionY),
    "데스크 좌석 또는 서는 칸에 이미 앉아 있다",
  );
});

test("quick start is the safety net for employees created without a seat before this feature", async () => {
  const { userId } = await seedDefaultGroupAdmin();
  const first = await callQuickStart(userId);
  const channelId = first.body.channelId as string;

  // Plant a seatless NPC directly without going through `hireGatewayProfilesIntoChannel` —
  // mimicking data from before this feature.
  const gateway = await seedGateway(userId);
  const profile = await seedHermesProfile(gateway.id);
  const { bindGatewayToChannel } = await import("@/lib/gateway-resources");
  await bindGatewayToChannel({ channelId, gatewayId: gateway.id, boundByUserId: userId });
  await seedNpc({ channelId, hermesProfileId: profile.id, active: true });

  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const before = await db.select().from(npcs).where(eq(npcs.channelId, channelId));
  assert.equal(before.length, 1);
  assert.equal(before[0].positionX, null, "전제: 아직 자리가 없다");

  const second = await callQuickStart(userId);
  assert.equal(second.response.status, 200);

  const after = await db.select().from(npcs).where(eq(npcs.channelId, channelId));
  assert.equal(after.length, 1, "NPC 를 새로 만들지 않는다");
  assert.ok(
    Number.isInteger(after[0].positionX) && Number.isInteger(after[0].positionY),
    "데스크 좌석 또는 서는 칸에 앉았다",
  );
});

test("rejects unauthenticated users", async () => {
  const { response, body } = await callQuickStart();
  assert.equal(response.status, 401);
  assert.equal(body.errorCode, "unauthorized");
});

test("the response has only two identifiers and no token", async () => {
  const { userId } = await seedDefaultGroupAdmin();
  const gateway = await seedGateway(userId);
  await seedHermesProfile(gateway.id);

  const { response, body } = await callQuickStart(userId);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["channelId", "characterId"]);

  const serialized = JSON.stringify(body);
  for (const secret of ["token", "Token", "gateway-owner-key", "profile-key", "tokenEncrypted"]) {
    assert.ok(!serialized.includes(secret), `응답에 ${secret} 이(가) 있으면 안 된다`);
  }
});
