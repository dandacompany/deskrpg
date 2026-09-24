// src/db/character-bio.test.ts
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

test("an empty SQLite boot has characters.bio", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  ensureSqliteCompatibility(db);
  assert.ok(columns(db, "characters").includes("bio"));
});

test("an existing SQLite DB without bio also gets it created on boot", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, nickname TEXT NOT NULL UNIQUE);
    CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, appearance TEXT NOT NULL, created_at TEXT, updated_at TEXT);`);
  ensureSqliteCompatibility(db);
  assert.ok(columns(db, "characters").includes("bio"));
  // Calling it twice doesn't break anything (idempotent).
  ensureSqliteCompatibility(db);
});
