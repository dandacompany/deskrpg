import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { encryptGatewayToken, listAccessibleGatewayResources } from "./gateway-resources";

// DB-backed, sharing the same pattern as other files in this repo (hermes-profiles.test.ts, etc.).
const sqlitePath = path.join(os.tmpdir(), `gateway-resources-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

async function loadDb() {
  return import("@/db");
}

// Same reason as `nowForDb()` (src/db/index.ts) — PG expects a Date for a
// timestamp(withTimezone) column, while SQLite expects an ISO string for a text column.
// Inserting an arbitrary timestamp needs the same dialect branch.
async function dbTimestamp(d: Date): Promise<Date> {
  const { isPostgres } = await loadDb();
  return (isPostgres ? d : d.toISOString()) as unknown as Date;
}

async function seedUser(nickname: string) {
  const { db, users } = await loadDb();
  const [user] = await db
    .insert(users)
    .values({
      loginId: `${nickname}-${crypto.randomUUID().slice(0, 8)}`,
      nickname: `${nickname}-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "hash",
    })
    .returning();
  return user;
}

// Final review I-1: pins down that listAccessibleGatewayResources actually returns the
// pluginStatus/pluginVersion/pluginCheckedAt cache columns Task 4 added. Without this
// wiring, HermesProfileList (the UI layer, no render tests) has no way to read the
// cache at all, so every screen entry unconditionally re-hit /test — this test catches
// that regression at the lowest point it can reach (the data layer).
describe("listAccessibleGatewayResources — plugin cache columns (final review I-1)", () => {
  test("returns an owned gateway's pluginStatus/pluginVersion/pluginCheckedAt as-is", async () => {
    const owner = await seedUser("owner");
    const { db, gatewayResources } = await loadDb();
    const checkedAt = new Date("2026-08-31T23:50:00Z");
    await db.insert(gatewayResources).values({
      ownerUserId: owner.id,
      displayName: "Cached Gateway",
      baseUrl: "http://gw.test",
      tokenEncrypted: encryptGatewayToken("gateway-key-1234567890"),
      pluginStatus: "plugin_ready",
      pluginVersion: "0.3.0",
      pluginCheckedAt: await dbTimestamp(checkedAt),
    });

    const rows = await listAccessibleGatewayResources(owner.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pluginStatus, "plugin_ready");
    assert.equal(rows[0].pluginVersion, "0.3.0");
    assert.ok(rows[0].pluginCheckedAt, "pluginCheckedAt 이 내려와야 캐시 신선도를 판정할 수 있다");
  });

  test("a gateway with no cache yet returns null as-is (doesn't fake freshness)", async () => {
    const owner = await seedUser("owner2");
    const { db, gatewayResources } = await loadDb();
    await db.insert(gatewayResources).values({
      ownerUserId: owner.id,
      displayName: "Fresh Gateway",
      baseUrl: "http://gw2.test",
      tokenEncrypted: encryptGatewayToken("gateway-key-0987654321"),
    });

    const rows = await listAccessibleGatewayResources(owner.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pluginStatus, null);
    assert.equal(rows[0].pluginCheckedAt, null);
  });

  test("a shared gateway also returns the same cache fields", async () => {
    const owner = await seedUser("owner3");
    const sharedUser = await seedUser("shared3");
    const { db, gatewayResources, gatewayShares } = await loadDb();
    const [gateway] = await db
      .insert(gatewayResources)
      .values({
        ownerUserId: owner.id,
        displayName: "Shared Gateway",
        baseUrl: "http://gw3.test",
        tokenEncrypted: encryptGatewayToken("gateway-key-1122334455"),
        pluginStatus: "plugin_absent",
        pluginCheckedAt: await dbTimestamp(new Date()),
      })
      .returning();
    await db
      .insert(gatewayShares)
      .values({ gatewayId: gateway.id, userId: sharedUser.id, role: "use" });

    const rows = await listAccessibleGatewayResources(sharedUser.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pluginStatus, "plugin_absent");
    assert.equal(rows[0].isOwner, false);
  });
});

describe("listAccessibleGatewayResources — Hermes dashboard URL", () => {
  const info = (dashboardUrl: string | null) =>
    JSON.stringify({
      plugin: "deskrpg",
      version: "0.7.1",
      capabilities: ["kanban", "cron", "events"],
      timezone: "Asia/Seoul",
      kanban: { dispatcher_present: true, attachments: true },
      dashboard_url: dashboardUrl,
    });

  test("returns the dashboard URL from cached plugin info to the owner", async () => {
    const owner = await seedUser("dash-owner");
    const { db, gatewayResources } = await loadDb();
    await db.insert(gatewayResources).values({
      ownerUserId: owner.id,
      displayName: "Dashboard Gateway",
      baseUrl: "http://hermes:8642",
      tokenEncrypted: encryptGatewayToken("gateway-key-dash-000001"),
      pluginStatus: "plugin_ready",
      pluginInfoJson: info("https://deskrpg-hermes.srv1.hstgr.cloud"),
    });
    const rows = await listAccessibleGatewayResources(owner.id);
    assert.equal(rows[0].dashboardUrl, "https://deskrpg-hermes.srv1.hstgr.cloud");
  });

  test("null if there's no cache or no URL", async () => {
    const owner = await seedUser("dash-none");
    const { db, gatewayResources } = await loadDb();
    await db.insert(gatewayResources).values({
      ownerUserId: owner.id,
      displayName: "No Dashboard",
      baseUrl: "http://gw-nodash.test",
      tokenEncrypted: encryptGatewayToken("gateway-key-dash-000002"),
    });
    const rows = await listAccessibleGatewayResources(owner.id);
    assert.equal(rows[0].dashboardUrl, null);
  });

  test("a shared user doesn't get the dashboard URL — it's a screen for managing all of Hermes", async () => {
    const owner = await seedUser("dash-owner2");
    const sharedUser = await seedUser("dash-shared");
    const { db, gatewayResources, gatewayShares } = await loadDb();
    const [gateway] = await db
      .insert(gatewayResources)
      .values({
        ownerUserId: owner.id,
        displayName: "Shared Dashboard Gateway",
        baseUrl: "http://gw-shared-dash.test",
        tokenEncrypted: encryptGatewayToken("gateway-key-dash-000003"),
        pluginStatus: "plugin_ready",
        pluginInfoJson: info("https://deskrpg-hermes.srv2.hstgr.cloud"),
      })
      .returning();
    await db
      .insert(gatewayShares)
      .values({ gatewayId: gateway.id, userId: sharedUser.id, role: "use" });
    const rows = await listAccessibleGatewayResources(sharedUser.id);
    assert.equal(rows[0].dashboardUrl, null);
  });
});
