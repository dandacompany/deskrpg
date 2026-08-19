import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// DB-backed (drizzle over @/db) — same rationale as src/app/api/npcs/rebind-route.test.ts:
// `db` is a lazily initialized module singleton and node:test runs each test file in its
// own process, so setting SQLITE_PATH once at module scope pins this file to one
// throwaway DB.
//
// Lives at this top-level path (not inside `[id]/profiles/probe/`) because node's test
// runner treats `[id]` as a glob character class when discovering files by path, so a
// `*.test.ts` file placed inside a bracketed route segment is silently never collected.
// Sibling `profiles-route.test.ts` establishes this same top-level naming convention.
const sqlitePath = path.join(
  os.tmpdir(),
  `probe-route-test-${crypto.randomUUID()}.db`,
);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedUserAndGateway() {
  const { db, users, gatewayResources } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [user] = await db
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
      ownerUserId: user.id,
      displayName: "Test Gateway",
      baseUrl: "http://gw.test",
      tokenEncrypted: encryptGatewayToken("gateway-owner-key-1234567890"),
    })
    .returning();
  return { user, gateway };
}

describe("POST /api/gateways/[id]/profiles/probe", () => {
  test("rejects a path-traversal profile name without ever calling fetch", async () => {
    const { POST } = await import("./[id]/profiles/probe/route");
    const { user, gateway } = await seedUserAndGateway();

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const req = new NextRequest(
        `http://localhost/api/gateways/${gateway.id}/profiles/probe`,
        {
          method: "POST",
          headers: { "x-user-id": user.id, "content-type": "application/json" },
          body: JSON.stringify({ profileName: ".." }),
        },
      );

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      assert.equal(
        fetchCalled,
        false,
        "fetch must never be called for a rejected profile name",
      );
      assert.equal(body.status, "not_found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
