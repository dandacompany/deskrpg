import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

const home = mkdtempSync(path.join(tmpdir(), "diagnostics-route-"));
process.env.DESKRPG_HOME = home;
process.env.SQLITE_PATH = path.join(home, "test.db");
process.env.DB_TYPE = "sqlite";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const url = "http://localhost:3102/api/admin/diagnostics";
const req = (userId?: string) =>
  new NextRequest(url, {
    headers: { host: "localhost:3102", ...(userId ? { "x-user-id": userId } : {}) },
  });

async function user(role: string) {
  const { db, users } = await import("@/db");
  const [row] = await db
    .insert(users)
    .values({
      loginId: randomUUID(),
      nickname: `Diag-${randomUUID()}`,
      passwordHash: "test-only",
      systemRole: role,
    })
    .returning();
  return row.id;
}

test("non-admins and anonymous requests get 404, not 403", async () => {
  const { GET } = await import("./route");
  assert.equal((await GET(req())).status, 404);
  const ordinary = await user("user");
  const denied = await GET(req(ordinary));
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).errorCode, "not_found");
  // Pushing a nonexistent user id through the header gives the same 404.
  assert.equal((await GET(req(randomUUID()))).status, 404);
});

test("admins get the environment, DB, host settings and gateway sections", async () => {
  const { GET } = await import("./route");
  const admin = await user("system_admin");
  const { db, gatewayResources } = await import("@/db");
  const [gateway] = await db
    .insert(gatewayResources)
    .values({
      ownerUserId: admin,
      displayName: "진단용 게이트웨이",
      baseUrl: "http://127.0.0.1:8642",
      tokenEncrypted: "diagnostics-secret-token-value",
      pluginStatus: "ready",
    })
    .returning();

  const res = await GET(req(admin));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.environment.errors));
  assert.ok(Array.isArray(body.environment.warnings));
  assert.equal(body.environment.dbTarget, "sqlite");
  assert.equal(typeof body.database.ok, "boolean");
  assert.equal(typeof body.database.message, "string");
  // Since 2026-09-19 the default is on for admins — both are true unless the operator turned them off with 0.
  assert.deepEqual(body.hostSetup, { wizard: true, hermesInstall: true });
  const row = body.gateways.find((entry: { id: string }) => entry.id === gateway.id);
  assert.ok(row, "등록한 게이트웨이가 목록에 있어야 한다");
  assert.equal(row.label, "진단용 게이트웨이");
  assert.equal(row.pluginStatus, "ready");
  assert.equal(row.checkedAt, null);
});

test("the response body carries no gateway token or baseUrl string", async () => {
  const { GET } = await import("./route");
  const admin = await user("system_admin");
  const { db, gatewayResources } = await import("@/db");
  await db.insert(gatewayResources).values({
    ownerUserId: admin,
    displayName: "토큰 보관 게이트웨이",
    baseUrl: "http://10.7.7.7:8642",
    tokenEncrypted: "super-secret-token-must-not-leak",
    pluginStatus: "ready",
  });
  const text = await (await GET(req(admin))).text();
  assert.equal(text.includes("super-secret-token-must-not-leak"), false);
  assert.equal(text.includes("10.7.7.7"), false);
  assert.equal(text.includes("tokenEncrypted"), false);
});

test("returns diagnostics with 200 even when the DB is unreachable", async () => {
  const { GET } = await import("./route");
  const admin = await user("system_admin");
  const original = process.env.SQLITE_PATH;
  // A path that neither exists nor can be created — the probe fails but diagnostics must continue.
  process.env.SQLITE_PATH = "/deskrpg-does-not-exist-root/data/deskrpg.db";
  try {
    const res = await GET(req(admin));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.database.ok, false);
    assert.ok(body.database.message.length > 0);
    assert.ok(Array.isArray(body.gateways));
  } finally {
    process.env.SQLITE_PATH = original;
  }
});

test("messages follow the viewer's locale cookie without touching process.env", async () => {
  const { GET } = await import("./route");
  const admin = await user("system_admin");
  const before = process.env.LC_ALL;
  const withCookie = (cookie?: string) =>
    new NextRequest(url, {
      headers: {
        host: "localhost:3102",
        "x-user-id": admin,
        ...(cookie ? { cookie } : {}),
      },
    });

  const korean = await (await GET(withCookie("deskrpg-locale=ko"))).json();
  assert.match(korean.database.message, /^SQLite 파일/);
  const english = await (await GET(withCookie())).json();
  assert.match(english.database.message, /^The SQLite file/);
  const japanese = await (await GET(withCookie("deskrpg-locale=ja"))).json();
  assert.match(japanese.database.message, /^The SQLite file/);
  assert.equal(process.env.LC_ALL, before);
});
