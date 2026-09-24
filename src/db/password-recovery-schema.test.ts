// src/db/password-recovery-schema.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

import { ensureSqliteCompatibility } from "./index";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js") as { SQLITE_BASE_SCHEMA: string };

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test("an empty SQLite boot has users.must_change_password", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  ensureSqliteCompatibility(db);
  assert.ok(columns(db, "users").includes("must_change_password"));
});

test("an existing SQLite DB without the column also gets must_change_password created as 0", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT, updated_at TEXT);`);
  db.prepare(
    "INSERT INTO users (id, login_id, nickname, password_hash) VALUES ('u1','dante','단테','hash')",
  ).run();

  ensureSqliteCompatibility(db);

  assert.ok(columns(db, "users").includes("must_change_password"));
  const row = db
    .prepare("SELECT must_change_password AS flag FROM users WHERE id = 'u1'")
    .get() as {
    flag: number;
  };
  assert.equal(row.flag, 0);
  // Calling it twice doesn't break anything (idempotent).
  ensureSqliteCompatibility(db);
});
