// SQLite bootstrap verification for npc_panel_reads (0019).
// An empty DB gets it from the base schema alone, and a DB created before 0019 gets the table
// added by ensureSqliteCompatibility. If the two paths diverge, only one side of users sees
// "no such table".
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
const { ensureNpcPanelReads } = require("./sqlite-npc-panel-reads.js");
const { ensureSqliteCompatibility } = require("./server-db.js");

const EXPECTED_COLUMNS = ["user_id", "npc_id", "tab", "seen_at", "seen_ids"];

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
  );
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function primaryKeyColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
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
  db.prepare(
    `INSERT INTO hermes_profiles (id, gateway_id, profile_name, token_encrypted, created_at, updated_at) VALUES ('p1','g1','sophie','enc',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO npcs (id, channel_id, hermes_profile_id, position_x, position_y, created_at, updated_at) VALUES ('n1','c1','p1',0,0,datetime('now'),datetime('now'))`,
  ).run();
}

/** The base schema before 0019 — with the npc_panel_reads block stripped out. */
function legacyBaseSchema(): string {
  const start = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS npc_panel_reads");
  const end = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS meeting_minutes");
  assert.ok(start > 0 && end > start, "기본 스키마의 npc_panel_reads 블록 위치를 찾지 못했습니다");
  return SQLITE_BASE_SCHEMA.slice(0, start) + SQLITE_BASE_SCHEMA.slice(end);
}

test("an empty DB gets npc_panel_reads from the base schema alone", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  assert.ok(tableExists(db, "npc_panel_reads"));
  assert.deepEqual(columnNames(db, "npc_panel_reads"), EXPECTED_COLUMNS);
  assert.deepEqual(primaryKeyColumns(db, "npc_panel_reads"), ["user_id", "npc_id", "tab"]);
});

test("a DB from before 0019 gets the table added by ensureSqliteCompatibility — same result run twice", () => {
  const db = new Database(":memory:");
  db.exec(legacyBaseSchema());
  assert.equal(tableExists(db, "npc_panel_reads"), false, "npc_panel_reads 가 미리 있으면 안 된다");

  ensureSqliteCompatibility(db);
  ensureSqliteCompatibility(db);

  assert.ok(tableExists(db, "npc_panel_reads"));
  assert.deepEqual(columnNames(db, "npc_panel_reads"), EXPECTED_COLUMNS);
  assert.deepEqual(primaryKeyColumns(db, "npc_panel_reads"), ["user_id", "npc_id", "tab"]);
});

test("the shared module is idempotent on its own too", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE npcs (id TEXT PRIMARY KEY NOT NULL);
  `);
  ensureNpcPanelReads(db);
  ensureNpcPanelReads(db);
  assert.ok(tableExists(db, "npc_panel_reads"));
});

test("(user_id, npc_id, tab) is the composite primary key", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  seedFixture(db);
  const insert = db.prepare(
    `INSERT INTO npc_panel_reads (user_id, npc_id, tab, seen_at, seen_ids) VALUES ('u1','n1',?,datetime('now'),?)`,
  );
  insert.run("cron", null); // the cron row has seen_ids as NULL
  insert.run("cards", '["t1"]'); // fine as long as the tab differs
  assert.throws(
    () => insert.run("cron", null),
    /UNIQUE constraint failed/,
    "같은 (user, npc, tab) 은 두 번 들어가면 안 된다",
  );
});

test("deleting a user or an NPC cascades the read state away", () => {
  // u1 is the channel owner and can't be deleted (channels.owner_id blocks it) — verify with u2, who only has a read state.
  for (const [what, sql] of [
    ["users", `DELETE FROM users WHERE id='u2'`],
    ["npcs", `DELETE FROM npcs WHERE id='n1'`],
  ] as const) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SQLITE_BASE_SCHEMA);
    seedFixture(db);
    db.prepare(
      `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at) VALUES ('u2','u2','u2','x',datetime('now'),datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO npc_panel_reads (user_id, npc_id, tab, seen_at) VALUES ('u2','n1','cards',datetime('now'))`,
    ).run();
    db.prepare(sql).run();
    assert.equal(
      (db.prepare(`SELECT count(*) AS n FROM npc_panel_reads`).get() as { n: number }).n,
      0,
      `${what} 삭제가 cascade 되지 않았습니다`,
    );
  }
});
