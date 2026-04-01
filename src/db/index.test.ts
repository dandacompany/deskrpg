import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureSqliteCompatibility, getDefaultSqlitePath } from "./index.ts";

test("getDefaultSqlitePath falls back to the DeskRPG home data directory", () => {
  process.env.DESKRPG_HOME = "/tmp/deskrpg-runtime";
  const originalSqlitePath = process.env.SQLITE_PATH;
  delete process.env.SQLITE_PATH;

  assert.equal(getDefaultSqlitePath(), "/tmp/deskrpg-runtime/data/deskrpg.db");

  if (originalSqlitePath === undefined) {
    delete process.env.SQLITE_PATH;
  } else {
    process.env.SQLITE_PATH = originalSqlitePath;
  }
});

test("ensureSqliteCompatibility does not pre-create bootstrap RBAC rows for an empty legacy sqlite deployment", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      login_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      owner_id TEXT
    );
    CREATE TABLE npcs (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL
    );
  `);

  ensureSqliteCompatibility(sqlite);

  const groupsCount = sqlite.prepare("SELECT COUNT(*) AS count FROM groups").get() as { count: number };
  const groupMembersCount = sqlite.prepare("SELECT COUNT(*) AS count FROM group_members").get() as { count: number };

  assert.equal(groupsCount.count, 0);
  assert.equal(groupMembersCount.count, 0);
});

test("ensureSqliteCompatibility creates RBAC tables and backfills a legacy sqlite deployment", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      login_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT
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
    "INSERT INTO users (id, login_id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-2", "later-user", "Later", "hash", "2026-03-31T12:00:00.000Z");
  sqlite.prepare(
    "INSERT INTO users (id, login_id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "earliest-user", "Earliest", "hash", "2026-03-30T12:00:00.000Z");
  sqlite.prepare(
    "INSERT INTO channels (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
  ).run("channel-1", "General", "user-2", "2026-03-31T13:00:00.000Z");

  ensureSqliteCompatibility(sqlite);

  const tableNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const userColumns = sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const channelColumns = sqlite.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;

  assert.ok(tableNames.some((table) => table.name === "groups"));
  assert.ok(tableNames.some((table) => table.name === "group_members"));
  assert.ok(tableNames.some((table) => table.name === "group_invites"));
  assert.ok(tableNames.some((table) => table.name === "group_join_requests"));
  assert.ok(tableNames.some((table) => table.name === "group_permissions"));
  assert.ok(tableNames.some((table) => table.name === "user_permission_overrides"));
  assert.ok(userColumns.some((column) => column.name === "system_role"));
  assert.ok(channelColumns.some((column) => column.name === "group_id"));

  const defaultGroup = sqlite.prepare(
    "SELECT id, slug, is_default FROM groups WHERE slug = 'default'",
  ).get() as { id: string; slug: string; is_default: number };
  const bootstrapUser = sqlite.prepare(
    "SELECT system_role FROM users WHERE id = ?",
  ).get("user-1") as { system_role: string };
  const laterUser = sqlite.prepare(
    "SELECT system_role FROM users WHERE id = ?",
  ).get("user-2") as { system_role: string };
  const membership = sqlite.prepare(
    "SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
  ).get(defaultGroup.id, "user-1") as { role: string };
  const channelRow = sqlite.prepare(
    "SELECT group_id FROM channels WHERE id = ?",
  ).get("channel-1") as { group_id: string | null };

  assert.equal(defaultGroup.slug, "default");
  assert.equal(defaultGroup.is_default, 1);
  assert.equal(bootstrapUser.system_role, "system_admin");
  assert.equal(laterUser.system_role, "user");
  assert.equal(membership.role, "group_admin");
  assert.equal(channelRow.group_id, defaultGroup.id);

  ensureSqliteCompatibility(sqlite);

  const defaultGroupCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM groups WHERE slug = 'default'",
  ).get() as { count: number };
  const membershipCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND user_id = ?",
  ).get(defaultGroup.id, "user-1") as { count: number };
  const systemAdminCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE system_role = 'system_admin'",
  ).get() as { count: number };

  assert.equal(defaultGroupCount.count, 1);
  assert.equal(membershipCount.count, 1);
  assert.equal(systemAdminCount.count, 1);
});

test("ensureSqliteCompatibility dedupes legacy group join requests before adding unique index", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      login_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT
    );
    CREATE TABLE npcs (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id)
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE group_join_requests (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  sqlite.prepare(
    "INSERT INTO users (id, login_id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("user-1", "user1", "User 1", "hash", "2026-03-30T12:00:00.000Z");
  sqlite.prepare(
    "INSERT INTO groups (id, name, slug, description, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("group-1", "Group 1", "group-1", null, 0, "user-1", "2026-03-30T12:00:00.000Z", "2026-03-30T12:00:00.000Z");
  sqlite.prepare(
    "INSERT INTO group_join_requests (id, group_id, user_id, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("req-old", "group-1", "user-1", "rejected", "old", "2026-03-30T12:00:00.000Z");
  sqlite.prepare(
    "INSERT INTO group_join_requests (id, group_id, user_id, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("req-new", "group-1", "user-1", "pending", "new", "2026-03-31T12:00:00.000Z");

  ensureSqliteCompatibility(sqlite);

  const rows = sqlite.prepare(
    "SELECT id, status FROM group_join_requests WHERE group_id = ? AND user_id = ? ORDER BY created_at DESC",
  ).all("group-1", "user-1") as Array<{ id: string; status: string }>;
  const uniqueIndex = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'group_join_requests_group_user_unique'",
  ).get() as { name?: string } | undefined;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "req-new");
  assert.equal(rows[0].status, "pending");
  assert.equal(uniqueIndex?.name, "group_join_requests_group_user_unique");
});
