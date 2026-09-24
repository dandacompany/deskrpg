import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Wiring verification for the provider key and OAuth proxy routes (owner only). Imports the real route.ts and
// calls the handlers directly — same technique as plugin-proxy-route.test.ts (throwaway SQLite +
// local stub gateway). The reason for staying outside the `[id]` segment is the same too (test runner glob).

const sqlitePath = path.join(os.tmpdir(), `provider-auth-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

const KEY_VALUE = "sk-SEEDED-SECRET-VALUE-0123456789";
const PROFILE_TOKEN = "profile-scoped-key-abcdefgh01";

async function loadDb() {
  return import("@/db");
}

async function seedUser() {
  const { db, users } = await loadDb();
  const [user] = await db
    .insert(users)
    .values({
      loginId: `u-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `u-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
    })
    .returning();
  return user;
}

async function seedGatewayWithProfile(ownerId: string, baseUrl: string) {
  const { db, gatewayResources, hermesProfiles } = await loadDb();
  const { encryptGatewayToken } = await import("@/lib/gateway-resources");
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: ownerId,
      displayName: "Test Gateway",
      baseUrl,
      tokenEncrypted: encryptGatewayToken("gateway-default-key-1234567890"),
    })
    .returning();
  await db.insert(hermesProfiles).values({
    gatewayId: gateway.id,
    profileName: "noah",
    tokenEncrypted: encryptGatewayToken(PROFILE_TOKEN),
    displayName: "noah",
  });
  return gateway;
}

async function shareGateway(gatewayId: string, userId: string) {
  const { db, gatewayShares } = await loadDb();
  await db.insert(gatewayShares).values({ gatewayId, userId });
}

type Seen = { method: string; url: string; auth: string; body: string };

async function startStub(
  respond: (seen: Seen) => { status: number; body: unknown },
): Promise<{ baseUrl: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((httpReq, httpRes) => {
    let raw = "";
    httpReq.on("data", (chunk) => (raw += chunk));
    httpReq.on("end", () => {
      const entry = {
        method: httpReq.method ?? "",
        url: httpReq.url ?? "",
        auth: httpReq.headers.authorization ?? "",
        body: raw,
      };
      seen.push(entry);
      const out = respond(entry);
      httpRes.writeHead(out.status, { "content-type": "application/json" });
      httpRes.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind stub server");
  return { baseUrl: `http://127.0.0.1:${address.port}`, seen, close: () => server.close() };
}

