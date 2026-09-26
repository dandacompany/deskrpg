import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Regression guard for Task 5·6·7 review I-1.
//
// The review proved it on an isolated copy: removing the `requireSystemAdmin` gate (GET, POST), the
// `system_admin` branch of `[name]/route.ts` DELETE, and the profile token selection in identity and config
// still left the whole `npm run test` passing at 894 pass / 0 fail. That is because all 25 new tests in this
// batch only exercised pure functions (validation/stripApiKey/attachKeyStorage/selectProfileToken)
// — there was not a single test running a route handler. This file closes that
// hole: it imports the real `route.ts` and calls the handlers directly.
//
// The DB-backed pattern is the same as local-discovery-route.test.ts / npcs/rebind-route.test.ts —
// `db` is a lazily initialized module singleton and node:test runs each file in a separate process,
// so SQLITE_PATH is pinned once at module scope to tie it to a throwaway DB for this file
// only.
//
// Kept at the top level (outside the `[id]` segment) — when node's test runner collects files by glob it
// mistakes `[id]` for a character class and never collects `*.test.ts` nested inside it
// (for the same reason as profiles-probe-route.test.ts and local-discovery-route.test.ts, this file lives here
// rather than in a sibling directory).

const sqlitePath = path.join(os.tmpdir(), `plugin-proxy-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedUser(systemRole: "user" | "system_admin") {
  const { db, users } = await loadDb();
  const [user] = await db
    .insert(users)
    .values({
      loginId: `u-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `u-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
      systemRole,
    })
    .returning();
  return user;
}

async function seedGateway(ownerId: string, baseUrl: string) {
  const { db, gatewayResources } = await loadDb();
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
  return gateway;
}

function getReq(url: string, userId: string): NextRequest {
  return new NextRequest(url, { method: "GET", headers: { "x-user-id": userId } });
}

function mutatingReq(
  url: string,
  userId: string,
  method: "POST" | "DELETE",
  body?: unknown,
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "x-user-id": userId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// A loopback address nobody listens on. The 403 tests in this suite are supposed to fail if they get
// this far — while the permission gate is alive it returns before the plugin call, so no network is
// needed at all.
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

describe("plugin proxy permission gate — non-system_admin users cannot list, create or delete (I-1a)", () => {
  test("GET /plugin/profiles by a non-system_admin gateway owner → 403 forbidden", async () => {
    const owner = await seedUser("user");
    const gateway = await seedGateway(owner.id, UNREACHABLE_BASE_URL);
    const { GET } = await import("./[id]/plugin/profiles/route");
    const res = await GET(
      getReq(`http://localhost/api/gateways/${gateway.id}/plugin/profiles`, owner.id),
      { params: Promise.resolve({ id: gateway.id }) },
    );
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, "forbidden");
  });

  test("POST /plugin/profiles by a non-system_admin gateway owner → 403 forbidden (the plugin is not called)", async () => {
    const owner = await seedUser("user");
    const gateway = await seedGateway(owner.id, UNREACHABLE_BASE_URL);
    const { POST } = await import("./[id]/plugin/profiles/route");
    const res = await POST(
      mutatingReq(`http://localhost/api/gateways/${gateway.id}/plugin/profiles`, owner.id, "POST", {
        name: "noah",
      }),
      { params: Promise.resolve({ id: gateway.id }) },
    );
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, "forbidden");
  });

  test("DELETE /plugin/profiles/{name} by a non-system_admin gateway owner → 403 forbidden (the plugin is not called)", async () => {
    const owner = await seedUser("user");
    const gateway = await seedGateway(owner.id, UNREACHABLE_BASE_URL);
    const { DELETE } = await import("./[id]/plugin/profiles/[name]/route");
    const res = await DELETE(
      mutatingReq(
        `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah`,
        owner.id,
        "DELETE",
      ),
      { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
    );
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.errorCode, "forbidden");
  });
});

