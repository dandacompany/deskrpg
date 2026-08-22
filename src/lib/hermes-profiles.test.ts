import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileClient, mapValidationError, registerHermesProfile } from "./hermes-profiles";
import { decryptGatewayToken, encryptGatewayToken } from "./gateway-resources";
import { HermesError } from "./hermes/hermes-client";

// registerHermesProfile is DB-backed (drizzle over @/db), so these tests exercise it
// against a real temporary SQLite database rather than mocking `db` — this project's
// existing DB-backed tests (src/db/*.test.ts) already favor a real SQLite harness over
// mocking, and getDb() wires up the full schema automatically for a fresh file.
// `db` is a lazily-initialized module singleton, and node:test runs each test *file*
// in its own process, so setting SQLITE_PATH once at module scope (before any test
// body touches `db`) is enough to pin every test in this file to one throwaway DB.
const sqlitePath = path.join(os.tmpdir(), `hermes-profiles-test-${crypto.randomUUID()}.db`);
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

async function shareGateway(gatewayId: string, userId: string, role = "use") {
  const { db, gatewayShares } = await loadDb();
  await db.insert(gatewayShares).values({ gatewayId, userId, role });
}

describe("buildProfileClient", () => {
  test("decrypts the stored token and scopes the URL to the profile", async () => {
    const tokenEncrypted = encryptGatewayToken("plain-key-1234567890");
    let seen: { url: string; auth: string | null } = { url: "", auth: null };

    const fetchImpl = async (u: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("Authorization") };
      return new Response(JSON.stringify({ features: {}, endpoints: {} }), { status: 200 });
    };

    const client = buildProfileClient({
      baseUrl: "http://gw:8642",
      profileName: "sophie",
      tokenEncrypted,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.getCapabilities();

    assert.equal(seen.url, "http://gw:8642/p/sophie/v1/capabilities");
    assert.equal(seen.auth, "Bearer plain-key-1234567890");
  });
});

describe("mapValidationError", () => {
  test("maps HermesError codes to persisted validation statuses", () => {
    assert.equal(mapValidationError(new HermesError("unauthorized", "x", 401)), "unauthorized");
    assert.equal(
      mapValidationError(new HermesError("unknown_profile", "x", 404)),
      "unknown_profile",
    );
    assert.equal(mapValidationError(new HermesError("unreachable", "x", 0)), "unreachable");
    assert.equal(mapValidationError(new HermesError("http_error", "x", 500)), "error");
  });

  test("maps a non-Hermes throw to a generic error", () => {
    assert.equal(mapValidationError(new Error("boom")), "error");
  });
});

describe("registerHermesProfile", () => {
  test("returns forbidden for a caller who is not the gateway owner", async () => {
    const owner = await seedUser("owner");
    const sharedUser = await seedUser("shared");
    const gateway = await seedGateway(owner.id);
    await shareGateway(gateway.id, sharedUser.id, "use");

    const result = await registerHermesProfile({
      userId: sharedUser.id,
      gatewayId: gateway.id,
      profileName: "sophie",
      token: "shared-users-key-1234567890",
    });

    assert.deepEqual(result, { error: "forbidden" });
  });

  test("returns forbidden for a caller with no access at all", async () => {
    const owner = await seedUser("owner");
    const stranger = await seedUser("stranger");
    const gateway = await seedGateway(owner.id);

    const result = await registerHermesProfile({
      userId: stranger.id,
      gatewayId: gateway.id,
      profileName: "sophie",
      token: "strangers-key-1234567890",
    });

    assert.deepEqual(result, { error: "forbidden" });
  });

  test("inserts on first registration and updates the token on a same-name re-registration", async () => {
    const owner = await seedUser("owner");
    const gateway = await seedGateway(owner.id);

    const first = await registerHermesProfile({
      userId: owner.id,
      gatewayId: gateway.id,
      profileName: "sophie",
      token: "first-api-server-key-123456",
    });
    assert.ok("profile" in first);
    assert.equal(first.profile.profileName, "sophie");
    assert.equal(decryptGatewayToken(first.profile.tokenEncrypted), "first-api-server-key-123456");

    const second = await registerHermesProfile({
      userId: owner.id,
      gatewayId: gateway.id,
      profileName: "sophie",
      token: "rotated-api-server-key-98765",
    });
    assert.ok("profile" in second);
    assert.equal(second.profile.id, first.profile.id, "re-registration updates the same row");
    assert.equal(
      decryptGatewayToken(second.profile.tokenEncrypted),
      "rotated-api-server-key-98765",
    );

    const { db, hermesProfiles } = await loadDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(hermesProfiles)
      .where(eq(hermesProfiles.gatewayId, gateway.id));
    assert.equal(rows.length, 1, "no duplicate row was created");
  });

  test("converges to an update instead of throwing when two registrations race", async () => {
    const owner = await seedUser("owner");
    const gateway = await seedGateway(owner.id);

    // Both calls see no existing row at their `select` and both attempt an `insert`;
    // the loser must catch the unique-constraint violation and fall back to an
    // update rather than rejecting. Node interleaves these two async calls at their
    // `await` points, so invoking them concurrently reliably exercises the race.
    const [a, b] = await Promise.all([
      registerHermesProfile({
        userId: owner.id,
        gatewayId: gateway.id,
        profileName: "racer",
        token: "racer-key-a-1234567890123",
      }),
      registerHermesProfile({
        userId: owner.id,
        gatewayId: gateway.id,
        profileName: "racer",
        token: "racer-key-b-1234567890123",
      }),
    ]);

    assert.ok("profile" in a);
    assert.ok("profile" in b);
    assert.equal(a.profile.id, b.profile.id, "both calls converge on the same row");

    const { db, hermesProfiles } = await loadDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(hermesProfiles)
      .where(eq(hermesProfiles.gatewayId, gateway.id));
    assert.equal(rows.length, 1, "the race did not create a duplicate row");
  });
});
