import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  authHeaders,
  seedGatewayBoundToChannels,
  setupThrowawaySqlite,
} from "@/test-setup/npc-seed";

// Task 6. Registering a profile is itself hiring — it clocks in immediately to **every** channel the gateway
// is already bound to. Users used to have to create NPCs separately per channel.
//
// Kept at the top level (outside `[id]`) — the node test runner misses *.test.ts inside `[id]`.
setupThrowawaySqlite("profile-create-hires-test");

test("registering a profile adds one entry to the roster of every channel the gateway is bound to", async () => {
  const { gatewayId, channelIds, userId } = await seedGatewayBoundToChannels({ channels: 2 });
  const { selectChannelNpcs } = await import("@/lib/npc-projection");
  const { POST } = await import("./[id]/profiles/route");

  const res = await POST(
    new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles`, {
      method: "POST",
      body: JSON.stringify({ profileName: "sophie", token: "profile-key-1234567890" }),
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ id: gatewayId }) },
  );
  assert.equal(res.status, 201);

  for (const channelId of channelIds) {
    const roster = await selectChannelNpcs(channelId, { roster: true });
    assert.equal(roster.length, 1, `채널 ${channelId} 에 1개`);
    assert.equal(roster[0].profile.profileName, "sophie");
    assert.equal(roster[0].active, true);
    assert.equal(roster[0].positionX, null, "자리는 아직 없다 — 배치는 별도 행동이다");
  }
});

test("profile registration is 201 even if hiring fails — no irreversible half-done state", async () => {
  const { gatewayId, userId } = await seedGatewayBoundToChannels({ channels: 1 });
  const { getDb, npcs } = await import("@/db");
  const { POST } = await import("./[id]/profiles/route");

  // Blow up only the `npcs` insert — this test is meaningful only if profile registration (the hermes_profiles insert)
  // still succeeds. Override it as an own property of the drizzle instance and restore afterwards.
  const instance = getDb() as unknown as { insert: (table: unknown) => unknown };
  const original = instance.insert.bind(instance);
  instance.insert = (table: unknown) => {
    if (table === npcs) throw new Error("hire boom");
    return original(table);
  };

  let res: Response;
  try {
    res = await POST(
      new NextRequest(`http://localhost/api/gateways/${gatewayId}/profiles`, {
        method: "POST",
        body: JSON.stringify({ profileName: "brittle", token: "profile-key-1234567890" }),
        headers: authHeaders(userId),
      }),
      { params: Promise.resolve({ id: gatewayId }) },
    );
  } finally {
    delete (instance as unknown as Record<string, unknown>).insert;
  }

  assert.equal(res.status, 201, "고용은 부수효과지 성공 조건이 아니다");
  const { listHermesProfiles } = await import("@/lib/hermes-profiles");
  const profiles = await listHermesProfiles(userId, gatewayId);
  assert.ok(
    profiles.some((p) => p.profileName === "brittle"),
    "프로필 행은 남아 있어야 한다 — 같은 이름으로 다시 만들 수 없는 상태를 피한다",
  );
});