describe("plugin proxy token scope — unregistered profiles do not fall back to default (I-1b)", () => {
  test("identity GET for an unregistered profile → 404 no_profile", async () => {
    const admin = await seedUser("system_admin");
    const gateway = await seedGateway(admin.id, UNREACHABLE_BASE_URL);
    const { GET } = await import("./[id]/plugin/profiles/[name]/identity/route");
    const res = await GET(
      getReq(`http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/identity`, admin.id),
      { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
    );
    // identity/config GET return a NextResponse on every branch, but because `resolve()`
    // returns a discriminated union, TS mixes `| undefined` into the return type
    // (repro: narrowing a union with two `?: undefined` sibling properties via `"in"` in an async function
    // still leaves undefined in the inferred return type). At runtime it is never
    // undefined, so narrow it with an assertion and move on — this is not a problem to fix
    // in route.ts itself.
    assert.ok(res, "GET 은 항상 NextResponse 를 반환해야 한다");
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.errorCode, "no_profile");
  });

  test("config GET for an unregistered profile → 404 no_profile", async () => {
    const admin = await seedUser("system_admin");
    const gateway = await seedGateway(admin.id, UNREACHABLE_BASE_URL);
    const { GET } = await import("./[id]/plugin/profiles/[name]/config/route");
    const res = await GET(
      getReq(`http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/config`, admin.id),
      { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
    );
    assert.ok(res, "GET 은 항상 NextResponse 를 반환해야 한다");
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.errorCode, "no_profile");
  });
});

