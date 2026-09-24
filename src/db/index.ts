// src/db/index.ts
import { randomUUID } from "node:crypto";
import * as pgSchema from "./schema";
import type BetterSqlite3 from "better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDeskRpgSqlitePath } from "../lib/runtime-paths";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { retireOpenclawConfig } = require("./sqlite-openclaw-retirement.js") as {
  retireOpenclawConfig: (
    sqlite: BetterSqlite3.Database,
  ) => { migrated: number; removed: number } | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureSqliteBaseSchema } = require("./sqlite-base-schema.js") as {
  ensureSqliteBaseSchema: (sqlite: BetterSqlite3.Database) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { migrateNpcsToProfileOwnership } = require("./sqlite-npc-profile-ownership.js") as {
  migrateNpcsToProfileOwnership: (sqlite: BetterSqlite3.Database) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureChatRoomTables } = require("./sqlite-chat-rooms.js") as {
  ensureChatRoomTables: (sqlite: BetterSqlite3.Database) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureKanbanCronBookkeeping } = require("./sqlite-kanban-cron-bookkeeping.js") as {
  ensureKanbanCronBookkeeping: (sqlite: BetterSqlite3.Database) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureProjectRegistry } = require("./sqlite-project-registry.js") as {
  ensureProjectRegistry: (sqlite: BetterSqlite3.Database) => void;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureNpcPanelReads } = require("./sqlite-npc-panel-reads.js") as {
  ensureNpcPanelReads: (sqlite: BetterSqlite3.Database) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dropLegacyTaskTables } = require("./sqlite-legacy-tasks-drop.js") as {
  dropLegacyTaskTables: (sqlite: BetterSqlite3.Database) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { retireMapEditor } = require("./sqlite-map-editor-drop.js") as {
  retireMapEditor: (sqlite: BetterSqlite3.Database) => void;
};

const DB_TYPE = (
  process.env.DB_TYPE || (process.env.DATABASE_URL ? "postgresql" : "sqlite")
).toLowerCase();
export const isPostgres = DB_TYPE === "postgresql" || DB_TYPE === "postgres";

export function getDefaultSqlitePath() {
  return process.env.SQLITE_PATH || getDeskRpgSqlitePath();
}

/** Serialize JSON for DB insert — PG handles objects natively, SQLite needs strings */
export function jsonForDb(value: unknown): unknown {
  if (isPostgres) return value;
  return value == null ? null : JSON.stringify(value);
}

/**
 * "Now" for a timestamp column — PG driver wants a `Date`, SQLite's TEXT columns want
 * an ISO string. The single definition; callers that redefined this locally
 * (hermes-profiles.ts, gateway-resources.ts, provider-resources.ts, dm-hub.ts,
 * hermes-dispatch.ts) predate this export and are out of scope for this change.
 */
export function nowForDb(): Date {
  return (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;
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
export const gatewayResources = activeSchema.gatewayResources;
export const gatewayShares = activeSchema.gatewayShares;
export const hermesProfiles = activeSchema.hermesProfiles;
export const providerResources = activeSchema.providerResources;
export const providerShares = activeSchema.providerShares;
export const channelGatewayBindings = activeSchema.channelGatewayBindings;
export const channelKanbanBoards = activeSchema.channelKanbanBoards;
export const groupMembers = activeSchema.groupMembers;
export const groupInvites = activeSchema.groupInvites;
export const groupJoinRequests = activeSchema.groupJoinRequests;
export const groupPermissions = activeSchema.groupPermissions;
export const userPermissionOverrides = activeSchema.userPermissionOverrides;
export const channelMembers = activeSchema.channelMembers;
export const npcs = activeSchema.npcs;
export const npcSessions = activeSchema.npcSessions;
export const chatMessages = activeSchema.chatMessages;
export const meetingMinutes = activeSchema.meetingMinutes;
export const channelProjects = activeSchema.channelProjects;
export const channelSubprojects = activeSchema.channelSubprojects;
export const approvals = activeSchema.approvals;
export const approvalTargets = activeSchema.approvalTargets;
export const chatRooms = activeSchema.chatRooms;
export const chatRoomMembers = activeSchema.chatRoomMembers;
export const chatRoomMessages = activeSchema.chatRoomMessages;
// Per-tab read state for the staff panel (read/written by src/lib/npc-panel-reads.ts).
export const npcPanelReads = activeSchema.npcPanelReads;
// Origin ledger for Hermes cron jobs created by DeskRPG (read/written by src/lib/cron-origins.ts).
export const cronJobOrigins = activeSchema.cronJobOrigins;

// Use PG type for all API routes — Drizzle's runtime API is identical across dialects.
type DbInstance = NodePgDatabase<typeof pgSchema>;

let _db: DbInstance | null = null;

function sqliteTableExists(sqlite: BetterSqlite3.Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function sqliteColumnExists(
  sqlite: BetterSqlite3.Database,
  tableName: string,
  columnName: string,
): boolean {
  if (!sqliteTableExists(sqlite, tableName)) return false;

  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function applySqliteAlterStatements(
  sqlite: BetterSqlite3.Database,
  tableName: string,
  statements: string[],
) {
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
  const existingAdmin = sqlite
    .prepare(`SELECT id FROM users WHERE system_role = 'system_admin' ORDER BY ${orderBy} LIMIT 1`)
    .get() as { id: string } | undefined;
  if (existingAdmin) return existingAdmin.id;

  const earliestUser = sqlite.prepare(`SELECT id FROM users ORDER BY ${orderBy} LIMIT 1`).get() as
    { id: string } | undefined;
  if (!earliestUser) return null;

  sqlite.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(earliestUser.id);
  return earliestUser.id;
}

function ensureSqliteDefaultGroup(
  sqlite: BetterSqlite3.Database,
  createdBy: string | null,
): string | null {
  if (!sqliteTableExists(sqlite, "groups") || !sqliteTableExists(sqlite, "users")) return null;

  const existingGroup = sqlite
    .prepare("SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (existingGroup) {
    sqlite.prepare("UPDATE groups SET is_default = 1 WHERE id = ?").run(existingGroup.id);
    return existingGroup.id;
  }

  const now = new Date().toISOString();
  const groupId = randomUUID();
  sqlite
    .prepare(
      `
    INSERT OR IGNORE INTO groups (id, name, slug, description, is_default, created_by, created_at, updated_at)
    VALUES (?, 'Default', 'default', 'Default workspace', 1, ?, ?, ?)
  `,
    )
    .run(groupId, createdBy, now, now);

  const defaultGroup = sqlite
    .prepare("SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1")
    .get() as { id: string } | undefined;
  return defaultGroup?.id ?? null;
}

function ensureSqliteBootstrapGroupAdminMembership(
  sqlite: BetterSqlite3.Database,
  groupId: string | null,
  userId: string | null,
) {
  if (!groupId || !userId || !sqliteTableExists(sqlite, "group_members")) return;

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `
    INSERT OR IGNORE INTO group_members (id, group_id, user_id, role, approved_by, approved_at, joined_at)
    VALUES (?, ?, ?, 'group_admin', ?, ?, ?)
  `,
    )
    .run(randomUUID(), groupId, userId, userId, now, now);
  sqlite
    .prepare(
      `
    UPDATE group_members
    SET role = 'group_admin',
        approved_by = COALESCE(approved_by, ?),
        approved_at = COALESCE(approved_at, ?)
    WHERE group_id = ? AND user_id = ?
  `,
    )
    .run(userId, now, groupId, userId);
}

function assignLegacyChannelsToDefaultGroup(
  sqlite: BetterSqlite3.Database,
  groupId: string | null,
) {
  if (
    !groupId ||
    !sqliteTableExists(sqlite, "channels") ||
    !sqliteColumnExists(sqlite, "channels", "group_id")
  ) {
    return;
  }

  sqlite.prepare("UPDATE channels SET group_id = ? WHERE group_id IS NULL").run(groupId);
}

function dedupeSqliteGroupJoinRequests(sqlite: BetterSqlite3.Database) {
  if (
    !sqliteTableExists(sqlite, "group_join_requests") ||
    !sqliteTableExists(sqlite, "users") ||
    !sqliteTableExists(sqlite, "groups")
  ) {
    return;
  }

  const rows = sqlite
    .prepare(
      `
    SELECT rowid, group_id, user_id, status, created_at
    FROM group_join_requests
    ORDER BY
      group_id ASC,
      user_id ASC,
      CASE status
        WHEN 'pending' THEN 0
        WHEN 'approved' THEN 1
        ELSE 2
      END ASC,
      created_at DESC,
      rowid DESC
  `,
    )
    .all() as Array<{ rowid: number; group_id: string; user_id: string }>;

  const seen = new Set<string>();
  const deleteStmt = sqlite.prepare("DELETE FROM group_join_requests WHERE rowid = ?");
  for (const row of rows) {
    const key = `${row.group_id}:${row.user_id}`;
    if (seen.has(key)) {
      deleteStmt.run(row.rowid);
      continue;
    }
    seen.add(key);
  }
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
      created_at TEXT NOT NULL,
      UNIQUE(group_id, user_id)
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
    CREATE TABLE IF NOT EXISTS gateway_resources (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      paired_device_id TEXT,
      last_validated_at TEXT,
      last_validation_status TEXT,
      last_validation_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_resources_owner_user_id ON gateway_resources(owner_user_id);
    CREATE TABLE IF NOT EXISTS gateway_shares (
      id TEXT PRIMARY KEY NOT NULL,
      gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'use',
      created_at TEXT NOT NULL,
      UNIQUE(gateway_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_shares_gateway_id ON gateway_shares(gateway_id);
    CREATE INDEX IF NOT EXISTS idx_gateway_shares_user_id ON gateway_shares(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS gateway_shares_gateway_user_idx ON gateway_shares(gateway_id, user_id);
    CREATE TABLE IF NOT EXISTS provider_resources (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      display_name TEXT,
      auth_method TEXT NOT NULL,
      credentials_encrypted TEXT,
      base_url TEXT,
      last_validated_at TEXT,
      last_validation_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_resources_owner ON provider_resources(owner_user_id);
    CREATE TABLE IF NOT EXISTS provider_shares (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES provider_resources(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'use',
      created_at TEXT NOT NULL,
      UNIQUE(provider_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_shares_provider ON provider_shares(provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS provider_shares_provider_user_idx ON provider_shares(provider_id, user_id);
    CREATE TABLE IF NOT EXISTS channel_gateway_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
      bound_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      bound_at TEXT NOT NULL,
      UNIQUE(channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_gateway_bindings_gateway_id ON channel_gateway_bindings(gateway_id);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_gateway_bindings_channel_idx ON channel_gateway_bindings(channel_id);
    CREATE TABLE IF NOT EXISTS npc_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      adapter_type TEXT NOT NULL,
      session_type TEXT NOT NULL,
      session_ref TEXT NOT NULL,
      context_key TEXT NOT NULL,
      last_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_npc_sessions_npc ON npc_sessions(npc_id);
    CREATE UNIQUE INDEX IF NOT EXISTS npc_sessions_npc_user_context_idx ON npc_sessions(npc_id, user_id, context_key);
  `);

  applySqliteAlterStatements(sqlite, "characters", ["ALTER TABLE characters ADD COLUMN bio TEXT"]);
  applySqliteAlterStatements(sqlite, "meeting_minutes", [
    "ALTER TABLE meeting_minutes ADD COLUMN outcome_json TEXT",
    "ALTER TABLE meeting_minutes ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'ok'",
  ]);
  applySqliteAlterStatements(sqlite, "users", [
    "ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
  ]);
  applySqliteAlterStatements(sqlite, "channels", [
    "ALTER TABLE channels ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE SET NULL",
    "ALTER TABLE channels ADD COLUMN motion_config TEXT",
  ]);
  applySqliteAlterStatements(sqlite, "npcs", [
    "ALTER TABLE npcs ADD COLUMN adapter_type TEXT NOT NULL DEFAULT 'hermes'",
    "ALTER TABLE npcs ADD COLUMN adapter_config TEXT",
    // P1 only added this on the server-db.js side, so it was missing from the API path. Without
    // this column, Hermes profile bindings don't get saved, and queries that read the profile
    // die with "no such column".
    "ALTER TABLE npcs ADD COLUMN hermes_profile_id TEXT REFERENCES hermes_profiles(id) ON DELETE SET NULL",
    "ALTER TABLE npcs ADD COLUMN agent_config TEXT",
  ]);
  // Run the retirement migration only after the columns are in place (both migration-source columns must exist).
  retireOpenclawConfig(sqlite);
  // hermes_profiles.appearance can be added with ALTER, but npcs' NOT NULL/FK/unique constraints require a rebuild.
  applySqliteAlterStatements(sqlite, "hermes_profiles", [
    "ALTER TABLE hermes_profiles ADD COLUMN appearance TEXT",
  ]);
  migrateNpcsToProfileOwnership(sqlite);
  ensureChatRoomTables(sqlite);
  // Comes after the room tables, since chat_room_messages must exist before notice_json can be added.
  ensureKanbanCronBookkeeping(sqlite);
  // Must come after npcs is set up so the FK can attach. Same order as server-db.js.
  ensureNpcPanelReads(sqlite);
  // Moves the board table's PK to a surrogate key (existing DBs only) and creates the
  // project/subproject metadata tables. Must come after the board table, since the
  // rebuild has to happen first for the metadata tables' FKs to have a target.
  ensureProjectRegistry(sqlite);
  // 2026-04 task system retirement — drop the old task/report tables along with their data.
  dropLegacyTaskTables(sqlite);
  // Map editor retirement — fold the old appearance into the office look and drop the 8 map editor tables.
  // Must come after the hermes_profiles.appearance ALTER so that table's appearance also gets converted.
  retireMapEditor(sqlite);
  // This function and the same-named function in server-db.js are **separate paths** — API
  // routes go through this one, the socket server through the other. Adding a column to only
  // one side silently produces "no such column" on that path alone (this has actually happened).
  // Add new columns to both.
  applySqliteAlterStatements(sqlite, "gateway_resources", [
    "ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_at TEXT",
    "ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_by TEXT REFERENCES users(id) ON DELETE SET NULL",
    // Cache for the `GET /deskrpg/info` verdict. The PluginStatus string from
    // src/lib/hermes/plugin-capability.ts goes into plugin_status — without this column,
    // it silently breaks only for users on an existing DB.
    "ALTER TABLE gateway_resources ADD COLUMN plugin_status TEXT",
    "ALTER TABLE gateway_resources ADD COLUMN plugin_version TEXT",
    "ALTER TABLE gateway_resources ADD COLUMN plugin_checked_at TEXT",
  ]);

  dedupeSqliteGroupJoinRequests(sqlite);
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_group_user_unique ON group_join_requests(group_id, user_id)",
  );

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
      const { drizzle } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg") as typeof import("pg");
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("Missing env var: DATABASE_URL");
      const pool = new Pool({ connectionString: databaseUrl });
      _db = drizzle(pool, { schema: pgSchema });
    } else {
      const { drizzle } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");

      const dbPath = getDefaultSqlitePath();
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

      const sqlite = new Database(dbPath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      ensureSqliteBaseSchema(sqlite);
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
