import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Regression guard for Task 9 rounds 2 and 3.
//
// Round 1 extracted `buildPluginCacheUpdate` as a pure function and pinned only that `nowForDb()`'s per-dialect
// output (Date/string) passes through it unchanged. But that test only calls
// `buildPluginCacheUpdate` directly and never runs the POST handler of
// `src/app/api/gateways/[id]/test/route.ts` — a hole where swapping the route's call site would be
// caught by no test (measured by the team lead).
//
// Round 3 closed that hole structurally: `buildPluginCacheUpdate(plugin)` no longer receives
// `now` but calls `nowForDb()` itself (plugin-capability.ts) — so the route's call site has
// no place to pass a wrong value in the first place, and round 1's dialect test
// (plugin-capability.test.ts, reevaluating PG/SQLite via require.cache) locks that by directly observing
// the real `nowForDb()` call inside the function body. As a result, the test here that pinned the source text
// with a regex was no longer needed and was deleted (a brittle approach that broke on formatting or variable
// extraction and could pass when the meaning changed).
//
// What stays in this file is **wiring verification** — independent of timestamp types, it checks that the POST handler
// actually runs and continues `probeHermesGateway` → `probeDeskrpgPlugin` → `db.update`, and that the
// values in the response and the DB are really correct. It uses the same technique as plugin-proxy-route.test.ts
// (throwaway SQLite + a local stub Hermes server).
//
// Kept at the top level (outside the `[id]` segment) — same reason as plugin-proxy-route.test.ts:
// the node test runner mistakes `[id]` for a character class and misses the *.test.ts inside it.

const sqlitePath = path.join(os.tmpdir(), `gateway-test-route-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

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

function postReq(url: string, userId: string): NextRequest {
  return new NextRequest(url, { method: "POST", headers: { "x-user-id": userId } });
}

// For probeHermesGateway to judge it an API Server, /health must be 2xx and /v1/models must have a
// JSON content-type (see the gateway-probe.ts comment — the dashboard serves
// text/html). Then probeDeskrpgPlugin probes /deskrpg/info.
function startStubHermesServer(pluginVersion: string) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url === "/deskrpg/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plugin: "deskrpg", version: pluginVersion }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return server;
}

describe("gateway test route — actually writes the plugin cache (Task 9)", () => {
  test("once judged Hermes, POST updates gatewayResources' plugin_* columns with freshly made values", async () => {
    const server = startStubHermesServer("0.4.2");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind stub server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const owner = await seedUser();
      const gateway = await seedGateway(owner.id, baseUrl);
      const beforeCall = Date.now();

      const { POST } = await import("./[id]/test/route");
      const res = await POST(
        postReq(`http://localhost/api/gateways/${gateway.id}/test`, owner.id),
        {
          params: Promise.resolve({ id: gateway.id }),
        },
      );
      const afterCall = Date.now();

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.plugin, { status: "plugin_ready", version: "0.4.2" });

      const { db, gatewayResources } = await loadDb();
      const { eq } = await import("drizzle-orm");
      const [row] = await db
        .select()
        .from(gatewayResources)
        .where(eq(gatewayResources.id, gateway.id));

      assert.equal(row.pluginStatus, "plugin_ready");
      assert.equal(row.pluginVersion, "0.4.2");
      // T4: the automation contract block is cached in the same call too (bodies before 0.6.0 have an empty capabilities array).
      assert.ok(row.pluginInfoJson, "plugin_info_json 이 채워져야 한다");
      assert.deepEqual(JSON.parse(row.pluginInfoJson as string).capabilities, []);
      // The screen's "아직 테스트하지 않음" looks at last_validation_status. This route used to
      // write only plugin_* and leave the validation state empty, so no matter how often the connection test
      // was pressed the list did not change (staging measurement 2026-09-07). persistGatewayValidationState
      // existed before this branch but was **dead code nobody called**.
      assert.equal(row.lastValidationStatus, "valid");
      assert.equal(row.lastValidationError, null);
      assert.ok(row.lastValidatedAt, "lastValidatedAt 이 채워져야 한다");
      // Only check that the value written in the SQLite dialect really is the time just made — "did that value
      // come from nowForDb()" is locked by the structure where the function body calls nowForDb() itself
      // (round 3) + the dialect reevaluation test in plugin-capability.test.ts.
      assert.equal(typeof row.pluginCheckedAt, "string");
      const checkedAtMs = Date.parse(row.pluginCheckedAt as unknown as string);
      assert.ok(
        checkedAtMs >= beforeCall && checkedAtMs <= afterCall,
        `plugin_checked_at 이 호출 구간 안의 시각이어야 한다 (${row.pluginCheckedAt})`,
      );
    } finally {
      server.close();
    }
  });
});
