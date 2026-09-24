// src/db/channel-motion-config-schema.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { ensureSqliteCompatibility } from "./index";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js") as { SQLITE_BASE_SCHEMA: string };
const serverDb = require("./server-db.js") as { ensureSqliteCompatibility?: (db: unknown) => void };

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test("an empty SQLite boot has channels.motion_config", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  ensureSqliteCompatibility(db);
  assert.ok(columns(db, "channels").includes("motion_config"));
});

test("an existing SQLite DB without the column gets motion_config created empty on boot — both boot paths", () => {
  for (const ensure of [ensureSqliteCompatibility, serverDb.ensureSqliteCompatibility]) {
    if (!ensure) continue;
    const db = new Database(":memory:");
    db.exec(SQLITE_BASE_SCHEMA.replace(/\s*motion_config TEXT,/, ""));
    assert.ok(!columns(db, "channels").includes("motion_config"), "사전 조건: 옛 스키마");
    db.pragma("foreign_keys = OFF"); // We just need one channel row — no need to also create an owning user.
    db.prepare("INSERT INTO channels (id, name, owner_id) VALUES ('c1','채널','u1')").run();
    ensure(db);
    assert.ok(columns(db, "channels").includes("motion_config"));
    const row = db.prepare("SELECT motion_config AS m FROM channels WHERE id = 'c1'").get() as {
      m: string | null;
    };
    assert.equal(row.m, null, "기존 채널은 비어 있어야 한다 — 비어 있으면 기본값이다");
    ensure(db); // Calling it twice doesn't break anything (idempotent).
  }
});

test("the PG migration doesn't break when run again (IF NOT EXISTS)", () => {
  const sql = readFileSync(
    new URL("../../drizzle/0020_channel_motion_config.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "motion_config" jsonb/);
  assert.doesNotMatch(sql, /DROP|RENAME/i, "추가만 한다");
});
