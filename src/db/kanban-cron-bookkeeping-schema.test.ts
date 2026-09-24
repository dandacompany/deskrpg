// SQLite bootstrap verification for the kanban/cron ledger (0011).
// An empty DB gets it from the base schema alone, and a DB created before 0011 gets the
// table/columns added by ensureSqliteCompatibility. If the two paths diverge, only one
// side of users sees "no such column".
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
const { ensureKanbanCronBookkeeping } = require("./sqlite-kanban-cron-bookkeeping.js");
const { ensureSqliteCompatibility } = require("./server-db.js");

const NEW_TABLES = ["channel_kanban_boards", "cron_job_origins"] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
  );
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function seedFixture(db: Database.Database) {
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at) VALUES ('u1','u','u','x',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO channels (id, name, owner_id, created_at, updated_at) VALUES ('c1','c','u1',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO gateway_resources (id, owner_user_id, display_name, base_url, token_encrypted, created_at, updated_at) VALUES ('g1','u1','gw','http://gw','enc',datetime('now'),datetime('now'))`,
  ).run();
}

/** The base schema before 0011 — with the two new tables and two columns stripped out. */
function legacyBaseSchema(): string {
  const stripped = SQLITE_BASE_SCHEMA.replace(/\n\s*plugin_info_json TEXT,/, "").replace(
    /\n\s*notice_json TEXT,/,
    "",
  );
  // The new table block sits after the chat_room_messages index and before meeting_minutes.
  const start = stripped.indexOf("    CREATE TABLE IF NOT EXISTS channel_kanban_boards");
  const end = stripped.indexOf("    CREATE TABLE IF NOT EXISTS meeting_minutes");
  assert.ok(start > 0 && end > start, "기본 스키마의 칸반·cron 블록 위치를 찾지 못했습니다");
  return stripped.slice(0, start) + stripped.slice(end);
}

test("an empty DB gets the new tables/columns from the base schema alone", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  for (const t of NEW_TABLES) assert.ok(tableExists(db, t), t);
  assert.ok(columnNames(db, "gateway_resources").includes("plugin_info_json"));
  assert.ok(columnNames(db, "chat_room_messages").includes("notice_json"));
  assert.deepEqual(columnNames(db, "channel_kanban_boards"), [
    // 0017 moved the PK to a surrogate key and added the event-carrier board flag.
    "id",
    "channel_id",
    "gateway_id",
    "board_slug",
    "is_event_carrier",
    "board_name_synced_at",
    "event_cursor",
    "event_carrier_handoff_json",
    "last_polled_at",
    "last_error",
    "created_at",
    "updated_at",
  ]);
  assert.deepEqual(columnNames(db, "cron_job_origins"), [
    "id",
    "gateway_id",
    "profile_name",
    "job_id",
    "channel_id",
    "created_by_user_id",
    "created_at",
  ]);
});

test("a DB from before 0011 gets the table/columns added by ensureSqliteCompatibility — same result run twice", () => {
  const legacy = legacyBaseSchema();
  const db = new Database(":memory:");
  db.exec(legacy);
  for (const t of NEW_TABLES)
    assert.equal(tableExists(db, t), false, `${t} 가 미리 있으면 안 된다`);
  assert.ok(!columnNames(db, "gateway_resources").includes("plugin_info_json"));
  assert.ok(!columnNames(db, "chat_room_messages").includes("notice_json"));

  ensureSqliteCompatibility(db);
  ensureSqliteCompatibility(db);

  for (const t of NEW_TABLES) assert.ok(tableExists(db, t), t);
  assert.ok(columnNames(db, "gateway_resources").includes("plugin_info_json"));
  assert.ok(columnNames(db, "chat_room_messages").includes("notice_json"));
});

test("the shared module is idempotent on its own too, and skips only that ALTER when chat_room_messages is missing", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE gateway_resources (id TEXT PRIMARY KEY NOT NULL);
  `);
  ensureKanbanCronBookkeeping(db);
  ensureKanbanCronBookkeeping(db);
  for (const t of NEW_TABLES) assert.ok(tableExists(db, t), t);
  assert.ok(columnNames(db, "gateway_resources").includes("plugin_info_json"));
  assert.equal(tableExists(db, "chat_room_messages"), false);
});

test("cron_job_origins is unique on (gateway_id, profile_name, job_id)", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  seedFixture(db);
  const insert = db.prepare(
    `INSERT INTO cron_job_origins (id, gateway_id, profile_name, job_id, channel_id, created_by_user_id, created_at)
     VALUES (?, 'g1', ?, ?, 'c1', 'u1', datetime('now'))`,
  );
  insert.run("o1", "sophie", "job-a");
  insert.run("o2", "sophie", "job-b"); // fine as long as the job differs
  insert.run("o3", "other", "job-a"); // fine as long as the profile differs
  assert.throws(
    () => insert.run("o4", "sophie", "job-a"),
    /UNIQUE constraint failed/,
    "같은 (gateway, profile, job) 은 두 번 등록되면 안 된다",
  );
});

test("deleting a channel cascades the board binding and cron origins away", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  seedFixture(db);
  db.prepare(
    `INSERT INTO channel_kanban_boards (id, channel_id, gateway_id, board_slug, created_at, updated_at) VALUES ('b1','c1','g1','board',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO cron_job_origins (id, gateway_id, profile_name, job_id, channel_id, created_by_user_id, created_at) VALUES ('o1','g1','sophie','job-a','c1','u1',datetime('now'))`,
  ).run();

  db.prepare(`DELETE FROM channels WHERE id='c1'`).run();
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM channel_kanban_boards`).get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM cron_job_origins`).get() as { n: number }).n,
    0,
  );
});
