import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { ensureSqliteCompatibility } from "./index";

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
