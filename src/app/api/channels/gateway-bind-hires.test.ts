import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  countMeetingMinutes,
  seedMeetingMinutes,
  seedTwoGateways,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

// Task 6. Connecting a gateway is "hiring" and switching is "sleeping".
//
// Binding changes used to throw 409 `gateway_change_requires_npc_reset` and, after confirmation,
// **deleted** NPCs and minutes. Once profiles became the NPC's source of truth that destruction had
// no basis — the old gateway's NPCs sleep remembering their seats, the new gateway's
// profiles clock in, and channel artifacts stay as they are.
//
// Kept outside the `[id]` segment (at the channel API root) — the node test runner mistakes `[id]` for a character
// class and misses the *.test.ts inside it.
setupThrowawaySqlite("gateway-bind-hires-test");

test("connecting a gateway clocks NPCs in; switching to another gateway puts the old NPCs to sleep and the minutes remain", async () => {
  const { userId, channelId, gatewayA, gatewayB } = await seedTwoGateways({ profilesEach: 2 });
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { PUT } = await import("./[id]/gateway/route");
  const put = (gatewayId: string) =>
    PUT(
      new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
        method: "PUT",
        body: JSON.stringify({ gatewayId }),
        headers: authHeaders(userId),
      }),
      { params: Promise.resolve({ id: channelId }) },
    );

  assert.equal((await put(gatewayA)).status, 200);
  assert.equal((await selectChannelNpcs(channelId, { roster: true })).length, 2);
  await seedMeetingMinutes(channelId);

  const res = await put(gatewayB);
  assert.equal(res.status, 200, "예전의 409 gateway_change_requires_npc_reset 은 없다");

  const roster = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(roster.filter((n) => n.active).length, 2, "B 의 프로필이 출근");
  assert.equal(roster.filter((n) => !n.active).length, 2, "A 의 NPC 는 휴면");
  assert.equal(await countMeetingMinutes(channelId), 1, "회의록은 지우지 않는다");
});

test("switching back to the old gateway revives the sleeping NPCs as they were", async () => {
  const { userId, channelId, gatewayA, gatewayB } = await seedTwoGateways({ profilesEach: 1 });
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { PUT } = await import("./[id]/gateway/route");
  const put = (gatewayId: string) =>
    PUT(
      new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
        method: "PUT",
        body: JSON.stringify({ gatewayId }),
        headers: authHeaders(userId),
      }),
      { params: Promise.resolve({ id: channelId }) },
    );

  await put(gatewayA);
  await put(gatewayB);
  await put(gatewayA);

  const roster = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(roster.length, 2, "행은 늘지 않는다 — 되살릴 뿐이다");
  assert.equal(roster.filter((n) => n.active).length, 1, "A 의 NPC 만 다시 출근");
});

test("disconnecting does not delete NPCs but puts them to sleep — seats and minutes stay", async () => {
  const { userId, channelId, gatewayA } = await seedTwoGateways({ profilesEach: 2 });
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { db, npcs } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const { PUT, DELETE } = await import("./[id]/gateway/route");

  const put = () =>
    PUT(
      new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
        method: "PUT",
        body: JSON.stringify({ gatewayId: gatewayA }),
        headers: authHeaders(userId),
      }),
      { params: Promise.resolve({ id: channelId }) },
    );

  assert.equal((await put()).status, 200);
  // Give them seats — to see whether sleeping remembers seats, there must be seats.
  const hired = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(hired.length, 2);
  for (const [i, npc] of hired.entries()) {
    await db.update(npcs).set({ positionX: i, positionY: 3 }).where(eq(npcs.id, npc.id));
  }
  await seedMeetingMinutes(channelId);

  // Calling this without confirmation used to be 409 gateway_disconnect_requires_npc_reset.
  const res = await DELETE(
    new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
      method: "DELETE",
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: channelId }) },
  );
  assert.equal(res.status, 200, "예전의 409 gateway_disconnect_requires_npc_reset 은 없다");

  const slept = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(slept.length, 2, "NPC 는 지워지지 않는다");
  assert.equal(slept.filter((n) => n.active).length, 0, "전부 휴면");
  assert.deepEqual(
    slept.map((n) => [n.positionX, n.positionY]).sort(),
    [
      [0, 3],
      [1, 3],
    ],
    "자리는 기억한다",
  );
  assert.equal(await countMeetingMinutes(channelId), 1, "회의록은 지우지 않는다");

  // Reconnecting revives rather than creates — exactly as many as were sleeping.
  const { hireGatewayProfilesIntoChannel } = await import("@/lib/npc-roster");
  assert.deepEqual(
    await hireGatewayProfilesIntoChannel(channelId, gatewayA),
    { created: 0, reactivated: 2 },
    "되살림 2, 신규 0",
  );

  // Reconnecting through the route does not add rows or disturb seats either (idempotent).
  assert.equal((await put()).status, 200);
  const back = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(back.length, 2);
  assert.equal(back.filter((n) => n.active).length, 2, "다시 출근");
  assert.deepEqual(
    back.map((n) => [n.positionX, n.positionY]).sort(),
    [
      [0, 3],
      [1, 3],
    ],
    "자리를 되찾는다",
  );
});

test("when the connection is unchanged, a PUT that only saves settings does not revive sleeping NPCs", async () => {
  const { userId, channelId, gatewayA } = await seedTwoGateways({ profilesEach: 2 });
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { setNpcActive } = await import("@/lib/npc-roster");
  const { PUT } = await import("./[id]/gateway/route");
  const put = (body: Record<string, unknown>) =>
    PUT(
      new NextRequest(`http://localhost/api/channels/${channelId}/gateway`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: authHeaders(userId),
      }),
      { params: Promise.resolve({ id: channelId }) },
    );

  assert.equal((await put({ gatewayId: gatewayA })).status, 200);
  const [first] = await selectChannelNpcs(channelId, { roster: true });
  await setNpcActive(first.id, false);

  // Re-save the same gateway. If hiring ran here, NPCs the user put to sleep themselves
  // would silently come back to life.
  assert.equal((await put({ gatewayId: gatewayA })).status, 200);

  const roster = await selectChannelNpcs(channelId, { roster: true });
  assert.equal(
    roster.find((n) => n.id === first.id)?.active,
    false,
    "사용자가 재운 NPC 는 설정 저장으로 되살아나지 않는다",
  );
});
