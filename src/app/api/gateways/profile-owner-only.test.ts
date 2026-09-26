import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedGatewayBoundToChannels,
  seedProfile,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

// Registering, editing (token, display name) and deleting a profile belong to the gateway owner
// (docs/security.md). A user the gateway is only shared with can see it exists but is refused
// (403); someone with no access at all does not learn it exists (404). Deleting cascades to the
// profile's NPCs in every bound office, so a refused delete must leave them all in place.
setupThrowawaySqlite("profile-owner-only-test");

async function fixture() {
  const {
    gatewayId,
    channelIds,
    userId: ownerId,
  } = await seedGatewayBoundToChannels({
    channels: 2,
  });
  const profileId = await seedProfile(gatewayId);
  const { hireProfileIntoBoundChannels } = await import("@/lib/npc-roster");
  await hireProfileIntoBoundChannels(profileId);

  const { createGatewayShare } = await import("@/lib/gateway-resources");
  const shared = await seedUser("shared-user");
  const created = await createGatewayShare({
    ownerUserId: ownerId,
    gatewayId,
    targetLoginId: shared.loginId,
  });
  assert.ok(created.share, "the share must exist for the 403 cases to mean anything");
  const stranger = await seedUser("stranger");
  return {
    gatewayId,
    channelIds,
    profileId,
    ownerId,
    sharedId: shared.id,
    strangerId: stranger.id,
  };
}

const ctx = (id: string, profileId: string) => ({ params: Promise.resolve({ id, profileId }) });
const url = (id: string, profileId = "") =>
  `http://localhost/api/gateways/${id}/profiles${profileId ? `/${profileId}` : ""}`;

async function patch(gatewayId: string, profileId: string, actorId: string, body: unknown) {
  const { PATCH } = await import("./[id]/profiles/[profileId]/route");
  return PATCH(
    new NextRequest(url(gatewayId, profileId), {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: authHeaders(actorId),
    }),
    ctx(gatewayId, profileId),
  );
}

async function del(gatewayId: string, profileId: string, actorId: string) {
  const { DELETE } = await import("./[id]/profiles/[profileId]/route");
  return DELETE(
    new NextRequest(url(gatewayId, profileId), { method: "DELETE", headers: authHeaders(actorId) }),
    ctx(gatewayId, profileId),
  );
}

async function register(gatewayId: string, actorId: string, profileName: string) {
  const { POST } = await import("./[id]/profiles/route");
  return POST(
    new NextRequest(url(gatewayId), {
      method: "POST",
      body: JSON.stringify({ profileName, token: "profile-token-1234567890" }),
      headers: authHeaders(actorId),
    }),
    { params: Promise.resolve({ id: gatewayId }) },
  );
}

async function profileRow(profileId: string) {
  const { db, hermesProfiles } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(hermesProfiles).where(eq(hermesProfiles.id, profileId));
  return row;
}

test("registering a profile: owner 201, shared user 403, no access 404", async () => {
  const f = await fixture();
  assert.equal((await register(f.gatewayId, f.sharedId, "by-shared")).status, 403);
  assert.equal((await register(f.gatewayId, f.strangerId, "by-stranger")).status, 404);
  assert.equal((await register(f.gatewayId, f.ownerId, "by-owner")).status, 201);
});

for (const [label, body] of [
  ["the token", { token: "replacement-token-1234567890" }],
  ["the display name", { displayName: "Renamed" }],
] as const) {
  test(`changing ${label}: owner 200, shared user 403, no access 404 — refusals change nothing`, async () => {
    const f = await fixture();
    const before = await profileRow(f.profileId);
    assert.equal((await patch(f.gatewayId, f.profileId, f.sharedId, body)).status, 403);
    assert.equal((await patch(f.gatewayId, f.profileId, f.strangerId, body)).status, 404);
    const untouched = await profileRow(f.profileId);
    assert.equal(untouched.tokenEncrypted, before.tokenEncrypted);
    assert.equal(untouched.displayName, before.displayName);
    assert.equal((await patch(f.gatewayId, f.profileId, f.ownerId, body)).status, 200);
  });
}

test("deleting: shared user 403 and no access 404 leave the NPCs and room members in place; owner 200", async () => {
  const f = await fixture();
  const { db, npcs, chatRooms, chatRoomMembers } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const hired = await db.select().from(npcs).where(eq(npcs.hermesProfileId, f.profileId));
  assert.equal(hired.length, 2);
  const [room] = await db
    .insert(chatRooms)
    .values({
      channelId: hired[0].channelId,
      kind: "group",
      name: "planning",
      replyPolicy: "mention",
      createdBy: f.ownerId,
    })
    .returning();
  await db
    .insert(chatRoomMembers)
    .values({ roomId: room.id, memberKind: "npc", memberId: hired[0].id });

  assert.equal((await del(f.gatewayId, f.profileId, f.sharedId)).status, 403);
  assert.equal((await del(f.gatewayId, f.profileId, f.strangerId)).status, 404);
  assert.ok(await profileRow(f.profileId), "the profile row survives a refused delete");
  assert.equal(
    (await db.select().from(npcs).where(eq(npcs.hermesProfileId, f.profileId))).length,
    2,
  );
  assert.equal(
    (await db.select().from(chatRoomMembers).where(eq(chatRoomMembers.roomId, room.id))).length,
    1,
  );

  const res = await del(f.gatewayId, f.profileId, f.ownerId);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deletedNpcs, 2);
});
