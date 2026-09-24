// src/db/server-db.js
// CommonJS Drizzle ORM wrapper for server.js (CJS land)
// Supports PostgreSQL (default) and SQLite via DB_TYPE env var

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ensureSqliteBaseSchema } = require("./sqlite-base-schema.js");
const { retireOpenclawConfig } = require("./sqlite-openclaw-retirement.js");
const { migrateNpcsToProfileOwnership } = require("./sqlite-npc-profile-ownership.js");
const { ensureChatRoomTables } = require("./sqlite-chat-rooms.js");
const { ensureKanbanCronBookkeeping } = require("./sqlite-kanban-cron-bookkeeping.js");
const { ensureProjectRegistry } = require("./sqlite-project-registry.js");
const { ensureNpcPanelReads } = require("./sqlite-npc-panel-reads.js");
const { dropLegacyTaskTables } = require("./sqlite-legacy-tasks-drop.js");
const { retireMapEditor } = require("./sqlite-map-editor-drop.js");

const DB_TYPE = (process.env.DB_TYPE || "postgresql").toLowerCase();
const isPostgres = DB_TYPE === "postgresql" || DB_TYPE === "postgres";

let db;
let schema;

function sqliteTableExists(sqlite, tableName) {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function sqliteColumnExists(sqlite, tableName, columnName) {
  if (!sqliteTableExists(sqlite, tableName)) return false;

  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function applySqliteAlterStatements(sqlite, tableName, statements) {
  if (!sqliteTableExists(sqlite, tableName)) return;

  for (const statement of statements) {
    try {
      sqlite.exec(statement);
    } catch (error) {
      if (!String(error).includes("duplicate column name")) throw error;
    }
  }
}

function getSqliteUserOrderBy(sqlite) {
  return sqliteColumnExists(sqlite, "users", "created_at")
    ? "created_at IS NULL ASC, created_at ASC, rowid ASC"
    : "rowid ASC";
}

function ensureSqliteBootstrapUser(sqlite) {
  if (!sqliteTableExists(sqlite, "users") || !sqliteColumnExists(sqlite, "users", "system_role")) {
    return null;
  }

  const orderBy = getSqliteUserOrderBy(sqlite);
  const existingAdmin = sqlite
    .prepare(`SELECT id FROM users WHERE system_role = 'system_admin' ORDER BY ${orderBy} LIMIT 1`)
    .get();
  if (existingAdmin) return existingAdmin.id;

  const earliestUser = sqlite.prepare(`SELECT id FROM users ORDER BY ${orderBy} LIMIT 1`).get();
  if (!earliestUser) return null;

  sqlite.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(earliestUser.id);
  return earliestUser.id;
}

function ensureSqliteDefaultGroup(sqlite, createdBy) {
  if (!sqliteTableExists(sqlite, "groups") || !sqliteTableExists(sqlite, "users")) return null;

  const existingGroup = sqlite
    .prepare("SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1")
    .get();
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
    .get();
  return defaultGroup ? defaultGroup.id : null;
}

function ensureSqliteBootstrapGroupAdminMembership(sqlite, groupId, userId) {
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

function assignLegacyChannelsToDefaultGroup(sqlite, groupId) {
  if (
    !groupId ||
    !sqliteTableExists(sqlite, "channels") ||
    !sqliteColumnExists(sqlite, "channels", "group_id")
  ) {
    return;
  }

  sqlite.prepare("UPDATE channels SET group_id = ? WHERE group_id IS NULL").run(groupId);
}

function dedupeSqliteGroupJoinRequests(sqlite) {
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
    .all();

  const seen = new Set();
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

function ensureSqliteCompatibility(sqlite) {
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
      local_discovery_opted_in_at TEXT,
      local_discovery_opted_in_by TEXT REFERENCES users(id) ON DELETE SET NULL,
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
    CREATE TABLE IF NOT EXISTS hermes_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
      profile_name TEXT NOT NULL,
      token_encrypted TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      provisioned_by_deskrpg INTEGER NOT NULL DEFAULT 0,
      last_validated_at TEXT,
      last_validation_status TEXT,
      last_validation_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hermes_profiles_gateway_id ON hermes_profiles(gateway_id);
    CREATE UNIQUE INDEX IF NOT EXISTS hermes_profiles_gateway_name_idx ON hermes_profiles(gateway_id, profile_name);
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

  const gwCols = sqlite
    .prepare("PRAGMA table_info(gateway_resources)")
    .all()
    .map((c) => c.name);
  if (!gwCols.includes("local_discovery_opted_in_at")) {
    sqlite.exec("ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_at TEXT");
  }
  if (!gwCols.includes("local_discovery_opted_in_by")) {
    sqlite.exec(
      "ALTER TABLE gateway_resources ADD COLUMN local_discovery_opted_in_by TEXT REFERENCES users(id) ON DELETE SET NULL",
    );
  }

  applySqliteAlterStatements(sqlite, "npcs", [
    "ALTER TABLE npcs ADD COLUMN adapter_type TEXT NOT NULL DEFAULT 'hermes'",
    "ALTER TABLE npcs ADD COLUMN adapter_config TEXT",
    "ALTER TABLE npcs ADD COLUMN hermes_profile_id TEXT REFERENCES hermes_profiles(id) ON DELETE SET NULL",
    "ALTER TABLE npcs ADD COLUMN agent_config TEXT",
  ]);
  // Run the retirement migration only after the columns are in place (both migration-source columns must exist).
  retireOpenclawConfig(sqlite);
  // hermes_profiles.appearance can be added with ALTER, but npcs' NOT NULL/FK/unique constraints require a rebuild.
  // Same order as ensureSqliteCompatibility in src/db/index.ts — keeps the two boot paths from diverging.
  applySqliteAlterStatements(sqlite, "hermes_profiles", [
    "ALTER TABLE hermes_profiles ADD COLUMN appearance TEXT",
  ]);
  migrateNpcsToProfileOwnership(sqlite);
  ensureChatRoomTables(sqlite);
  // Comes after the room tables, since chat_room_messages must exist before notice_json can be added.
  ensureKanbanCronBookkeeping(sqlite);
  // Must come after npcs is set up so the FK can attach. Same order as index.ts.
  ensureNpcPanelReads(sqlite);
  // Moves the board table's PK to a surrogate key (existing DBs only) and creates the
  // project/subproject metadata tables. Must come after the board table, since the
  // rebuild has to happen first for the metadata tables' FKs to have a target.
  ensureProjectRegistry(sqlite);
  // 2026-04 task system retirement — drop the old task/report tables along with their data.
  dropLegacyTaskTables(sqlite);
  // Map editor retirement — fold the old appearance into the office look and drop the 8 map editor tables.
  // Keeps **the same order** as the same-named function in index.ts.
  retireMapEditor(sqlite);

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

// ─── Drizzle query helpers (shared) ──────────────────────────────────────────
const { eq, and, desc, sql } = require("drizzle-orm");

// ─── PostgreSQL mode ──────────────────────────────────────────────────────────
if (isPostgres) {
  const { drizzle } = require("drizzle-orm/node-postgres");
  const { Pool } = require("pg");

  schema = require("./schema.pg.cjs");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });

  console.log("[server-db] PostgreSQL mode — Drizzle ORM initialized");

  // ─── SQLite mode ──────────────────────────────────────────────────────────────
} else {
  const { drizzle } = require("drizzle-orm/better-sqlite3");
  const Database = require("better-sqlite3");

  // Ensure data/ directory exists for the DB file
  const deskRpgHome = process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg");
  const dbPath = process.env.SQLITE_PATH || path.join(deskRpgHome, "data", "deskrpg.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  schema = require("./schema.sqlite.cjs");

  const sqlite = new Database(dbPath);

  // Enable WAL mode and foreign key enforcement
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSqliteBaseSchema(sqlite);
  ensureSqliteCompatibility(sqlite);

  db = drizzle(sqlite, { schema });

  console.log(`[server-db] SQLite mode — Drizzle ORM initialized (${dbPath})`);
}

module.exports = {
  db,
  schema,
  isPostgres,
  eq,
  and,
  desc,
  sql,
  ensureSqliteBaseSchema,
  ensureSqliteCompatibility,
};