function keyPut(gatewayId: string, userId: string, provider: string, body: unknown) {
  return new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/plugin/profiles/noah/provider-keys/${provider}`,
    {
      method: "PUT",
      headers: { "x-user-id": userId, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/** Collect console.* output and assert at the end of the test that key values are absent. */
function captureConsole() {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore: () => methods.forEach((m, i) => (console[m] = original[i])),
  };
}

describe("provider-keys PUT — owner only", () => {
  test("owner PUT → 200, hands the value to the plugin with the profile token, and the value is absent from the response and logs", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: { provider: "openrouter", configured: true },
    }));
    const logs = captureConsole();
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import("./[id]/plugin/profiles/[name]/provider-keys/[provider]/route");
      const res = await PUT(keyPut(gateway.id, owner.id, "openrouter", { value: KEY_VALUE }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", provider: "openrouter" }),
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(text.includes(KEY_VALUE), false, "응답 본문에 키 값이 실리면 안 된다");
      assert.equal(stub.seen.length, 1);
      assert.equal(stub.seen[0].method, "PUT");
      assert.equal(stub.seen[0].url, "/p/noah/deskrpg/provider-keys/openrouter");
      assert.equal(stub.seen[0].auth, `Bearer ${PROFILE_TOKEN}`);
      assert.deepEqual(JSON.parse(stub.seen[0].body), { value: KEY_VALUE });
    } finally {
      logs.restore();
      stub.close();
    }
    assert.equal(logs.lines.join("\n").includes(KEY_VALUE), false, "로그에 키 값이 없어야 한다");
  });

  test("shared user PUT → 403 forbidden, the plugin is not called", async () => {
    const stub = await startStub(() => ({ status: 200, body: {} }));
    try {
      const owner = await seedUser();
      const shared = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      await shareGateway(gateway.id, shared.id);
      const { PUT } = await import("./[id]/plugin/profiles/[name]/provider-keys/[provider]/route");
      const res = await PUT(keyPut(gateway.id, shared.id, "openrouter", { value: KEY_VALUE }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", provider: "openrouter" }),
      });
      const text = await res.text();
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(text).errorCode, "forbidden");
      assert.equal(text.includes(KEY_VALUE), false);
      assert.equal(stub.seen.length, 0);
    } finally {
      stub.close();
    }
  });

  test("bad body or segment → 400 bad_request, the value is not echoed back", async () => {
    const stub = await startStub(() => ({ status: 200, body: {} }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import("./[id]/plugin/profiles/[name]/provider-keys/[provider]/route");
      const badBody = await PUT(keyPut(gateway.id, owner.id, "openrouter", { key: KEY_VALUE }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", provider: "openrouter" }),
      });
      const badBodyText = await badBody.text();
      assert.equal(badBody.status, 400);
      assert.equal(JSON.parse(badBodyText).errorCode, "bad_request");
      assert.equal(badBodyText.includes(KEY_VALUE), false);

      const badSeg = await PUT(keyPut(gateway.id, owner.id, "..", { value: KEY_VALUE }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", provider: ".." }),
      });
      assert.equal(badSeg.status, 400);
      assert.equal(stub.seen.length, 0);
    } finally {
      stub.close();
    }
  });

  test("plugin failures are carried as HTTP 200 + errorCode without mixing in the request body", async () => {
    const stub = await startStub(() => ({
      status: 422,
      body: { error: "invalid_key_format", reason: "invalid_key_format" },
    }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import("./[id]/plugin/profiles/[name]/provider-keys/[provider]/route");
      const res = await PUT(keyPut(gateway.id, owner.id, "openrouter", { value: KEY_VALUE }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", provider: "openrouter" }),
      });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(typeof JSON.parse(text).errorCode, "string");
      assert.equal(text.includes(KEY_VALUE), false);
    } finally {
      stub.close();
    }
  });
});

describe("OAuth routes — owner only", () => {
  test("a shared user's OAuth start/poll/cancel/disconnect and key DELETE → all 403, plugin not called", async () => {
    const stub = await startStub(() => ({ status: 200, body: {} }));
    try {
      const owner = await seedUser();
      const shared = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      await shareGateway(gateway.id, shared.id);
      const base = `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah`;
      const req = (method: string, url: string) =>
        new NextRequest(url, { method, headers: { "x-user-id": shared.id } });
      const p = { id: gateway.id, name: "noah" };

      const start = await import("./[id]/plugin/profiles/[name]/oauth/[provider]/start/route");
      const poll =
        await import("./[id]/plugin/profiles/[name]/oauth/[provider]/sessions/[sessionId]/route");
      const cancel = await import("./[id]/plugin/profiles/[name]/oauth/sessions/[sessionId]/route");
      const disconnect = await import("./[id]/plugin/profiles/[name]/oauth/[provider]/route");
      const keys = await import("./[id]/plugin/profiles/[name]/provider-keys/[provider]/route");

      const results = [
        await start.POST(req("POST", `${base}/oauth/nous/start`), {
          params: Promise.resolve({ ...p, provider: "nous" }),
        }),
        await poll.GET(req("GET", `${base}/oauth/nous/sessions/s1`), {
          params: Promise.resolve({ ...p, provider: "nous", sessionId: "s1" }),
        }),
        await cancel.DELETE(req("DELETE", `${base}/oauth/sessions/s1`), {
          params: Promise.resolve({ ...p, sessionId: "s1" }),
        }),
        await disconnect.DELETE(req("DELETE", `${base}/oauth/nous`), {
          params: Promise.resolve({ ...p, provider: "nous" }),
        }),
        await keys.DELETE(req("DELETE", `${base}/provider-keys/openrouter`), {
          params: Promise.resolve({ ...p, provider: "openrouter" }),
        }),
      ];
      for (const res of results) {
        assert.equal(res.status, 403);
        assert.equal((await res.json()).errorCode, "forbidden");
      }
      assert.equal(stub.seen.length, 0);
    } finally {
      stub.close();
    }
  });

  test("owner OAuth start → 200, goes out on the profile-scoped path", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: { sessionId: "s1", verificationUri: "https://example.test/device", userCode: "ABCD" },
    }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { POST } = await import("./[id]/plugin/profiles/[name]/oauth/[provider]/start/route");
      const res = await POST(
        new NextRequest(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/oauth/nous/start`,
          { method: "POST", headers: { "x-user-id": owner.id } },
        ),
        { params: Promise.resolve({ id: gateway.id, name: "noah", provider: "nous" }) },
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).sessionId, "s1");
      assert.equal(stub.seen[0].method, "POST");
      assert.equal(stub.seen[0].url, "/p/noah/deskrpg/oauth/nous/start");
      assert.equal(stub.seen[0].auth, `Bearer ${PROFILE_TOKEN}`);
    } finally {
      stub.close();
    }
  });
});
