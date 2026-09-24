import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { getTableColumns } from "drizzle-orm";

import { gatewayResources } from "./schema-sqlite";
import { gatewayResources as gatewayResourcesPg } from "./schema";

describe("gateway_resources plugin capability cache", () => {
  it("the Drizzle schema has all 3 columns", () => {
    assert.ok(gatewayResources.pluginStatus);
    assert.ok(gatewayResources.pluginVersion);
    assert.ok(gatewayResources.pluginCheckedAt);
  });

  it("the empty-DB bootstrap SQL has the same columns", () => {
    // schema-sqlite.ts does not migrate an empty runtime DB (CLAUDE.md).
    // If this drifts, it only breaks for freshly installed users — a dev DB won't show it.
    const sql = readFileSync(new URL("./sqlite-base-schema.js", import.meta.url), "utf8");
    const table = /CREATE TABLE IF NOT EXISTS gateway_resources[\s\S]*?\);/.exec(sql);
    assert.ok(table, "gateway_resources CREATE TABLE 을 찾지 못했다");
    assert.match(table[0], /plugin_status/);
    assert.match(table[0], /plugin_version/);
    assert.match(table[0], /plugin_checked_at/);
  });

  it("the PostgreSQL schema (schema.ts) also has all 3 columns — cross-dialect guard", () => {
    // schema-drift.test.ts only compares within the same dialect (schema.ts↔schema.pg.cjs,
    // schema-sqlite.ts↔schema.sqlite.cjs) and does not compare SQLite↔PostgreSQL.
    // So adding a column to the SQLite side alone still passes the drift tests green —
    // in fact, when these columns were first added, the PostgreSQL side was missing
    // entirely and it still passed. Staging (stage.deskrpg.com) runs PostgreSQL, so
    // without this guard "no such column" only shows up at runtime. Same shape as the
    // tasks table's 2026-04 regression guard (schema-drift.test.ts).
    const cols = new Set(Object.keys(getTableColumns(gatewayResourcesPg)));
    for (const required of ["pluginStatus", "pluginVersion", "pluginCheckedAt"]) {
      assert.ok(cols.has(required), `gatewayResources(PostgreSQL).${required} 가 없다`);
    }
  });
});
