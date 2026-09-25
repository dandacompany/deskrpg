import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import type { PluginCapability } from "./plugin-capability";
import type { buildPluginCacheUpdate as BuildPluginCacheUpdateFn } from "./plugin-cache-update";

const require = createRequire(import.meta.url);

// PostgreSQL: a `timestamp(withTimezone)` column is in date mode, so the driver expects a `Date`.
// SQLite: a `text` column expects a string. `buildPluginCacheUpdate()` now calls
// `nowForDb()` itself (there is no slot for the caller to inject a value — Task 9 round 3), so to
// observe that dialect branch we must re-load `src/db/index.ts` itself at the point `nowForDb()` is captured.
// `isPostgres` is a constant fixed at that module's load time
// (same incident as task-manager-timestamps.test.ts), so we clear the require cache, change the env var,
// and re-load `db/index.ts` and `plugin-cache-update.ts` together in the same process —
// so that plugin-cache-update.ts's `import { nowForDb } from "@/db"` points at the freshly
// loaded db/index.ts again.
function loadBuildPluginCacheUpdate(env: {
  DB_TYPE: string;
  DATABASE_URL?: string;
}): typeof BuildPluginCacheUpdateFn {
  const prevDbType = process.env.DB_TYPE;
  const prevDatabaseUrl = process.env.DATABASE_URL;
  process.env.DB_TYPE = env.DB_TYPE;
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  else delete process.env.DATABASE_URL;

  const dbModulePath = require.resolve("../../db/index.ts");
  const pluginCacheUpdateModulePath = require.resolve("./plugin-cache-update.ts");
  delete require.cache[dbModulePath];
  delete require.cache[pluginCacheUpdateModulePath];
  const { buildPluginCacheUpdate } = require("./plugin-cache-update.ts") as {
    buildPluginCacheUpdate: typeof BuildPluginCacheUpdateFn;
  };

  if (prevDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = prevDbType;
  if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDatabaseUrl;

  return buildPluginCacheUpdate;
}

// Regression guard for verdicts D·F: pins, per dialect, the value TYPE of the payload the gateway test route
// passes to db.update(...).set(...). Reverting `nowForDb()` to `new Date().toISOString()`
// must make the PG dialect case fail — verified by actually reverting it (see task-9-report.md).
//
// Final review I-1 follow-up: moved here from `plugin-capability.test.ts` —
// because `buildPluginCacheUpdate` itself moved from `plugin-capability.ts` to `plugin-cache-update.ts`
// (server-only) (that file is imported directly from client components and
// can no longer carry `@/db` — see the module header comment).
describe("buildPluginCacheUpdate", () => {
  const plugin: PluginCapability = { status: "plugin_ready", version: "0.3.0" };

  it("PostgreSQL dialect: the nowForDb() it calls itself yields a Date", () => {
    const buildPluginCacheUpdate = loadBuildPluginCacheUpdate({
      DB_TYPE: "postgresql",
      DATABASE_URL: "postgres://fake:fake@localhost:5432/fake",
    });

    const payload = buildPluginCacheUpdate(plugin);
    assert.ok(payload.pluginCheckedAt instanceof Date, "PG 방언에서는 Date 여야 한다");
    assert.ok(payload.updatedAt instanceof Date);
  });

  it("SQLite dialect: the nowForDb() it calls itself yields an ISO string", () => {
    const buildPluginCacheUpdate = loadBuildPluginCacheUpdate({ DB_TYPE: "sqlite" });

    const payload = buildPluginCacheUpdate(plugin);
    assert.equal(typeof payload.pluginCheckedAt, "string", "SQLite 방언에서는 문자열이어야 한다");
    assert.equal(typeof payload.updatedAt, "string");
  });
});

// The automation contract block (capabilities·timezone·kanban of `/deskrpg/info`) is stored
// as a JSON string in `gateway_resources.plugin_info_json` (a text column). The helper only exchanges
// strings; callers merge `{ pluginInfoJson }` into `.set()`.
describe("plugin_info_json serialization", () => {
  it("puts a JSON string in pluginInfoJson when info exists, null otherwise", async () => {
    const { buildPluginInfoCacheUpdate, restorePluginInfo } = await import("./plugin-cache-update");
    const info = {
      plugin: "deskrpg" as const,
      version: "0.7.1",
      capabilities: ["kanban", "cron", "events"],
      timezone: "Asia/Seoul",
      kanban: { dispatcher_present: true, attachments: false },
      // The gateway list pulls the dashboard address from this cache — dropping it from the round trip makes the
      // button vanish.
      dashboard_url: "https://deskrpg-hermes.srv1.hstgr.cloud",
    };
    const payload = buildPluginInfoCacheUpdate(info);
    assert.equal(typeof payload.pluginInfoJson, "string");
    assert.deepEqual(restorePluginInfo(payload.pluginInfoJson), info);

    const absent = buildPluginInfoCacheUpdate(null);
    assert.equal(absent.pluginInfoJson, null);
  });

  it("restorePluginInfo folds broken JSON and unfamiliar shapes into null", async () => {
    const { restorePluginInfo } = await import("./plugin-cache-update");
    assert.equal(restorePluginInfo(null), null);
    assert.equal(restorePluginInfo("{not json"), null);
    assert.equal(restorePluginInfo(JSON.stringify({ hello: "world" })), null);
  });
});
