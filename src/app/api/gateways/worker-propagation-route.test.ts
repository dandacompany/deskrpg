import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

// The entry point for "설정에서 켜기" (gateway screen) — writes the worker propagation operator setting to the host.
// It runs commands on the host, so it passes the same doors as the plugin update route: login, same origin, owner,
// host policy. Host-side behavior (writing the setting, applying) is pinned by host.test.ts and worker-propagation.test.ts.
const home = mkdtempSync(path.join(tmpdir(), "worker-propagation-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

function req(
  gatewayId: string,
  userId?: string,
  body: unknown = { enabled: true },
  origin = "http://localhost:3102",
) {
  return new NextRequest(
    `http://localhost:3102/api/gateways/${gatewayId}/plugin/worker-propagation`,
    {
      method: "POST",
      headers: {
        host: "localhost:3102",
        origin,
        "content-type": "application/json",
        ...(userId ? { "x-user-id": userId } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function user(role = "system_admin") {
  const { db, users } = await import("@/db");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Propagation-${randomUUID()}`,
      passwordHash: "test-only",
      systemRole: role,
    })
    .returning();
  return row.id;
}

async function gateway(ownerUserId: string, baseUrl: string) {
  const { upsertOwnedGatewayResource } = await import("@/lib/gateway-resources");
  return upsertOwnedGatewayResource({
    ownerUserId,
    baseUrl,
    token: "token-for-tests-0123456789",
    displayName: "전파 테스트",
  });
}

test("unauthenticated is 401 and cross-origin requests are 403", async () => {
  const { POST } = await import("./[id]/plugin/worker-propagation/route");
  const owner = await user();
  const row = await gateway(owner, "http://127.0.0.1:18742");
  assert.equal((await POST(req(row.id), params(row.id))).status, 401);
  const cross = await POST(
    req(row.id, owner, { enabled: true }, "https://evil.example.com"),
    params(row.id),
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).errorCode, "setup_bad_origin");
});

test("a non-boolean enabled is 400 before reaching the host", async () => {
  const { POST } = await import("./[id]/plugin/worker-propagation/route");
  const owner = await user();
  const row = await gateway(owner, "http://127.0.0.1:18743");
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, "not json"]) {
    const res = await POST(req(row.id, owner, body), params(row.id));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).errorCode, "setup_invalid_request");
  }
});

test("someone else's gateway is 404 — even a shared one cannot change host settings", async () => {
  const { POST } = await import("./[id]/plugin/worker-propagation/route");
  const owner = await user();
  const other = await user();
  const row = await gateway(owner, "http://127.0.0.1:18744");
  const res = await POST(req(row.id, other), params(row.id));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).errorCode, "setup_not_found");
});

test("hosts where commands cannot run say why — the screen falls back to copying the command", async () => {
  process.env.DESKRPG_HOST_SETUP_ENABLED = "1";
  const { POST } = await import("./[id]/plugin/worker-propagation/route");
  const owner = await user();
  const row = await gateway(owner, "http://host.docker.internal:8642");
  const res = await POST(req(row.id, owner), params(row.id));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, "plugin_update_unsupported_host");
});

test("blocked for non-admins or when the operator turned host setup off", async () => {
  const { POST } = await import("./[id]/plugin/worker-propagation/route");
  const ordinary = await user("user");
  const ordinaryRow = await gateway(ordinary, "http://127.0.0.1:18745");
  const ordinaryRes = await POST(req(ordinaryRow.id, ordinary), params(ordinaryRow.id));
  assert.equal(ordinaryRes.status, 403);
  assert.equal((await ordinaryRes.json()).errorCode, "setup_forbidden");

  process.env.DESKRPG_HOST_SETUP_ENABLED = "0";
  try {
    const owner = await user();
    const row = await gateway(owner, "http://127.0.0.1:18746");
    const res = await POST(req(row.id, owner), params(row.id));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).errorCode, "setup_forbidden");
  } finally {
    delete process.env.DESKRPG_HOST_SETUP_ENABLED;
  }
});