describe("plugin proxy token scope — registered profiles go out only with their own token (I-1c)", () => {
  test("identity GET goes out with Authorization: Bearer <profile token> — not the default (gateway) token", async () => {
    // A local stub gateway. It records the Authorization header arriving at /p/{name}/deskrpg/identity
    // as is — which token the route actually sent as Bearer cannot be told from the response body,
    // so the outgoing request itself must be observed.
    const seenAuth: string[] = [];
    const server = http.createServer((httpReq, httpRes) => {
      seenAuth.push(httpReq.headers.authorization ?? "");
      httpRes.writeHead(200, { "content-type": "application/json" });
      httpRes.end(JSON.stringify({ body: "hello", isDefaultTemplate: false, revision: "rev-1" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);

      const { db, hermesProfiles } = await loadDb();
      const { encryptGatewayToken } = await import("@/lib/gateway-resources");
      const PROFILE_TOKEN = "profile-scoped-key-abcdefgh01";
      await db.insert(hermesProfiles).values({
        gatewayId: gateway.id,
        profileName: "noah",
        tokenEncrypted: encryptGatewayToken(PROFILE_TOKEN),
        displayName: "noah",
      });

      const { GET } = await import("./[id]/plugin/profiles/[name]/identity/route");
      const res = await GET(
        getReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/identity`,
          admin.id,
        ),
        { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
      );
      assert.ok(res, "GET 은 항상 NextResponse 를 반환해야 한다");
      assert.equal(res.status, 200);
      assert.equal(seenAuth.length, 1, "라우트가 스텁 게이트웨이를 정확히 한 번 불러야 한다");
      assert.equal(seenAuth[0], `Bearer ${PROFILE_TOKEN}`);
      assert.notEqual(
        seenAuth[0],
        "Bearer gateway-default-key-1234567890",
        "default 로 폴백하면 안 된다 — 폴백하면 Hermes 가 401 을 내고 사용자는 " +
          "'이 프로필이 등록되지 않았다'는 진짜 원인을 볼 수 없다",
      );
    } finally {
      server.close();
    }
  });
});

describe("plugin proxy — records a reason when keyIssued:true arrives with an empty apiKey (M-3)", () => {
  test("POST /plugin/profiles keeps 201 but carries keyStored:false together with keyStoredError", async () => {
    // A rare path where the plugin reports "the key was issued" while omitting apiKey itself.
    // Using attachKeyStorage(safe, null) as is would be indistinguishable from "nothing was issued at all"
    // and send keyStored:false without a reason — here there must be a reason.
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(200, { "content-type": "application/json" });
      httpRes.end(JSON.stringify({ name: "noah", keyIssued: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);

      const { POST } = await import("./[id]/plugin/profiles/route");
      const res = await POST(
        mutatingReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles`,
          admin.id,
          "POST",
          { name: "noah" },
        ),
        { params: Promise.resolve({ id: gateway.id }) },
      );
      const body = await res.json();
      assert.equal(res.status, 201, "프로필 자체는 실제로 만들어졌으니 201 을 유지한다");
      assert.equal(body.keyIssued, true);
      assert.equal(body.keyStored, false);
      // Final review M-3: this value must be a code from the wizard-error-codes.ts dictionary,
      // not a Korean sentence rendered as is on screen — so en/ja/zh users also see
      // translated text.
      assert.equal(body.keyStoredError, "key_missing_after_issue");
      assert.equal("apiKey" in body, false);
    } finally {
      server.close();
    }
  });
});

describe("plugin proxy — DELETE does not pass path-traversal names to the remote (M-1)", () => {
  test("name '..' is 400 invalid_profile_name and the plugin is not called", async () => {
    // encodeURIComponent does not escape ".". With name=="..",
    // `/deskrpg/profiles/..` folds into `/deskrpg/` through URL normalization and the profile scope
    // silently disappears (exactly the warning in profile-name.ts) — it must not reach the remote unvalidated.
    const admin = await seedUser("system_admin");
    const gateway = await seedGateway(admin.id, UNREACHABLE_BASE_URL);
    const { DELETE } = await import("./[id]/plugin/profiles/[name]/route");
    const res = await DELETE(
      mutatingReq(
        `http://localhost/api/gateways/${gateway.id}/plugin/profiles/..`,
        admin.id,
        "DELETE",
      ),
      { params: Promise.resolve({ id: gateway.id, name: ".." }) },
    );
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.errorCode, "invalid_profile_name");
  });
});

describe("plugin proxy — on DELETE success the local registration row is removed too (M-4)", () => {
  test("when the remote delete succeeds the hermes_profiles row disappears too", async () => {
    // Without deleting it, a profile the gateway no longer has stays in the DeskRPG list, and NPCs bound to it
    // fail only at conversation time.
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(200, { "content-type": "application/json" });
      httpRes.end(
        JSON.stringify({ name: "noah", removed: { profileDir: true, wrapperScript: true } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);

      const { db, hermesProfiles } = await loadDb();
      const { encryptGatewayToken } = await import("@/lib/gateway-resources");
      await db.insert(hermesProfiles).values({
        gatewayId: gateway.id,
        profileName: "noah",
        tokenEncrypted: encryptGatewayToken("profile-scoped-key-abcdefgh01"),
        displayName: "noah",
      });

      const { DELETE } = await import("./[id]/plugin/profiles/[name]/route");
      const res = await DELETE(
        mutatingReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah`,
          admin.id,
          "DELETE",
        ),
        { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
      );
      assert.equal(res.status, 200);

      const { eq, and } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(hermesProfiles)
        .where(
          and(eq(hermesProfiles.gatewayId, gateway.id), eq(hermesProfiles.profileName, "noah")),
        );
      assert.equal(rows.length, 0, "삭제 성공 후 로컬 등록 행이 남아 있으면 안 된다");
    } finally {
      server.close();
    }
  });
});

describe("plugin proxy — failure responses carry upstreamStatus (fix round 1)", () => {
  // The proxy always carries failures as HTTP 200 + errorCode (an extension of Cloudflare replacing origin 5xx
  // with its own page). If the original upstream status code were lost in the process,
  // 401 and 404 without a structured `error` field would both collapse into `plugin_error`,
  // and the principle "401 and 404 ask the user for opposite actions" would regress at this layer
  // (the problem classifyPluginProbe already had at the gateway level). Pin at the route level that the
  // upstreamStatus field carries that original status code as is.

  test("identity GET — an upstream 401 (no structured error) arrives as upstreamStatus:401", async () => {
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(401, { "content-type": "application/json" });
      httpRes.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);
      const { db, hermesProfiles } = await loadDb();
      const { encryptGatewayToken } = await import("@/lib/gateway-resources");
      await db.insert(hermesProfiles).values({
        gatewayId: gateway.id,
        profileName: "noah",
        tokenEncrypted: encryptGatewayToken("profile-scoped-key-abcdefgh01"),
        displayName: "noah",
      });

      const { GET } = await import("./[id]/plugin/profiles/[name]/identity/route");
      const res = await GET(
        getReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/identity`,
          admin.id,
        ),
        { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
      );
      assert.ok(res);
      const body = await res.json();
      assert.equal(res.status, 200, "실패도 200 규약을 유지한다");
      assert.equal(
        body.errorCode,
        "gateway_auth_failed",
        "a 401 without a structured error still reads as a refused key",
      );
      assert.equal(body.upstreamStatus, 401, "그러나 원 상태 코드는 그대로 살아남는다");
    } finally {
      server.close();
    }
  });

  test("identity GET — an upstream 404 (no structured error) arrives as upstreamStatus:404", async () => {
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(404, { "content-type": "application/json" });
      httpRes.end(JSON.stringify({}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);
      const { db, hermesProfiles } = await loadDb();
      const { encryptGatewayToken } = await import("@/lib/gateway-resources");
      await db.insert(hermesProfiles).values({
        gatewayId: gateway.id,
        profileName: "noah",
        tokenEncrypted: encryptGatewayToken("profile-scoped-key-abcdefgh01"),
        displayName: "noah",
      });

      const { GET } = await import("./[id]/plugin/profiles/[name]/identity/route");
      const res = await GET(
        getReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah/identity`,
          admin.id,
        ),
        { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
      );
      assert.ok(res);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.errorCode, "plugin_error");
      assert.equal(body.upstreamStatus, 404, "이 값이 없으면 401 과 404 를 화면에서 가를 수 없다");
    } finally {
      server.close();
    }
  });

  test("POST /plugin/profiles — an upstream 409 (already_exists) also carries upstreamStatus", async () => {
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(409, { "content-type": "application/json" });
      httpRes.end(JSON.stringify({ error: "already_exists", name: "noah" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);

      const { POST } = await import("./[id]/plugin/profiles/route");
      const res = await POST(
        mutatingReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/profiles`,
          admin.id,
          "POST",
          {
            name: "noah",
          },
        ),
        { params: Promise.resolve({ id: gateway.id }) },
      );
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.errorCode, "already_exists");
      assert.equal(
        body.upstreamStatus,
        409,
        "명명된 코드가 있는 경로도 upstreamStatus 를 잃지 않는다",
      );
    } finally {
      server.close();
    }
  });

  test("DELETE /plugin/profiles/{name} — a network reach failure is upstreamStatus:0", async () => {
    // Nobody listens on UNREACHABLE_BASE_URL, so the client produces `{status:0}`
    // (UNREACHABLE in plugin-client.ts). That value must be carried as is too, so "could not reach" and
    // "the remote refused" are told apart on screen.
    const admin = await seedUser("system_admin");
    const gateway = await seedGateway(admin.id, UNREACHABLE_BASE_URL);
    const { DELETE } = await import("./[id]/plugin/profiles/[name]/route");
    const res = await DELETE(
      mutatingReq(
        `http://localhost/api/gateways/${gateway.id}/plugin/profiles/noah`,
        admin.id,
        "DELETE",
      ),
      { params: Promise.resolve({ id: gateway.id, name: "noah" }) },
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.errorCode, "unreachable");
    assert.equal(body.upstreamStatus, 0);
  });
});

