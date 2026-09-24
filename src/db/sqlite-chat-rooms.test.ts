import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ensureChatRoomTables } = require("./sqlite-chat-rooms.js");
const { SQLITE_BASE_SCHEMA } = require("./sqlite-base-schema.js");

function freshDb() {
  const db = new Database(":memory:");
  db.exec(SQLITE_BASE_SCHEMA);
  db.prepare(
    `INSERT INTO users (id, login_id, nickname, password_hash, created_at, updated_at) VALUES ('u1','u','u','x',datetime('now'),datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO channels (id, name, owner_id, created_at, updated_at) VALUES ('c1','c','u1',datetime('now'),datetime('now'))`,
  ).run();
  return db;
}

test("creates the 3 tables and backfills one office room per channel — still one after running twice", () => {
  const db = freshDb();
  ensureChatRoomTables(db);
  ensureChatRoomTables(db);
  const rooms = db
    .prepare(`SELECT kind, name, reply_policy, created_by FROM chat_rooms WHERE channel_id='c1'`)
    .all();
  assert.deepEqual(rooms, [
    { kind: "office", name: "office", reply_policy: "mention", created_by: "u1" },
  ]);
  for (const t of ["chat_rooms", "chat_room_members", "chat_room_messages"]) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), t);
  }
});

test("one office room per channel — partial unique index", () => {
  const db = freshDb();
  ensureChatRoomTables(db);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO chat_rooms (id, channel_id, kind, name, reply_policy, created_by, created_at) VALUES ('r2','c1','office','office','mention','u1',datetime('now'))`,
      )
      .run(),
  );
});

test("deleting a room cascades away its messages and members", () => {
  const db = freshDb();
  db.pragma("foreign_keys = ON");
  ensureChatRoomTables(db);
  db.prepare(
    `INSERT INTO chat_rooms (id, channel_id, kind, name, reply_policy, created_by, created_at) VALUES ('g1','c1','group','g','members','u1',datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO chat_room_members (room_id, member_kind, member_id, joined_at) VALUES ('g1','user','u1',datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO chat_room_messages (id, room_id, sender_kind, sender_id, sender_name, content, created_at) VALUES ('m1','g1','user','u1','u','hi',datetime('now'))`,
  ).run();
  db.prepare(`DELETE FROM chat_rooms WHERE id='g1'`).run();
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM chat_room_messages`).get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM chat_room_members`).get() as { n: number }).n,
    0,
  );
});

test("without channels.owner_id, the backfill is skipped and a warning is logged", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE channels (id TEXT PRIMARY KEY NOT NULL);
  `);
  db.prepare(`INSERT INTO users (id) VALUES ('u1')`).run();
  db.prepare(`INSERT INTO channels (id) VALUES ('c1')`).run();

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    ensureChatRoomTables(db);
  } finally {
    console.warn = originalWarn;
  }

  for (const t of ["chat_rooms", "chat_room_members", "chat_room_messages"]) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), t);
  }
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM chat_rooms`).get() as { n: number }).n,
    0,
    "owner_id 가 없으니 office 백필은 일어나지 않아야 한다",
  );
  const matching = warnings.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("office room backfill")),
  );
  assert.equal(matching.length, 1, "office 방 백필 스킵 경고가 정확히 한 번 찍혀야 한다");
});
