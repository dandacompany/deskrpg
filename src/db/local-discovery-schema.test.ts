import test from "node:test";
import assert from "node:assert/strict";

import { gatewayResources as pgTable } from "./schema";
import { gatewayResources as sqliteTable } from "./schema-sqlite";

const NEW_COLUMNS = ["local_discovery_opted_in_at", "local_discovery_opted_in_by"];

test("옵인 컬럼이 두 dialect 모두에 있다", () => {
  for (const [label, table] of [["pg", pgTable], ["sqlite", sqliteTable]] as const) {
    const names = Object.values(table).map((c) => (c as { name?: string })?.name).filter(Boolean);
    for (const col of NEW_COLUMNS) {
      assert.ok(names.includes(col), `[${label}] ${col} 컬럼이 없다`);
    }
  }
});

test("빈 SQLite DB를 부트스트랩해도 옵인 컬럼이 생긴다", async () => {
  // 런타임 부트스트랩 경로(sqlite-base-schema.js)는 drizzle 정의와 별개다.
  // 여기가 어긋나면 새 DB로 뜬 서버에서만 'no such column' 이 난다.
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

test("컬럼이 없는 기존 DB도 호환 경로가 채워준다", async () => {
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
  const names = (db.prepare("PRAGMA table_info(gateway_resources)").all() as { name: string }[])
    .map((c) => c.name);
  for (const col of NEW_COLUMNS) {
    assert.ok(names.includes(col), `${col} 이 기존 DB 마이그레이션에서 누락됐다`);
  }
  db.close();
});
