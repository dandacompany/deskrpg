// SQLite-side verification for the 2026-04 task system retirement (0012).
// Opening an existing DB with the old tasks / npc_reports still in it makes both bootstrap
// paths drop the tables, and an empty DB never gets them created in the first place. The user
// decided to retire it without migrating the data, so the data is not recovered.
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
const { LEGACY_TASK_TABLES, dropLegacyTaskTables } = require("./sqlite-legacy-tasks-drop.js");
const { ensureSqliteCompatibility } = require("./server-db.js");

// Exact copy of the definition that was in the base schema through 0011 (including the npc_reports → tasks FK).
const LEGACY_TASK_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    npc_id TEXT REFERENCES npcs(id) ON DELETE CASCADE,
    assigner_id TEXT NOT NULL REFERENCES characters(id),
    npc_task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
  CREATE TABLE IF NOT EXISTS npc_reports (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
`;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
  );
}

test("an empty DB's base schema has no tasks / npc_reports", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  for (const t of LEGACY_TASK_TABLES) assert.equal(tableExists(db, t), false, t);
});

test("an existing DB with the old tables still around gets them dropped by ensureSqliteCompatibility — same result run twice", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  db.exec(LEGACY_TASK_DDL);
  for (const t of LEGACY_TASK_TABLES) assert.ok(tableExists(db, t), `${t} 가 미리 있어야 한다`);

  ensureSqliteCompatibility(db);
  ensureSqliteCompatibility(db);

  for (const t of LEGACY_TASK_TABLES)
    assert.equal(tableExists(db, t), false, `${t} 는 지워져야 한다`);
  // Other tables are left untouched.
  for (const t of ["npcs", "channels", "channel_kanban_boards", "meeting_minutes"]) {
    assert.ok(tableExists(db, t), t);
  }
});

test("the shared module is idempotent on its own too, and doesn't error when the tables are missing", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);`);
  db.exec(LEGACY_TASK_DDL);
  dropLegacyTaskTables(db);
  dropLegacyTaskTables(db);
  for (const t of LEGACY_TASK_TABLES) assert.equal(tableExists(db, t), false, t);
  assert.ok(tableExists(db, "users"));
});
