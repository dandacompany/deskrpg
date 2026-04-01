// src/db/server-db.js
// CommonJS Drizzle ORM wrapper for server.js (CJS land)
// Supports PostgreSQL (default) and SQLite via DB_TYPE env var

"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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
  const existingAdmin = sqlite.prepare(
    `SELECT id FROM users WHERE system_role = 'system_admin' ORDER BY ${orderBy} LIMIT 1`,
  ).get();
  if (existingAdmin) return existingAdmin.id;

  const earliestUser = sqlite.prepare(`SELECT id FROM users ORDER BY ${orderBy} LIMIT 1`).get();
  if (!earliestUser) return null;

  sqlite.prepare("UPDATE users SET system_role = 'system_admin' WHERE id = ?").run(earliestUser.id);
  return earliestUser.id;
}

function ensureSqliteDefaultGroup(sqlite, createdBy) {
  if (!sqliteTableExists(sqlite, "groups") || !sqliteTableExists(sqlite, "users")) return null;

  const existingGroup = sqlite.prepare(
    "SELECT id FROM groups WHERE slug = 'default' ORDER BY rowid ASC LIMIT 1",
  ).get();
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
  ).get();
  return defaultGroup ? defaultGroup.id : null;
}

function ensureSqliteBootstrapGroupAdminMembership(sqlite, groupId, userId) {
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

function assignLegacyChannelsToDefaultGroup(sqlite, groupId) {
  if (!groupId || !sqliteTableExists(sqlite, "channels") || !sqliteColumnExists(sqlite, "channels", "group_id")) {
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

  const rows = sqlite.prepare(`
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
  `).all();

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

  dedupeSqliteGroupJoinRequests(sqlite);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_group_user_unique ON group_join_requests(group_id, user_id)");

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
  const {
    pgTable,
    uuid,
    varchar,
    text,
    integer,
    jsonb,
    timestamp,
    boolean,
    index,
    unique,
    uniqueIndex,
  } = require("drizzle-orm/pg-core");
  const { Pool } = require("pg");

  // ── Schema definitions ────────────────────────────────────────────────────
  const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    loginId: varchar("login_id", { length: 50 }).unique().notNull(),
    nickname: varchar("nickname", { length: 50 }).unique().notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    systemRole: varchar("system_role", { length: 20 }).notNull().default("user"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  });

  const characters = pgTable("characters", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(),
    appearance: jsonb("appearance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_characters_user_id").on(table.userId),
  ]);

  const groups = pgTable("groups", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).unique().notNull(),
    description: varchar("description", { length: 500 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  });

  const channels = pgTable("channels", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
    mapData: jsonb("map_data"),
    mapConfig: jsonb("map_config"),
    isPublic: boolean("is_public").default(true),
    inviteCode: varchar("invite_code", { length: 20 }).unique(),
    maxPlayers: integer("max_players").default(50),
    password: varchar("password", { length: 255 }),
    gatewayConfig: jsonb("gateway_config"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  });

  const groupMembers = pgTable("group_members", {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_group_members_group_id").on(table.groupId),
    index("idx_group_members_user_id").on(table.userId),
    unique("group_members_group_user_unique").on(table.groupId, table.userId),
  ]);

  const groupInvites = pgTable("group_invites", {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).unique().notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetLoginId: varchar("target_login_id", { length: 50 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_group_invites_group_id").on(table.groupId),
    index("idx_group_invites_target_user_id").on(table.targetUserId),
  ]);

  const groupJoinRequests = pgTable("group_join_requests", {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    message: text("message"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_group_join_requests_group_id").on(table.groupId),
    index("idx_group_join_requests_user_id").on(table.userId),
    unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
  ]);

  const groupPermissions = pgTable("group_permissions", {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 50 }).notNull(),
    effect: varchar("effect", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_group_permissions_group_id").on(table.groupId),
    unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
  ]);

  const userPermissionOverrides = pgTable("user_permission_overrides", {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 50 }).notNull(),
    effect: varchar("effect", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_user_permission_overrides_group_id").on(table.groupId),
    index("idx_user_permission_overrides_user_id").on(table.userId),
    unique("user_permission_overrides_group_user_permission_unique").on(table.groupId, table.userId, table.permissionKey),
  ]);

  const channelMembers = pgTable("channel_members", {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_channel_members_channel_id").on(table.channelId),
    index("idx_channel_members_user_id").on(table.userId),
    unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
  ]);

  const npcs = pgTable("npcs", {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    positionX: integer("position_x").notNull(),
    positionY: integer("position_y").notNull(),
    direction: varchar("direction", { length: 10 }).default("down"),
    appearance: jsonb("appearance").notNull(),
    openclawConfig: jsonb("openclaw_config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  }, (table) => [
    index("idx_npcs_channel_id").on(table.channelId),
    unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
  ]);

  const meetingMinutes = pgTable("meeting_minutes", {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    transcript: text("transcript").notNull(),
    participants: jsonb("participants").notNull().default([]),
    totalTurns: integer("total_turns").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    initiatorId: uuid("initiator_id").references(() => users.id, { onDelete: "set null" }),
    keyTopics: jsonb("key_topics").notNull().default([]),
    conclusions: text("conclusions"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  }, (table) => [
    index("idx_meeting_minutes_channel").on(table.channelId),
    index("idx_meeting_minutes_created").on(table.createdAt),
  ]);

  const tasks = pgTable("tasks", {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id").notNull().references(() => channels.id),
    npcId: uuid("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
    assignerId: uuid("assigner_id").notNull().references(() => characters.id),
    npcTaskId: varchar("npc_task_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: text("summary"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  }, (table) => [
    index("idx_tasks_channel").on(table.channelId),
    index("idx_tasks_npc").on(table.npcId),
    uniqueIndex("idx_tasks_npc_task_id").on(table.npcId, table.npcTaskId),
  ]);

  const npcReports = pgTable("npc_reports", {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    npcId: uuid("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  }, (table) => [
    index("idx_npc_reports_channel").on(table.channelId),
    index("idx_npc_reports_target_user").on(table.targetUserId),
    index("idx_npc_reports_status").on(table.status),
  ]);

  schema = {
    users,
    characters,
    groups,
    channels,
    groupMembers,
    groupInvites,
    groupJoinRequests,
    groupPermissions,
    userPermissionOverrides,
    channelMembers,
    npcs,
    meetingMinutes,
    tasks,
    npcReports,
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });

  console.log("[server-db] PostgreSQL mode — Drizzle ORM initialized");

// ─── SQLite mode ──────────────────────────────────────────────────────────────
} else {
  const { drizzle } = require("drizzle-orm/better-sqlite3");
  const {
    sqliteTable,
    text,
    integer,
    index,
    unique,
    uniqueIndex,
  } = require("drizzle-orm/sqlite-core");
  const Database = require("better-sqlite3");

  // Ensure data/ directory exists for the DB file
  const deskRpgHome = process.env.DESKRPG_HOME || path.join(os.homedir(), ".deskrpg");
  const dbPath = process.env.SQLITE_PATH || path.join(deskRpgHome, "data", "deskrpg.db");
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // ── Schema definitions ────────────────────────────────────────────────────
  const users = sqliteTable("users", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    loginId: text("login_id").unique().notNull(),
    nickname: text("nickname").unique().notNull(),
    passwordHash: text("password_hash").notNull(),
    systemRole: text("system_role").notNull().default("user"),
    lastActiveAt: text("last_active_at"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  });

  const characters = sqliteTable("characters", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    appearance: text("appearance").notNull(),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_characters_user_id").on(table.userId),
  ]);

  const groups = sqliteTable("groups", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").unique().notNull(),
    description: text("description"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  });

  const channels = sqliteTable("channels", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: text("owner_id").notNull().references(() => users.id),
    groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
    mapData: text("map_data"),
    mapConfig: text("map_config"),
    isPublic: integer("is_public", { mode: "boolean" }).default(true),
    inviteCode: text("invite_code").unique(),
    maxPlayers: integer("max_players").default(50),
    password: text("password"),
    gatewayConfig: text("gateway_config"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  });

  const groupMembers = sqliteTable("group_members", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: text("approved_at"),
    joinedAt: text("joined_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_group_members_group_id").on(table.groupId),
    index("idx_group_members_user_id").on(table.userId),
    unique("group_members_group_user_unique").on(table.groupId, table.userId),
  ]);

  const groupInvites = sqliteTable("group_invites", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetLoginId: text("target_login_id"),
    expiresAt: text("expires_at"),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_group_invites_group_id").on(table.groupId),
    index("idx_group_invites_target_user_id").on(table.targetUserId),
  ]);

  const groupJoinRequests = sqliteTable("group_join_requests", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_group_join_requests_group_id").on(table.groupId),
    index("idx_group_join_requests_user_id").on(table.userId),
    unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
  ]);

  const groupPermissions = sqliteTable("group_permissions", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    effect: text("effect").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_group_permissions_group_id").on(table.groupId),
    unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
  ]);

  const userPermissionOverrides = sqliteTable("user_permission_overrides", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    effect: text("effect").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_user_permission_overrides_group_id").on(table.groupId),
    index("idx_user_permission_overrides_user_id").on(table.userId),
    unique("user_permission_overrides_group_user_permission_unique").on(table.groupId, table.userId, table.permissionKey),
  ]);

  const channelMembers = sqliteTable("channel_members", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: text("joined_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_channel_members_channel_id").on(table.channelId),
    index("idx_channel_members_user_id").on(table.userId),
    unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
  ]);

  const npcs = sqliteTable("npcs", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    positionX: integer("position_x").notNull(),
    positionY: integer("position_y").notNull(),
    direction: text("direction").default("down"),
    appearance: text("appearance").notNull(),
    openclawConfig: text("openclaw_config").notNull(),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_npcs_channel_id").on(table.channelId),
    unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
  ]);

  const meetingMinutes = sqliteTable("meeting_minutes", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    transcript: text("transcript").notNull(),
    participants: text("participants").notNull().default("[]"),
    totalTurns: integer("total_turns").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    initiatorId: text("initiator_id").references(() => users.id, { onDelete: "set null" }),
    keyTopics: text("key_topics").notNull().default("[]"),
    conclusions: text("conclusions"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  }, (table) => [
    index("idx_meeting_minutes_channel").on(table.channelId),
    index("idx_meeting_minutes_created").on(table.createdAt),
  ]);

  const tasks = sqliteTable("tasks", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull().references(() => channels.id),
    npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
    assignerId: text("assigner_id").notNull().references(() => characters.id),
    npcTaskId: text("npc_task_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  }, (table) => [
    index("idx_tasks_channel").on(table.channelId),
    index("idx_tasks_npc").on(table.npcId),
    uniqueIndex("idx_tasks_npc_task_id").on(table.npcId, table.npcTaskId),
  ]);

  const npcReports = sqliteTable("npc_reports", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    deliveredAt: text("delivered_at"),
    consumedAt: text("consumed_at"),
  }, (table) => [
    index("idx_npc_reports_channel").on(table.channelId),
    index("idx_npc_reports_target_user").on(table.targetUserId),
    index("idx_npc_reports_status").on(table.status),
  ]);

  schema = {
    users,
    characters,
    groups,
    channels,
    groupMembers,
    groupInvites,
    groupJoinRequests,
    groupPermissions,
    userPermissionOverrides,
    channelMembers,
    npcs,
    meetingMinutes,
    tasks,
    npcReports,
  };

  const sqlite = new Database(dbPath);

  // Enable WAL mode and foreign key enforcement
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSqliteCompatibility(sqlite);

  db = drizzle(sqlite, { schema });

  console.log(`[server-db] SQLite mode — Drizzle ORM initialized (${dbPath})`);
}

module.exports = { db, schema, isPostgres, eq, and, desc, sql, ensureSqliteCompatibility };
