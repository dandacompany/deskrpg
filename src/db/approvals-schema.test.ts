// SQLite bootstrap verification for the approvals record (0016).
// An empty DB gets it from the base schema alone, and a DB created before this change
// gets the table added by re-running the same base schema (`CREATE TABLE IF NOT EXISTS`).
// If the two paths diverge, only one side of users sees "no such table: approvals".
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");

const NEW_TABLES = ["approvals", "approval_targets"] as const;

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
  );
}

/** The base schema before this change — with the new table block stripped out. */
function legacyBaseSchema(): string {
  const start = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS approvals (");
  const end = SQLITE_BASE_SCHEMA.indexOf("    CREATE TABLE IF NOT EXISTS meeting_minutes");
  assert.ok(start > 0 && end > start, "기본 스키마의 승인 블록 위치를 찾지 못했습니다");
  return SQLITE_BASE_SCHEMA.slice(0, start) + SQLITE_BASE_SCHEMA.slice(end);
}

test("an empty DB gets the approvals table from the base schema alone", () => {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  for (const t of NEW_TABLES) assert.ok(tableExists(db, t), t);
  db.close();
});

test("a DB from before this change also gets the table added by re-running the base schema", () => {
  const db = new Database(":memory:");
  db.exec(legacyBaseSchema());
  for (const t of NEW_TABLES)
    assert.equal(tableExists(db, t), false, `${t} 가 미리 있으면 안 된다`);
  db.exec(SQLITE_BASE_SCHEMA);
  for (const t of NEW_TABLES) assert.ok(tableExists(db, t), t);
  db.close();
});

test("re-running against a DB with existing rows keeps the data", () => {
  const db = new Database(":memory:");
  db.exec(legacyBaseSchema());
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at)
     VALUES ('u1','u','u','x',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO channels (id, name, owner_id, created_at, updated_at)
     VALUES ('c1','c','u1',datetime('now'),datetime('now'))`,
  ).run();
  db.exec(SQLITE_BASE_SCHEMA);
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM channels`).get() as { n: number }).n,
    1,
    "재실행이 기존 데이터를 지우면 안 된다",
  );
  db.close();
});

test("one approval can have N cards attached, and 0 target rows is also allowed", () => {
  // Chunk 1's '프로젝트로 등록할까요?' has no card targets, so it comes in with 0 rows.
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at)
     VALUES ('u1','u','u','x',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO channels (id, name, owner_id, created_at, updated_at)
     VALUES ('c1','c','u1',datetime('now'),datetime('now'))`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO approvals (id, channel_id, type, status, requested_by, title, source_json, created_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))`,
  );
  insert.run(
    "a1",
    "c1",
    "task_execution",
    "pending",
    "sophie",
    "7건 수행할까요?",
    '{"kind":"meeting","id":"m1"}',
  );
  insert.run(
    "a2",
    "c1",
    "project_registration",
    "pending",
    "sophie",
    "프로젝트로 등록할까요?",
    '{"kind":"meeting","id":"m1"}',
  );
  const target = db.prepare(`INSERT INTO approval_targets (approval_id, task_id) VALUES (?,?)`);
  target.run("a1", "task-1");
  target.run("a1", "task-2");
  assert.equal(
    (
      db.prepare(`SELECT count(*) AS n FROM approval_targets WHERE approval_id='a1'`).get() as {
        n: number;
      }
    ).n,
    2,
  );
  assert.equal(
    (
      db.prepare(`SELECT count(*) AS n FROM approval_targets WHERE approval_id='a2'`).get() as {
        n: number;
      }
    ).n,
    0,
    "대상 없는 type 도 공존한다",
  );
  db.close();
});

test("deleting an approval also deletes its targets", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SQLITE_BASE_SCHEMA);
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at)
     VALUES ('u1','u','u','x',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO channels (id, name, owner_id, created_at, updated_at)
     VALUES ('c1','c','u1',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO approvals (id, channel_id, type, status, requested_by, title, source_json, created_at)
     VALUES ('a1','c1','task_execution','pending','sophie','t','{}',datetime('now'))`,
  ).run();
  db.prepare(`INSERT INTO approval_targets (approval_id, task_id) VALUES ('a1','task-1')`).run();
  db.prepare(`DELETE FROM approvals WHERE id='a1'`).run();
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM approval_targets`).get() as { n: number }).n,
    0,
  );
  db.close();
});
