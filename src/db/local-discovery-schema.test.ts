import test from "node:test";
import assert from "node:assert/strict";

import { gatewayResources as pgTable } from "./schema";
import { gatewayResources as sqliteTable } from "./schema-sqlite";

const NEW_COLUMNS = ["local_discovery_opted_in_at", "local_discovery_opted_in_by"];

test("the opt-in columns exist in both dialects", () => {
  for (const [label, table] of [
    ["pg", pgTable],
    ["sqlite", sqliteTable],
  ] as const) {
    const names = Object.values(table)
      .map((c) => (c as { name?: string })?.name)
      .filter(Boolean);
    for (const col of NEW_COLUMNS) {
      assert.ok(names.includes(col), `[${label}] ${col} 컬럼이 없다`);
    }
  }
});

test("bootstrapping an empty SQLite DB also creates the opt-in columns", async () => {
  // The runtime bootstrap path (sqlite-base-schema.js) is separate from the drizzle definitions.
  // If this drifts, "no such column" only shows up on servers that booted from a new DB.
  const Database = (await import("better-sqlite3")).default;
  const { ensureSqliteBaseSchema } = await import("./server-db.js");
  const db = new Database(":memory:");
  ensureSqliteBaseSchema(db);
  const cols = db.prepare("PRAGMA table_info(gateway_resources)").all() as { name: string }[];
  const names = cols.map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(names.includes(col), `${col} 이 빈 DB 부트스트랩에서 누락됐다`);
  }
  db.close();
});

test("an existing DB without the columns also gets filled in by the compatibility path", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { ensureSqliteCompatibility } = await import("./server-db.js");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE gateway_resources (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureSqliteCompatibility(db);
  const names = (
    db.prepare("PRAGMA table_info(gateway_resources)").all() as { name: string }[]
  ).map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(names.includes(col), `${col} 이 기존 DB 마이그레이션에서 누락됐다`);
  }
  db.close();
});
