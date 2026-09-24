import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "plugin-update-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

function req(gatewayId: string, userId?: string, origin = "http://localhost:3102") {
  return new NextRequest(`http://localhost:3102/api/gateways/${gatewayId}/plugin/update`, {
    method: "POST",
    headers: {
      host: "localhost:3102",
      origin,
      ...(userId ? { "x-user-id": userId } : {}),
    },
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function user(role = "system_admin") {
  const { db, users } = await import("@/db");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Update-${randomUUID()}`,
      passwordHash: "test-only",
      systemRole: role,
    })
    .returning();
  return row.id;
}

async function gateway(ownerUserId: string, baseUrl: string) {
  const { upsertOwnedGatewayResource } = await import("@/lib/gateway-resources");
  const row = await upsertOwnedGatewayResource({
    ownerUserId,
    baseUrl,
    token: "token-for-tests-0123456789",
    displayName: "내가 붙인 이름",
  });
  return row;
}

test("unauthenticated is 401 and cross-origin requests are 403 — this runs commands on the host", async () => {
  const { POST } = await import("./[id]/plugin/update/route");
  const owner = await user();
  const row = await gateway(owner, "http://127.0.0.1:18642");
  assert.equal((await POST(req(row.id), params(row.id))).status, 401);
  assert.equal(
    (await POST(req(row.id, owner, "https://evil.example.com"), params(row.id))).status,
    403,
  );
});

test("someone else's gateway is 404 — even a shared one cannot touch the host", async () => {
  const { POST } = await import("./[id]/plugin/update/route");
  const owner = await user();
  const other = await user();
  const row = await gateway(owner, "http://127.0.0.1:18643");
  const res = await POST(req(row.id, other), params(row.id));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).errorCode, "setup_not_found");
});

test("hosts where commands cannot run say why — the host address as seen from the container", async () => {
  process.env.DESKRPG_HOST_SETUP_ENABLED = "1";
  const { POST } = await import("./[id]/plugin/update/route");
  const owner = await user();
  const row = await gateway(owner, "http://host.docker.internal:8642");
  const res = await POST(req(row.id, owner), params(row.id));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, "plugin_update_unsupported_host");
});

test("updating is blocked for non-admins or when the operator turned it off", async () => {
  // The policy is open to admins by default and `=0` is the operator's refusal switch (policy.ts:16-18).
  const { POST } = await import("./[id]/plugin/update/route");
  const ordinary = await user("user");
  const ordinaryRow = await gateway(ordinary, "http://127.0.0.1:18645");
  const ordinaryRes = await POST(req(ordinaryRow.id, ordinary), params(ordinaryRow.id));
  assert.equal(ordinaryRes.status, 403);
  assert.equal((await ordinaryRes.json()).errorCode, "setup_forbidden");

  process.env.DESKRPG_HOST_SETUP_ENABLED = "0";
  const owner = await user();
  const row = await gateway(owner, "http://127.0.0.1:18644");
  const res = await POST(req(row.id, owner), params(row.id));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).errorCode, "setup_forbidden");
});