describe("plugin proxy — reports how many channels the created profile actually clocked into", () => {
  // The wizard's ④ placement showed "이미 채널에 자동 출근했습니다" unconditionally. Clocking in only happens in
  // **channels that gateway is already attached to**, so without attached channels that sentence is
  // false (Hostinger VPS measurement 2026-09-17: it said clocked in even though there were no channels).
  async function createProfile(gatewayId: string, adminId: string) {
    const { POST } = await import("./[id]/plugin/profiles/route");
    const res = await POST(
      mutatingReq(`http://localhost/api/gateways/${gatewayId}/plugin/profiles`, adminId, "POST", {
        name: "noah",
      }),
      { params: Promise.resolve({ id: gatewayId }) },
    );
    return { res, body: await res.json() };
  }

  async function withStubPlugin<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const server = http.createServer((_httpReq, httpRes) => {
      httpRes.writeHead(200, { "content-type": "application/json" });
      httpRes.end(
        JSON.stringify({ name: "noah", keyIssued: true, apiKey: "profile-key-abcdefghij" }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      server.close();
    }
  }

  test("attendedChannels is 0 when no channels are attached", async () => {
    await withStubPlugin(async (baseUrl) => {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);
      const { res, body } = await createProfile(gateway.id, admin.id);
      assert.equal(res.status, 201);
      assert.equal(body.keyStored, true);
      assert.equal(body.attendedChannels, 0, "채널이 없는데 출근했다고 말하면 안 된다");
    });
  });

  test("attendedChannels equals the number of channels the gateway is attached to", async () => {
    await withStubPlugin(async (baseUrl) => {
      const admin = await seedUser("system_admin");
      const gateway = await seedGateway(admin.id, baseUrl);
      const { seedChannel } = await import("@/test-setup/npc-seed");
      const { db, channelGatewayBindings } = await loadDb();
      for (const name of ["사무실 A", "사무실 B"]) {
        const channel = await seedChannel(admin.id, name);
        await db
          .insert(channelGatewayBindings)
          .values({ channelId: channel.id, gatewayId: gateway.id, boundByUserId: admin.id });
      }
      const { body } = await createProfile(gateway.id, admin.id);
      assert.equal(body.attendedChannels, 2);
    });
  });
});
