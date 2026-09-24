import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Wiring verification for the tool provider proxy routes (0.10.0) — reads need gateway access, writes are owner only. Imports the real route.ts and
// calls the handlers directly — same technique as plugin-proxy-route.test.ts (throwaway SQLite +
// local stub gateway). The reason for staying outside the `[id]` segment is the same too (test runner glob).

const sqlitePath = path.join(os.tmpdir(), `tool-provider-route-test-${crypto.randomUUID()}.db`);
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

function toolPut(gatewayId: string, userId: string, toolset: string, body: unknown) {
  return new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/plugin/profiles/noah/toolsets/${toolset}/provider`,
    {
      method: "PUT",
      headers: { "x-user-id": userId, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function toolGet(gatewayId: string, userId: string, toolset: string) {
  return new NextRequest(
    `http://localhost/api/gateways/${gatewayId}/plugin/profiles/noah/toolsets/${toolset}/providers`,
    { headers: { "x-user-id": userId } },
  );
}

const PUT_PATH = "./[id]/plugin/profiles/[name]/toolsets/[toolset]/provider/route";
const GET_PATH = "./[id]/plugin/profiles/[name]/toolsets/[toolset]/providers/route";

describe("tool provider PUT — owner only, key values only pass through", () => {
  test("owner PUT → hands the choice and key over with the profile token, and the response has no value", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: { provider: "OpenAI TTS", isSet: { VOICE_TOOLS_OPENAI_KEY: true } },
    }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import(PUT_PATH);
      const res = await PUT(
        toolPut(gateway.id, owner.id, "tts", {
          provider: "OpenAI TTS",
          env: { VOICE_TOOLS_OPENAI_KEY: KEY_VALUE },
        }),
        { params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }) },
      );
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.equal(text.includes(KEY_VALUE), false);
      assert.equal(stub.seen[0].method, "PUT");
      assert.equal(stub.seen[0].url, "/p/noah/deskrpg/toolsets/tts/provider");
      assert.equal(stub.seen[0].auth, `Bearer ${PROFILE_TOKEN}`);
      assert.deepEqual(JSON.parse(stub.seen[0].body), {
        provider: "OpenAI TTS",
        env: { VOICE_TOOLS_OPENAI_KEY: KEY_VALUE },
      });
    } finally {
      stub.close();
    }
  });

  test("shared user PUT → 403, the plugin is not called", async () => {
    const stub = await startStub(() => ({ status: 200, body: {} }));
    try {
      const owner = await seedUser();
      const shared = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      await shareGateway(gateway.id, shared.id);
      const { PUT } = await import(PUT_PATH);
      const res = await PUT(
        toolPut(gateway.id, shared.id, "tts", { provider: "OpenAI TTS", env: { K_EY: KEY_VALUE } }),
        { params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }) },
      );
      assert.equal(res.status, 403);
      assert.equal(stub.seen.length, 0);
    } finally {
      stub.close();
    }
  });

  test("bad body → 400 and the value is not echoed back", async () => {
    const stub = await startStub(() => ({ status: 200, body: {} }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import(PUT_PATH);
      const res = await PUT(
        toolPut(gateway.id, owner.id, "tts", { provider: "X", env: { bad_name: KEY_VALUE } }),
        { params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }) },
      );
      const text = await res.text();
      assert.equal(res.status, 400);
      assert.equal(text.includes(KEY_VALUE), false);
      assert.equal(stub.seen.length, 0);
    } finally {
      stub.close();
    }
  });

  test("when the plugin refuses because an install is needed, that code is carried", async () => {
    const stub = await startStub(() => ({
      status: 409,
      body: { error: "provider_needs_cli", detail: "hermes -p noah tools" },
    }));
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { PUT } = await import(PUT_PATH);
      const res = await PUT(toolPut(gateway.id, owner.id, "tts", { provider: "Piper" }), {
        params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }),
      });
      assert.equal((await res.json()).errorCode, "provider_needs_cli");
    } finally {
      stub.close();
    }
  });
});

describe("tool provider GET — readable with gateway access", () => {
  test("shared users can read the rows too (key values never come anyway)", async () => {
    const stub = await startStub(() => ({
      status: 200,
      body: {
        toolset: "tts",
        hasProviders: true,
        providers: [],
        activeProvider: null,
        cliCommand: "x",
      },
    }));
    try {
      const owner = await seedUser();
      const shared = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      await shareGateway(gateway.id, shared.id);
      const { GET } = await import(GET_PATH);
      const res = await GET(toolGet(gateway.id, shared.id, "tts"), {
        params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).hasProviders, true);
      assert.equal(stub.seen[0].url, "/p/noah/deskrpg/toolsets/tts/providers");
    } finally {
      stub.close();
    }
  });

  test("an old plugin (no route, 404) means upgrade needed; an unknown toolset 404 keeps its code", async () => {
    let mode: "missing" | "unknown" = "missing";
    const stub = await startStub(() =>
      mode === "missing"
        ? { status: 404, body: { error: "Not Found" } }
        : { status: 404, body: { error: "toolset_not_found", detail: "ghost" } },
    );
    try {
      const owner = await seedUser();
      const gateway = await seedGatewayWithProfile(owner.id, stub.baseUrl);
      const { GET } = await import(GET_PATH);
      const ctx = { params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "tts" }) };
      const old = await (await GET(toolGet(gateway.id, owner.id, "tts"), ctx)).json();
      assert.equal(old.errorCode, "plugin_upgrade_required");
      mode = "unknown";
      const ctx2 = { params: Promise.resolve({ id: gateway.id, name: "noah", toolset: "ghost" }) };
      const unknown = await (await GET(toolGet(gateway.id, owner.id, "ghost"), ctx2)).json();
      assert.equal(unknown.errorCode, "toolset_not_found");
    } finally {
      stub.close();
    }
  });
});
