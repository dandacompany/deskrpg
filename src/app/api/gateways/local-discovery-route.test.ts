import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";

// Task 4 review, Critical 1 + Important 1 regression coverage.
//
// DB-backed (drizzle over @/db) — same rationale as src/app/api/npcs/rebind-route.test.ts:
// `db` is a lazily initialized module singleton and node:test runs each test file in its
// own process, so setting SQLITE_PATH once at module scope pins this file to one
// throwaway DB.
//
// Lives at this top-level path (not inside `[id]/local-discovery/`) for the same reason
// as profiles-probe-route.test.ts: node's test runner treats `[id]` as a glob character
// class when discovering files by path, so a `*.test.ts` file nested inside a bracketed
// route segment is never collected.
const sqlitePath = path.join(
  os.tmpdir(),
  `local-discovery-route-test-${crypto.randomUUID()}.db`,
);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

// A real ~/.hermes-style directory tree on disk, rooted outside the actual home
// directory via HERMES_HOME. `readProfileToken`/`listLocalProfiles` read real files —
// this is not mocked — so a traversal name that escapes the profiles root really would
// reach `decoyDir` on this machine's filesystem if the route failed to reject it.
const hermesHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "local-discovery-hermes-"),
);
const profilesRoot = path.join(hermesHome, "profiles");
const sophieDir = path.join(profilesRoot, "sophie");
fs.mkdirSync(sophieDir, { recursive: true });
fs.writeFileSync(path.join(sophieDir, "config.yaml"), "name: sophie\n");
const SOPHIE_TOKEN = "s".repeat(48);
fs.writeFileSync(
  path.join(sophieDir, ".env"),
  `API_SERVER_KEY=${SOPHIE_TOKEN}\n`,
);

// A canary secret living one level *outside* the profiles root, at the exact spot
// "../decoy-app" would resolve to from `profilesRoot`. If the route's name validation
// were ever removed or bypassed, this is what would leak.
const decoyDir = path.join(hermesHome, "decoy-app");
fs.mkdirSync(decoyDir, { recursive: true });
const CANARY_TOKEN = "CANARY-SECRET-" + "c".repeat(34);
fs.writeFileSync(
  path.join(decoyDir, ".env"),
  `API_SERVER_KEY=${CANARY_TOKEN}\n`,
);
for (const dir of [hermesHome]) {
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedOwnerAndGateway() {
  const { db, users, gatewayResources } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [owner] = await db
    .insert(users)
    .values({
      loginId: `owner-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `owner-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
    })
    .returning();
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: owner.id,
      displayName: "Test Gateway",
      baseUrl: "http://gw.test",
      tokenEncrypted: encryptGatewayToken("gateway-owner-key-1234567890"),
    })
    .returning();
  return { owner, gateway };
}

async function optIn(gatewayId: string, ownerId: string) {
  const { POST } = await import("./[id]/local-discovery/route");
  const req = new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/local-discovery`,
    {
      method: "POST",
      headers: { "x-user-id": ownerId, "content-type": "application/json" },
      body: JSON.stringify({ action: "opt-in" }),
    },
  );
  const res = await POST(req, { params: Promise.resolve({ id: gatewayId }) });
  assert.equal(res.status, 200);
}

describe("POST /api/gateways/[id]/local-discovery (registration batch)", () => {
  test("rejects every path-traversal / non-canonical shape and never stores the canary token, while a legitimate name still registers", async () => {
    const priorEnv = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const { owner, gateway } = await seedOwnerAndGateway();
      await optIn(gateway.id, owner.id);

      const { POST } = await import("./[id]/local-discovery/route");
      const req = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/local-discovery`,
        {
          method: "POST",
          headers: {
            "x-user-id": owner.id,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            profiles: ["../decoy-app", "a/b", "..", ".", "sophie"],
          }),
        },
      );
      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      const byName = Object.fromEntries(
        (
          body.results as { name: string; ok: boolean; errorCode?: string }[]
        ).map((r) => [r.name, r]),
      );
      for (const traversal of ["../decoy-app", "a/b", "..", "."]) {
        assert.equal(
          byName[traversal].ok,
          false,
          `${traversal} must not register`,
        );
        assert.equal(byName[traversal].errorCode, "invalid_profile_name");
      }
      assert.equal(
        byName["sophie"].ok,
        true,
        "a normal profile name must still work",
      );

      const { db, hermesProfiles } = await loadDb();
      const rows = await db
        .select()
        .from(hermesProfiles)
        .where(eq(hermesProfiles.gatewayId, gateway.id));
      assert.equal(
        rows.length,
        1,
        "only the legitimate profile must have been registered",
      );
      assert.equal(rows[0].profileName, "sophie");

      const { decryptGatewayToken } = await import("@/lib/gateway-resources");
      const storedToken = decryptGatewayToken(rows[0].tokenEncrypted);
      assert.equal(storedToken, SOPHIE_TOKEN);
      assert.notEqual(
        storedToken,
        CANARY_TOKEN,
        "the canary secret from outside the profiles root must never be stored",
      );
    } finally {
      process.env.HERMES_HOME = priorEnv;
    }
  });
});

describe("GET /api/gateways/[id]/local-discovery (owner gate)", () => {
  test("returns empty candidates to a share-only caller even after the owner has opted in", async () => {
    const priorEnv = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      const { owner, gateway } = await seedOwnerAndGateway();
      await optIn(gateway.id, owner.id);

      const { db, gatewayShares, users } = await loadDb();
      const [sharedUser] = await db
        .insert(users)
        .values({
          loginId: `shared-${crypto.randomUUID().slice(0, 8)}`,
          nickname: `shared-${crypto.randomUUID().slice(0, 8)}`,
          passwordHash: "hash",
        })
        .returning();
      await db
        .insert(gatewayShares)
        .values({ gatewayId: gateway.id, userId: sharedUser.id, role: "use" });

      const { GET } = await import("./[id]/local-discovery/route");

      const ownerReq = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/local-discovery`,
        {
          method: "GET",
          headers: { "x-user-id": owner.id },
        },
      );
      const ownerRes = await GET(ownerReq, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const ownerBody = await ownerRes.json();
      assert.equal(ownerBody.optedIn, true);
      assert.ok(
        ownerBody.candidates.some((c: { name: string }) => c.name === "sophie"),
        "owner sees real candidates",
      );

      const sharedReq = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/local-discovery`,
        {
          method: "GET",
          headers: { "x-user-id": sharedUser.id },
        },
      );
      const sharedRes = await GET(sharedReq, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const sharedBody = await sharedRes.json();
      assert.equal(sharedRes.status, 200);
      assert.equal(sharedBody.optedIn, true);
      assert.deepEqual(
        sharedBody.candidates,
        [],
        "a share-only caller must not see the owner's local profile names",
      );
    } finally {
      process.env.HERMES_HOME = priorEnv;
    }
  });
});
