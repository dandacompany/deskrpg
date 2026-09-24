import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// `POST /api/gateways/[id]/plugin/worker-plugin` — fixes employees whose kanban/cron artifacts do not accumulate and
// **refills the cache**. Applying while leaving the cache (up to an hour stale) keeps the warning —
// pure function tests cannot catch that wiring, so the route is actually run (same technique as
// gateway-test-route.test.ts: a throwaway SQLite + a local stub Hermes). The reason for staying outside `[id]` is the same too.

const sqlitePath = path.join(os.tmpdir(), `worker-plugin-route-test-${crypto.randomUUID()}.db`);
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

function postReq(url: string, userId: string, origin = "http://localhost"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "x-user-id": userId, origin, host: "localhost" },
  });
}

const GAP = { profile: "sophie", link: "missing", enabled: false, disabled: false };

/** sophie is missing before applying, and after `POST /deskrpg/worker-plugin` an empty list is reported. */
function startStubHermes() {
  const state = { applied: false, ensureCalls: 0 };
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json(200, { status: "ok" });
    if (req.url === "/v1/models") return json(200, { data: [] });
    if (req.url === "/deskrpg/info") {
      return json(200, {
        plugin: "deskrpg",
        version: "0.12.0",
        capabilities: ["kanban", "cron", "events", "worker_plugin"],
        worker_plugin: { missing: state.applied ? [] : [GAP] },
      });
    }
    if (req.url === "/deskrpg/worker-plugin" && req.method === "POST") {
      state.ensureCalls += 1;
      state.applied = true;
      return json(200, { results: [{ profile: "sophie", link: "created", enabled: "added" }] });
    }
    return json(404, { error: "not found" });
  });
  return { server, state };
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind stub server");
  return `http://127.0.0.1:${address.port}`;
}

async function cachedWarning(gatewayId: string) {
  const { db, gatewayResources } = await loadDb();
  const { eq } = await import("drizzle-orm");
  const { restorePluginInfo } = await import("@/lib/hermes/plugin-cache-update");
  const { workerPluginWarning } = await import("@/lib/hermes/worker-plugin");
  const [row] = await db.select().from(gatewayResources).where(eq(gatewayResources.id, gatewayId));
  return workerPluginWarning(restorePluginInfo(row.pluginInfoJson));
}

describe("worker plugin apply route", () => {
  test("applies and refills the cache so the warning disappears", async () => {
    const { server, state } = startStubHermes();
    const baseUrl = await listen(server);
    try {
      const owner = await seedUser();
      const gateway = await seedGateway(owner.id, baseUrl);
      // Cache before applying: sophie is missing (mimics the state the connection test filled in).
      const { db, gatewayResources } = await loadDb();
      const { eq } = await import("drizzle-orm");
      await db
        .update(gatewayResources)
        .set({
          pluginInfoJson: JSON.stringify({
            plugin: "deskrpg",
            version: "0.12.0",
            capabilities: ["kanban", "cron", "events", "worker_plugin"],
            timezone: null,
            kanban: { dispatcher_present: true, attachments: true },
            worker_plugin: { missing: [GAP] },
          }),
        })
        .where(eq(gatewayResources.id, gateway.id));
      assert.deepEqual(await cachedWarning(gateway.id), {
        fixable: ["sophie"],
        disabledByOperator: [],
      });

      const { POST } = await import("./[id]/plugin/worker-plugin/route");
      const res = await POST(
        postReq(`http://localhost/api/gateways/${gateway.id}/plugin/worker-plugin`, owner.id),
        { params: Promise.resolve({ id: gateway.id }) },
      );

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        results: [{ profile: "sophie", link: "created", enabled: "added" }],
      });
      assert.equal(state.ensureCalls, 1);
      // The key point: the cache was refilled and there is no warning.
      assert.equal(await cachedWarning(gateway.id), null);
    } finally {
      server.close();
    }
  });

  test("non-owners get 404 and the plugin is not called", async () => {
    const { server, state } = startStubHermes();
    const baseUrl = await listen(server);
    try {
      const owner = await seedUser();
      const stranger = await seedUser();
      const gateway = await seedGateway(owner.id, baseUrl);
      const { POST } = await import("./[id]/plugin/worker-plugin/route");

      const res = await POST(
        postReq(`http://localhost/api/gateways/${gateway.id}/plugin/worker-plugin`, stranger.id),
        { params: Promise.resolve({ id: gateway.id }) },
      );

      assert.equal(res.status, 404);
      assert.equal(state.ensureCalls, 0);
    } finally {
      server.close();
    }
  });

  test("cross-origin requests get 403 and the plugin is not called", async () => {
    const { server, state } = startStubHermes();
    const baseUrl = await listen(server);
    try {
      const owner = await seedUser();
      const gateway = await seedGateway(owner.id, baseUrl);
      const { POST } = await import("./[id]/plugin/worker-plugin/route");

      const res = await POST(
        postReq(
          `http://localhost/api/gateways/${gateway.id}/plugin/worker-plugin`,
          owner.id,
          "https://evil.example",
        ),
        { params: Promise.resolve({ id: gateway.id }) },
      );

      assert.equal(res.status, 403);
      assert.equal(state.ensureCalls, 0);
    } finally {
      server.close();
    }
  });
});
