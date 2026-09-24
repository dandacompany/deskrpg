import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedGatewayBoundToChannels,
  seedProfile,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

// Task 6. Deleting a profile is now **firing** — the CASCADE on `npcs.hermes_profile_id` removes
// the NPC rows too. The old response field `unboundNpcs` ("only unbound") is no longer
// true and became `deletedNpcs` + `channels`, and GET provides the same numbers so they can be
// shown before deleting.
setupThrowawaySqlite("profile-usage-delete-test");

async function hiredProfile() {
  const { gatewayId, channelIds, userId } = await seedGatewayBoundToChannels({ channels: 2 });
  const profileId = await seedProfile(gatewayId);
  const { hireProfileIntoBoundChannels } = await import("@/lib/npc-roster");
  await hireProfileIntoBoundChannels(profileId);
  return { gatewayId, channelIds, userId, profileId };
}

test("GET reports how many NPCs in how many channels this profile is out as", async () => {
  const { gatewayId, userId, profileId } = await hiredProfile();
  const { GET } = await import("./[id]/profiles/[profileId]/route");

  const res = await GET(
    new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles/${profileId}`, {
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: gatewayId, profileId }) },
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).usage, { npcs: 2, channels: 2 });
});

test("DELETE returns the numbers of deleted NPCs and channels, and no rows of that profile remain in npcs", async () => {
  const { gatewayId, userId, profileId } = await hiredProfile();
  const { DELETE } = await import("./[id]/profiles/[profileId]/route");

  const res = await DELETE(
    new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles/${profileId}`, {
      method: "DELETE",
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: gatewayId, profileId }) },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deletedNpcs, 2);
  assert.equal(body.channels, 2);

  const { profileUsage } = await import("@/lib/hermes-profiles");
  assert.deepEqual(await profileUsage(profileId), { npcs: 0, channels: 0 });
});

// The canonical form of an appearance is `{ officeLookId, bodyType }` (office-appearance.ts) — use a fixture shaped like
// the one api/characters uses.
const MALE_APPEARANCE = { officeLookId: "office-jun", bodyType: "male" };
const FEMALE_APPEARANCE = { officeLookId: "office-nari", bodyType: "female" };

test("only the owner changes the appearance — shared users get forbidden", async () => {
  const { gatewayId, userId, profileId } = await hiredProfile();
  const { PATCH } = await import("./[id]/profiles/[profileId]/route");
  const patch = (actorId: string, appearance: unknown) =>
    PATCH(
      new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles/${profileId}`, {
        method: "PATCH",
        body: JSON.stringify({ appearance }),
        headers: authHeaders(actorId),
      }),
      { params: Promise.resolve({ id: gatewayId, profileId }) },
    );

  assert.equal((await patch(userId, MALE_APPEARANCE)).status, 200);
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(npcs).where(eq(npcs.hermesProfileId, profileId)).limit(1);
  const roster = await selectChannelNpcs(row.channelId, { roster: true });
  assert.deepEqual(
    (roster.find((n) => n.hermesProfileId === profileId)?.appearance as { bodyType?: string })
      ?.bodyType,
    "male",
    "외형은 프로필이 정본이므로 모든 채널의 NPC 가 함께 바뀐다",
  );

  const { seedUser } = await import("@/test-setup/npc-seed");
  const { createGatewayShare } = await import("@/lib/gateway-resources");
  const other = await seedUser("shared-user");
  const shared = await createGatewayShare({
    ownerUserId: userId,
    gatewayId,
    targetLoginId: other.loginId,
  });
  assert.ok(shared.share, "공유가 실제로 만들어져야 이 테스트가 의미 있다");
  assert.equal((await patch(other.id, FEMALE_APPEARANCE)).status, 403);
});

test("a broken appearance is blocked with 400 — the profile is the source of truth, so every channel would break at once", async () => {
  const { gatewayId, userId, profileId } = await hiredProfile();
  const { PATCH } = await import("./[id]/profiles/[profileId]/route");

  const res = await PATCH(
    new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles/${profileId}`, {
      method: "PATCH",
      body: JSON.stringify({ appearance: "garbage" }),
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: gatewayId, profileId }) },
  );
  const unknownLook = await PATCH(
    new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles/${profileId}`, {
      method: "PATCH",
      body: JSON.stringify({ appearance: { officeLookId: "office-nobody", bodyType: "male" } }),
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: gatewayId, profileId }) },
  );
  assert.equal(unknownLook.status, 400);
  assert.equal((await unknownLook.json()).errorCode, "character_appearance_invalid");
  assert.equal(res.status, 400);
  // Uses the same code as the two api/characters routes — the screen already has the translation.
  assert.equal((await res.json()).errorCode, "character_appearance_invalid");
});

test("GET blocks with 404 a profile that does not belong to the gateway in the URL", async () => {
  const a = await hiredProfile();
  const b = await hiredProfile();
  const { GET } = await import("./[id]/profiles/[profileId]/route");

  // B's profile counts cannot be pried out through A's gateway URL.
  const res = await GET(
    new NextRequest(`http://localhost/api/gateways/${a.gatewayId}/profiles/${b.profileId}`, {
      headers: authHeaders(a.userId),
    }),
    { params: Promise.resolve({ id: a.gatewayId, profileId: b.profileId }) },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).errorCode, "profile_not_found");
});
