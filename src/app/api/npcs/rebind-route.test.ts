import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

// Regression test for the rebind IDOR: a caller who owns the NPC's channel must not be
// able to bind that NPC to a Hermes profile on a gateway they have no relationship to.
// DB-backed (drizzle over @/db), so — same as src/lib/hermes-profiles.test.ts — this runs
// against a real temporary SQLite database rather than mocking `db`. `db` is a lazily
// initialized module singleton and node:test runs each test *file* in its own process, so
// setting SQLITE_PATH once at module scope (before any test body touches `db`) pins every
// test in this file to one throwaway DB.
const sqlitePath = path.join(os.tmpdir(), `rebind-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedUser(nickname: string) {
  const { db, users } = await loadDb();
  const [user] = await db
    .insert(users)
    .values({
      loginId: `${nickname}-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `${nickname}-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
    })
    .returning();
  return user;
}

async function seedGateway(ownerUserId: string) {
  const { db, gatewayResources } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId,
      displayName: "Test Gateway",
      baseUrl: "http://gw.test",
      tokenEncrypted: encryptGatewayToken("gateway-owner-key-1234567890"),
    })
    .returning();
  return gateway;
}

async function seedHermesProfile(gatewayId: string) {
  const { db, hermesProfiles } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [profile] = await db
    .insert(hermesProfiles)
    .values({
      gatewayId,
      profileName: "sophie",
      tokenEncrypted: encryptGatewayToken("victims-profile-key-1234567890"),
      displayName: "sophie",
    })
    .returning();
  return profile;
}

async function seedChannelWithNpc(ownerId: string) {
  const { db, channels, npcs } = await loadDb();
  const [channel] = await db
    .insert(channels)
    .values({
      name: "Test Channel",
      ownerId,
    })
    .returning();
  const [npc] = await db
    .insert(npcs)
    .values({
      channelId: channel.id,
      name: "Test NPC",
      positionX: 0,
      positionY: 0,
      appearance: "{}",
      agentConfig: "{}",
      // 어댑터 타입을 명시한다 — 이 테스트가 보는 것은 "403 일 때 값이 바뀌지 않는가"이지
      // 컬럼 기본값이 무엇인가가 아니다. 기본값에 기대면 기본값이 바뀔 때 같이 깨진다.
      adapterType: "unbound",
    })
    .returning();
  return { channel, npc };
}

describe("POST /api/npcs/[id]/rebind", () => {
  test("refuses to bind an NPC to a profile on a gateway the caller cannot access, and leaves the NPC row unmodified", async () => {
    const { POST } = await import("./[id]/rebind/route");

    const victimOwner = await seedUser("victim-owner");
    const victimGateway = await seedGateway(victimOwner.id);
    const victimProfile = await seedHermesProfile(victimGateway.id);

    const attacker = await seedUser("attacker");
    const { npc } = await seedChannelWithNpc(attacker.id);

    const req = new NextRequest("http://localhost/api/npcs/x/rebind", {
      method: "POST",
      headers: { "x-user-id": attacker.id, "content-type": "application/json" },
      body: JSON.stringify({ profileId: victimProfile.id }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: npc.id }) });
    const body = await res.json();

    assert.equal(res.status, 403);
    assert.equal(body.errorCode, "forbidden");

    const { db, npcs } = await loadDb();
    const [reloaded] = await db.select().from(npcs).where(eq(npcs.id, npc.id));
    assert.equal(reloaded.hermesProfileId, null, "the NPC must not be bound to the profile");
    assert.equal(reloaded.adapterType, "unbound", "the NPC's adapter type must be left unchanged");
  });

  test("allows binding when the caller has share access (not just ownership) to the profile's gateway", async () => {
    const { POST } = await import("./[id]/rebind/route");

    const gatewayOwner = await seedUser("gateway-owner");
    const gateway = await seedGateway(gatewayOwner.id);
    const profile = await seedHermesProfile(gateway.id);

    const { db, gatewayShares } = await loadDb();
    const npcOwner = await seedUser("npc-owner");
    await db
      .insert(gatewayShares)
      .values({ gatewayId: gateway.id, userId: npcOwner.id, role: "use" });
    const { npc } = await seedChannelWithNpc(npcOwner.id);

    const req = new NextRequest("http://localhost/api/npcs/x/rebind", {
      method: "POST",
      headers: { "x-user-id": npcOwner.id, "content-type": "application/json" },
      body: JSON.stringify({ profileId: profile.id }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: npc.id }) });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.npc.hermesProfileId, profile.id);
    assert.equal(body.npc.adapterType, "hermes");
  });
});
