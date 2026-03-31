// src/db/index.ts
import { randomUUID } from "node:crypto";
import * as pgSchema from "./schema";
import type BetterSqlite3 from "better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const DB_TYPE = (process.env.DB_TYPE || "postgresql").toLowerCase();
export const isPostgres = DB_TYPE === "postgresql" || DB_TYPE === "postgres";

/** Serialize JSON for DB insert — PG handles objects natively, SQLite needs strings */
export function jsonForDb(value: unknown): unknown {
  if (isPostgres) return value;
  return value == null ? null : JSON.stringify(value);
}

// Schema re-export: use the correct schema for the active DB dialect at runtime.
// PG schema uses uuid().defaultRandom() → gen_random_uuid() (PG-only),
// SQLite schema uses text().$defaultFn(() => crypto.randomUUID()) (JS-level).
// We cast to PG schema types so TypeScript sees the correct column types.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const activeSchema: typeof pgSchema = isPostgres ? pgSchema : require("./schema-sqlite");

// Re-export all table objects from the active schema
export const users = activeSchema.users;
export const characters = activeSchema.characters;
export const groups = activeSchema.groups;
export const channels = activeSchema.channels;
export const groupMembers = activeSchema.groupMembers;
export const groupInvites = activeSchema.groupInvites;
export const groupJoinRequests = activeSchema.groupJoinRequests;
export const groupPermissions = activeSchema.groupPermissions;
export const userPermissionOverrides = activeSchema.userPermissionOverrides;
export const channelMembers = activeSchema.channelMembers;
export const maps = activeSchema.maps;
export const mapPortals = activeSchema.mapPortals;
export const npcs = activeSchema.npcs;
export const chatMessages = activeSchema.chatMessages;
export const meetingMinutes = activeSchema.meetingMinutes;
export const tasks = activeSchema.tasks;
export const mapTemplates = activeSchema.mapTemplates;
export const stamps = activeSchema.stamps;
export const tilesetImages = activeSchema.tilesetImages;
export const projects = activeSchema.projects;
export const projectTilesets = activeSchema.projectTilesets;
export const projectStamps = activeSchema.projectStamps;

// Use PG type for all API routes — Drizzle's runtime API is identical across dialects.
type DbInstance = NodePgDatabase<typeof pgSchema>;

let _db: DbInstance | null = null;

