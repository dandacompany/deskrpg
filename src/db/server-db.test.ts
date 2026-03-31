import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

const require = createRequire(import.meta.url);

test("server-db sqlite exports Task 1 RBAC schema and backfills legacy columns", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-server-db-"));
  const sqlitePath = path.join(tempDir, "server-db-test.sqlite");

  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = sqlitePath;

  const modulePath = require.resolve("./server-db.js");
  delete require.cache[modulePath];

  const { ensureSqliteCompatibility, schema, isPostgres } = require("./server-db.js") as {
    ensureSqliteCompatibility: (sqlite: Database.Database) => void;
    schema: Record<string, unknown>;
    isPostgres: boolean;
  };

  assert.equal(isPostgres, false);
  assert.ok(schema.groups);
  assert.ok(schema.groupMembers);
  assert.ok(schema.groupInvites);
  assert.ok(schema.groupJoinRequests);
  assert.ok(schema.groupPermissions);
  assert.ok(schema.userPermissionOverrides);

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

  const userRow = sqlite.prepare("SELECT system_role FROM users WHERE id = ?").get("user-1") as { system_role: string };
  const channelRow = sqlite.prepare("SELECT group_id FROM channels WHERE id = ?").get("channel-1") as { group_id: string | null };

  assert.equal(userRow.system_role, "user");
  assert.equal(channelRow.group_id, null);
});
