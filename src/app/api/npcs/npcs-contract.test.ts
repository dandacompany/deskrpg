import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedChannelWithProfiles,
  seedUser,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";
import { buildOfficeEnvironment } from "@/game/three/office-environments";

// Pin the contract of `GET /api/npcs?channelId=`. The map simulation consumes this response as is —
// if the shape silently changes the map breaks, and that only shows up in the browser.
//
// `db` is a lazily initialized singleton and node:test splits processes per file, so grabbing a temporary DB
// once at the top of the module makes every test in this file use that DB.
setupThrowawaySqlite("npcs-contract-test");

type NpcBody = {
  npcs: Array<{
    id: string;
    name: string;
    positionX: number | null;
    positionY: number | null;
    appearance: unknown;
    adapterType: string;
    hermesProfileId: string;
    active?: boolean;
    placed?: boolean;
  }>;
};

async function rawGet(query: string, userId: string) {
  const { GET } = await import("./route");
  return GET(
    new NextRequest(`http://localhost/api/npcs?${query}`, { headers: authHeaders(userId) }),
  );
}

async function get(query: string, userId: string): Promise<NpcBody> {
  const res = await rawGet(query, userId);
  assert.equal(res.status, 200);
  return (await res.json()) as NpcBody;
}

test("called without roster, NPCs without a seat or asleep never appear", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    placedActive: 1,
    unplaced: 1,
    dormant: 1,
  });

  const body = await get(`channelId=${channelId}`, userId);

  assert.equal(body.npcs.length, 1);
  for (const n of body.npcs) {
    assert.notEqual(
      n.positionX,
      null,
      "시뮬레이션이 positionX*TILE_SIZE 를 바로 계산한다 — null 이 새면 NaN 좌표다",
    );
    assert.notEqual(n.positionY, null);
    assert.equal(n.active, undefined, "roster 없이 부르면 active/placed 는 실리지 않는다");
    assert.equal(n.placed, undefined);
  }
});

test("with roster=1 all three appear and placed tells them apart", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    placedActive: 1,
    unplaced: 1,
    dormant: 1,
  });

  const body = await get(`channelId=${channelId}&roster=1`, userId);

  assert.equal(body.npcs.length, 3);
  assert.deepEqual(body.npcs.map((n) => `${n.placed}/${n.active}`).sort(), [
    "false/true",
    "true/false",
    "true/true",
  ]);
});

test("the name in the response is the profile display name — not the old value of npcs.name", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    placedActive: 1,
    staleNpcName: "옛이름",
    displayName: "올리버",
  });

  const body = await get(`channelId=${channelId}`, userId);

  assert.equal(body.npcs.length, 1);
  assert.equal(body.npcs[0].name, "올리버");
});

test("calling without channelId is 400 — NPCs of all channels are not leaked", async () => {
  const { GET } = await import("./route");
  const user = await seedUser("no-channel");
  const res = await GET(
    new NextRequest("http://localhost/api/npcs", { headers: authHeaders(user.id) }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { errorCode: string };
  assert.equal(body.errorCode, "channel_id_required");
});

// I6: roster=1 carries `profile.{gatewayId, profileName, displayName, ownerUserId}`.
// Any logged-in user who only knows a channel UUID must not be able to read which personas, owned by whom and how many,
// are out in someone else's office.
test("non-members of the channel cannot read the attendance roster", async () => {
  const { channelId } = await seedChannelWithProfiles({ placedActive: 1 });
  const outsider = await seedUser("outsider");

  const res = await rawGet(`channelId=${channelId}&roster=1`, outsider.id);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { errorCode: string };
  assert.equal(body.errorCode, "not_a_member");

  const plain = await rawGet(`channelId=${channelId}`, outsider.id);
  assert.equal(plain.status, 403, "맵용 기본 응답도 같은 경계를 쓴다");
});

test("not logged in is 401", async () => {
  const { channelId } = await seedChannelWithProfiles({ placedActive: 1 });
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/npcs?channelId=${channelId}`));
  assert.equal(res.status, 401);
});

test("roster=1 carries the seat number — a number for desk seats, null when standing", async () => {
  const { channelId, userId } = await seedChannelWithProfiles({
    unplaced: 5,
    mapData: buildOfficeEnvironment("executive"),
  });
  const { placeUnplacedNpcs } = await import("@/lib/npc-seating");
  await placeUnplacedNpcs(channelId);

  const body = await get(`channelId=${channelId}&roster=1`, userId);

  const numbers = body.npcs.map((n) => (n as unknown as { seatNumber: number | null }).seatNumber);
  assert.deepEqual(
    numbers.filter((n): n is number => n !== null).sort((a, b) => a - b),
    [1, 2, 3], // The executive map has 3 desk seats — the CEO seat is not an assigned employee seat
  );
  assert.equal(numbers.filter((n) => n === null).length, 2);
});