function sqliteTableExists(sqlite: BetterSqlite3.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function sqliteColumnExists(sqlite: BetterSqlite3.Database, tableName: string, columnName: string): boolean {
  if (!sqliteTableExists(sqlite, tableName)) return false;

  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function applySqliteAlterStatements(sqlite: BetterSqlite3.Database, tableName: string, statements: string[]) {
  if (!sqliteTableExists(sqlite, tableName)) return;

  for (const statement of statements) {
    try {
      sqlite.exec(statement);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
  }
}

function getSqliteUserOrderBy(sqlite: BetterSqlite3.Database): string {
  return sqliteColumnExists(sqlite, "users", "created_at")
    ? "created_at IS NULL ASC, created_at ASC, rowid ASC"
    : "rowid ASC";
}

function ensureSqliteBootstrapUser(sqlite: BetterSqlite3.Database): string | null {
  if (!sqliteTableExists(sqlite, "users") || !sqliteColumnExists(sqlite, "users", "system_role")) {
    return null;
  }

  const orderBy = getSqliteUserOrderBy(sqlite);
  const existingAdmin = sqlite.prepare(
    `SELECT id FROM users WHERE system_role = 'system_admin' ORDER BY ${orderBy} LIMIT 1`,
  ).get() as { id: string } | undefined;
  if (existingAdmin) return existingAdmin.id;

  const earliestUser = sqlite.prepare(`SELECT id FROM users ORDER BY ${orderBy} LIMIT 1`).get() as { id: string } | undefined;
  if (!earliestUser) return null;

  sqlite.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(earliestUser.id);
  return earliestUser.id;
}

function ensureSqliteDefaultGroup(sqlite: BetterSqlite3.Database, createdBy: string | null): string | null {
  if (!sqliteTableExists(sqlite, "groups") || !sqliteTableExists(sqlite, "users")) return null;

  const existingGroup = sqlite.prepare(
    "SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1",
  ).get() as { id: string } | undefined;
  if (existingGroup) {
    sqlite.prepare("UPDATE groups SET is_default = 1 WHERE id = ?").run(existingGroup.id);
    return existingGroup.id;
  }

  const now = new Date().toISOString();
  const groupId = randomUUID();
  sqlite.prepare(`
    INSERT OR IGNORE INTO groups (id, name, slug, description, is_default, created_by, created_at, updated_at)
    VALUES (?, 'Default', 'default', 'Default workspace', 1, ?, ?, ?)
  `).run(groupId, createdBy, now, now);

  const defaultGroup = sqlite.prepare(
    "SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1",
  ).get() as { id: string } | undefined;
  return defaultGroup?.id ?? null;
}

function ensureSqliteBootstrapGroupAdminMembership(
  sqlite: BetterSqlite3.Database,
  groupId: string | null,
  userId: string | null,
) {
  if (!groupId || !userId || !sqliteTableExists(sqlite, "group_members")) return;

  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT OR IGNORE INTO group_members (id, group_id, user_id, role, approved_by, approved_at, joined_at)
    VALUES (?, ?, ?, 'group_admin', ?, ?, ?)
  `).run(randomUUID(), groupId, userId, userId, now, now);
  sqlite.prepare(`
    UPDATE group_members
    SET role = 'group_admin',
        approved_by = COALESCE(approved_by, ?),
        approved_at = COALESCE(approved_at, ?)
    WHERE group_id = ? AND user_id = ?
  `).run(userId, now, groupId, userId);
}

function assignLegacyChannelsToDefaultGroup(sqlite: BetterSqlite3.Database, groupId: string | null) {
  if (!groupId || !sqliteTableExists(sqlite, "channels") || !sqliteColumnExists(sqlite, "channels", "group_id")) {
    return;
  }

  sqlite.prepare("UPDATE channels SET group_id = ? WHERE group_id IS NULL").run(groupId);
}

export function ensureSqliteCompatibility(sqlite: BetterSqlite3.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      joined_at TEXT NOT NULL,
      UNIQUE(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);
    CREATE TABLE IF NOT EXISTS group_invites (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      target_login_id TEXT,
      expires_at TEXT,
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_invites_group_id ON group_invites(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_invites_target_user_id ON group_invites(target_user_id);
    CREATE TABLE IF NOT EXISTS group_join_requests (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_join_requests_group_id ON group_join_requests(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_join_requests_user_id ON group_join_requests(user_id);
    CREATE TABLE IF NOT EXISTS group_permissions (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      effect TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(group_id, permission_key)
    );
    CREATE INDEX IF NOT EXISTS idx_group_permissions_group_id ON group_permissions(group_id);
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      effect TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(group_id, user_id, permission_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_group_id ON user_permission_overrides(group_id);
    CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user_id ON user_permission_overrides(user_id);
    CREATE TABLE IF NOT EXISTS npc_reports (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_npc_reports_channel ON npc_reports(channel_id);
    CREATE INDEX IF NOT EXISTS idx_npc_reports_target_user ON npc_reports(target_user_id);
    CREATE INDEX IF NOT EXISTS idx_npc_reports_status ON npc_reports(status);
  `);

  applySqliteAlterStatements(sqlite, "users", [
    "ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'user'",
  ]);
  applySqliteAlterStatements(sqlite, "channels", [
    "ALTER TABLE channels ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL",
  ]);
  applySqliteAlterStatements(sqlite, "tasks", [
    "ALTER TABLE tasks ADD COLUMN auto_nudge_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN auto_nudge_max INTEGER NOT NULL DEFAULT 5",
    "ALTER TABLE tasks ADD COLUMN last_nudged_at TEXT",
    "ALTER TABLE tasks ADD COLUMN last_reported_at TEXT",
    "ALTER TABLE tasks ADD COLUMN stalled_at TEXT",
    "ALTER TABLE tasks ADD COLUMN stalled_reason TEXT",
  ]);

  sqlite.transaction(() => {
    const bootstrapUserId = ensureSqliteBootstrapUser(sqlite);
    const defaultGroupId = bootstrapUserId
      ? ensureSqliteDefaultGroup(sqlite, bootstrapUserId)
      : null;

    ensureSqliteBootstrapGroupAdminMembership(sqlite, defaultGroupId, bootstrapUserId);
    assignLegacyChannelsToDefaultGroup(sqlite, defaultGroupId);
  })();
}


export function getDb(): DbInstance {
  if (!_db) {
    if (isPostgres) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle } = require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg") as typeof import("pg");
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("Missing env var: DATABASE_URL");
      const pool = new Pool({ connectionString: databaseUrl });
      _db = drizzle(pool, { schema: pgSchema });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { drizzle } = require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");

      const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "deskrpg.db");
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

      const sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      ensureSqliteCompatibility(sqlite);
      _db = drizzle(sqlite, { schema: activeSchema }) as unknown as DbInstance;
    }
  }
  return _db;
}

// Proxy for backward compatibility — lazy initialization
export const db = new Proxy({} as DbInstance, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export type DB = ReturnType<typeof getDb>;
