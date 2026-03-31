import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureSqliteCompatibility } from "./index";

test("ensureSqliteCompatibility backfills legacy rows for new RBAC columns", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      login_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE npcs (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL
    );
  `);

  sqlite.prepare(
    "INSERT INTO users (id, login_id, nickname, password_hash) VALUES (?, ?, ?, ?)",
  ).run("user-1", "legacy-user", "Legacy", "hash");
  sqlite.prepare(
    "INSERT INTO channels (id, name, owner_id) VALUES (?, ?, ?)",
  ).run("channel-1", "General", "user-1");

  ensureSqliteCompatibility(sqlite);

  const userColumns = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const channelColumns = sqlite.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;

  assert.ok(userColumns.some((column) => column.name === "system_role"));
  assert.ok(channelColumns.some((column) => column.name === "group_id"));

  const userRow = sqlite.prepare("SELECT system_role FROM users WHERE id = ?").get("user-1") as { system_role: string };
  const channelRow = sqlite.prepare("SELECT group_id FROM channels WHERE id = ?").get("channel-1") as { group_id: string | null };

  assert.equal(userRow.system_role, "user");
  assert.equal(channelRow.group_id, null);
});
