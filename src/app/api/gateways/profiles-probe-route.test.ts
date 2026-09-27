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
const sqlitePath = path.join(os.tmpdir(), `probe-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => {
    try {
      fs.rmSync(`${sqlitePath}${ext}`, { force: true });
    } catch {
      // ignore on Windows if lock held
    }
  });
}

async function loadDb() {
  return import("@/db");
}

async function seedUserAndGateway(customTokenEncrypted?: string) {
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
      tokenEncrypted: customTokenEncrypted ?? encryptGatewayToken("gateway-owner-key-1234567890"),
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
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("unexpected fetch", { status: 599 });
    }) as typeof fetch;

    try {
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/profiles/probe`, {
        method: "POST",
        headers: { "x-user-id": user.id, "content-type": "application/json" },
        body: JSON.stringify({ profileName: ".." }),
      });

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      assert.equal(fetchCalled, false, "fetch must never be called for a rejected profile name");
      assert.equal(body.status, "not_found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("corrupt ciphertext fails closed without calling fetch", async () => {
    const { POST } = await import("./[id]/profiles/probe/route");
    const { user, gateway } = await seedUserAndGateway("v1:corrupt:bad:ciphertext");

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("unexpected fetch", { status: 599 });
    }) as typeof fetch;

    try {
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/profiles/probe`, {
        method: "POST",
        headers: { "x-user-id": user.id, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "sophie" }),
      });

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      assert.equal(fetchCalled, false, "fetch must never be called when gateway token cannot be decrypted");
      assert.equal(body.status, "unknown");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("default profile uses gateway listener-owner key", async () => {
    const { POST } = await import("./[id]/profiles/probe/route");
    const { user, gateway } = await seedUserAndGateway();

    const originalFetch = globalThis.fetch;
    let authHeaderOnModels: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/models")) {
        const headers = new Headers(init?.headers);
        authHeaderOnModels = headers.get("authorization");
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/profiles/probe`, {
        method: "POST",
        headers: { "x-user-id": user.id, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "default" }),
      });

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      assert.equal(authHeaderOnModels, "Bearer gateway-owner-key-1234567890");
      assert.equal(body.status, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("named profile uses its own credential scope, not the gateway owner key", async () => {
    const { POST } = await import("./[id]/profiles/probe/route");
    const { db, hermesProfiles } = await loadDb();
    const { encryptGatewayToken } = await import("@/lib/gateway-resources");
    const { user, gateway } = await seedUserAndGateway();

    // Register a profile with its own key
    await db.insert(hermesProfiles).values({
      gatewayId: gateway.id,
      profileName: "sophie",
      tokenEncrypted: encryptGatewayToken("sophie-profile-key-abcdef"),
    });

    const originalFetch = globalThis.fetch;
    let authHeaderOnModels: string | null = null;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/models")) {
        requestedUrl = url;
        const headers = new Headers(init?.headers);
        authHeaderOnModels = headers.get("authorization");
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/profiles/probe`, {
        method: "POST",
        headers: { "x-user-id": user.id, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "sophie" }),
      });

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      assert.ok(requestedUrl.includes("/p/sophie/v1/models"));
      assert.equal(authHeaderOnModels, "Bearer sophie-profile-key-abcdef");
      assert.notEqual(authHeaderOnModels, "Bearer gateway-owner-key-1234567890");
      assert.equal(body.status, "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("named profile without credentials uses unscoped probe and never sends owner token to profile endpoint", async () => {
    const { POST } = await import("./[id]/profiles/probe/route");
    const { user, gateway } = await seedUserAndGateway();

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const req = new NextRequest(`http://localhost/api/gateways/${gateway.id}/profiles/probe`, {
        method: "POST",
        headers: { "x-user-id": user.id, "content-type": "application/json" },
        body: JSON.stringify({ profileName: "mia" }),
      });

      const res = await POST(req, {
        params: Promise.resolve({ id: gateway.id }),
      });
      const body = await res.json();

      // Verified: owner key was sent unscoped to /v1/models, NOT to /p/mia/v1/models
      assert.ok(requestedUrls.some((u) => u.endsWith("/v1/models") && !u.includes("/p/mia")));
      assert.equal(requestedUrls.some((u) => u.includes("/p/mia/v1/models")), false);
      // Honest semantics: cannot claim profile validation without profile credentials
      assert.equal(body.status, "unknown");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
