// SQLite bootstrap verification for conversation_reads (0022).
// An empty DB gets it from the base schema alone, and a DB created before 0022 gets the table
// added by ensureSqliteCompatibility. If the two paths diverge, only one side of users sees
// "no such table".
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");
const { ensureConversationReads } = require("./sqlite-conversation-reads.js");
const { ensureSqliteCompatibility } = require("./server-db.js");

const EXPECTED_COLUMNS = ["user_id", "kind", "target_id", "read_at", "seen_ids"];

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

function addUser(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at) VALUES (?,?,?,'x',datetime('now'),datetime('now'))`,
  ).run(id, id, id);
}

/** The base schema before 0022 — with the conversation_reads block stripped out. */
function legacyBaseSchema(): string {
  const start = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS conversation_reads");
  const end = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS meeting_minutes");
  assert.ok(start > 0 && end > start, "conversation_reads block not found in the base schema");
  return SQLITE_BASE_SCHEMA.slice(0, start) + SQLITE_BASE_SCHEMA.slice(end);
}

test("an empty DB gets conversation_reads from the base schema alone", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  assert.ok(tableExists(db, "conversation_reads"));
  assert.deepEqual(columnNames(db, "conversation_reads"), EXPECTED_COLUMNS);
  assert.deepEqual(primaryKeyColumns(db, "conversation_reads"), ["user_id", "kind", "target_id"]);
});

test("a DB from before 0022 gets the table added by ensureSqliteCompatibility — same result run twice", () => {
  const db = new Database(":memory:");
  db.exec(legacyBaseSchema());
  assert.equal(tableExists(db, "conversation_reads"), false);

  ensureSqliteCompatibility(db);
  ensureSqliteCompatibility(db);

  assert.ok(tableExists(db, "conversation_reads"));
  assert.deepEqual(columnNames(db, "conversation_reads"), EXPECTED_COLUMNS);
  assert.deepEqual(primaryKeyColumns(db, "conversation_reads"), ["user_id", "kind", "target_id"]);
});

test("the shared module is idempotent on its own too", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);`);
  ensureConversationReads(db);
  ensureConversationReads(db);
  assert.ok(tableExists(db, "conversation_reads"));
});

test("(user_id, kind, target_id) is the composite primary key", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  addUser(db, "u1");
  const insert = db.prepare(
    `INSERT INTO conversation_reads (user_id, kind, target_id, read_at) VALUES ('u1',?,'t1',datetime('now'))`,
  );
  insert.run("room");
  insert.run("dm"); // the same target id under another kind is a different row
  assert.throws(() => insert.run("room"), /UNIQUE constraint failed/);
});

test("deleting a user cascades the read state away", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  addUser(db, "u2");
  db.prepare(
    `INSERT INTO conversation_reads (user_id, kind, target_id, read_at) VALUES ('u2','room','r1',datetime('now'))`,
  ).run();
  db.prepare(`DELETE FROM users WHERE id='u2'`).run();
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM conversation_reads`).get() as { n: number }).n,
    0,
  );
});
