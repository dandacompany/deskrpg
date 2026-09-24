import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

const require = createRequire(import.meta.url);

test("server-db sqlite compatibility does not pre-create bootstrap RBAC rows for an empty legacy sqlite deployment", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-server-db-legacy-"));
  const sqlitePath = path.join(tempDir, "legacy.sqlite");

  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = sqlitePath;

  const modulePath = require.resolve("./server-db.js");
  delete require.cache[modulePath];

  const { ensureSqliteCompatibility } = require("./server-db.js") as {
    ensureSqliteCompatibility: (sqlite: Database.Database) => void;
  };

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

  const groupsCount = sqlite.prepare("SELECT COUNT(*) AS count FROM groups").get() as {
    count: number;
  };
  const groupMembersCount = sqlite.prepare("SELECT COUNT(*) AS count FROM group_members").get() as {
    count: number;
  };

  assert.equal(groupsCount.count, 0);
  assert.equal(groupMembersCount.count, 0);
});

test("server-db sqlite exports RBAC schema and backfills a legacy sqlite deployment", () => {
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

  sqlite
    .prepare(
      "INSERT INTO users (id, login_id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("user-2", "later-user", "Later", "hash", "2026-03-31T12:00:00.000Z");
  sqlite
    .prepare(
      "INSERT INTO users (id, login_id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("user-1", "earliest-user", "Earliest", "hash", "2026-03-30T12:00:00.000Z");
  sqlite
    .prepare("INSERT INTO channels (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)")
    .run("channel-1", "General", "user-2", "2026-03-31T13:00:00.000Z");

  ensureSqliteCompatibility(sqlite);

  const tableNames = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const defaultGroup = sqlite
    .prepare("SELECT id, slug, is_default FROM groups WHERE slug = 'default'")
    .get() as { id: string; slug: string; is_default: number };
  const bootstrapUser = sqlite
    .prepare("SELECT system_role FROM users WHERE id = ?")
    .get("user-1") as { system_role: string };
  const laterUser = sqlite.prepare("SELECT system_role FROM users WHERE id = ?").get("user-2") as {
    system_role: string;
  };
  const membership = sqlite
    .prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
    .get(defaultGroup.id, "user-1") as { role: string };
  const channelRow = sqlite
    .prepare("SELECT group_id FROM channels WHERE id = ?")
    .get("channel-1") as { group_id: string | null };

  assert.ok(tableNames.some((table) => table.name === "groups"));
  assert.ok(tableNames.some((table) => table.name === "group_members"));
  assert.ok(tableNames.some((table) => table.name === "group_invites"));
  assert.ok(tableNames.some((table) => table.name === "group_join_requests"));
  assert.ok(tableNames.some((table) => table.name === "group_permissions"));
  assert.ok(tableNames.some((table) => table.name === "user_permission_overrides"));
  assert.equal(defaultGroup.slug, "default");
  assert.equal(defaultGroup.is_default, 1);
  assert.equal(bootstrapUser.system_role, "system_admin");
  assert.equal(laterUser.system_role, "user");
  assert.equal(membership.role, "group_admin");
  assert.equal(channelRow.group_id, defaultGroup.id);

  ensureSqliteCompatibility(sqlite);

  const defaultGroupCount = sqlite
    .prepare("SELECT COUNT(*) AS count FROM groups WHERE slug = 'default'")
    .get() as { count: number };
  const membershipCount = sqlite
    .prepare("SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND user_id = ?")
    .get(defaultGroup.id, "user-1") as { count: number };
  const systemAdminCount = sqlite
    .prepare("SELECT COUNT(*) AS count FROM users WHERE system_role = 'system_admin'")
    .get() as { count: number };

  assert.equal(defaultGroupCount.count, 1);
  assert.equal(membershipCount.count, 1);
  assert.equal(systemAdminCount.count, 1);
});

test("server-db sqlite bootstraps base tables for a fresh empty database", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-server-db-fresh-"));
  const sqlitePath = path.join(tempDir, "fresh.sqlite");

  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = sqlitePath;

  const modulePath = require.resolve("./server-db.js");
  delete require.cache[modulePath];
  require("./server-db.js");

  const sqlite = new Database(sqlitePath);
  // better-sqlite3's all() returns unknown[]. Pinning a type on the callback parameter would
  // mismatch the signature, so the result side narrows what the query actually gives back.
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const tableNames = rows.map((row) => row.name);

  assert.ok(tableNames.includes("users"));
  assert.ok(tableNames.includes("channels"));
  assert.ok(tableNames.includes("characters"));
  assert.ok(tableNames.includes("channel_members"));
  assert.ok(tableNames.includes("npcs"));
  assert.ok(!tableNames.includes("tasks"), "2026-04 태스크 테이블은 신규 DB 에 만들지 않는다");
  assert.ok(!tableNames.includes("npc_reports"));
  assert.ok(tableNames.includes("meeting_minutes"));
  assert.ok(!tableNames.includes("map_templates"), "맵 에디터 표는 신규 DB 에 만들지 않는다");
  assert.ok(!tableNames.includes("tileset_images"));

  const npcCols = sqlite.prepare("PRAGMA table_info(npcs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const npcColsByName = Object.fromEntries(npcCols.map((c) => [c.name, c.notnull]));
  assert.equal(npcColsByName.active, 1, "신규 DB 의 npcs 에는 active 가 NOT NULL 로 있어야 한다");

  const hermesProfileCols = sqlite.prepare("PRAGMA table_info(hermes_profiles)").all() as Array<{
    name: string;
  }>;
  assert.ok(
    hermesProfileCols.some((c) => c.name === "appearance"),
    "신규 DB 의 hermes_profiles 에는 appearance 가 있어야 한다",
  );
});

test("server-db sqlite boot path migrates a legacy npcs table to profile ownership", () => {
  // The socket server's (server-db.js) ensureSqliteCompatibility and the API route's
  // (src/db/index.ts) same-named function are separate boot paths. If only one calls
  // migrateNpcsToProfileOwnership, npcs stays on the old definition on that path alone —
  // this test locks the two paths to the same behavior.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrpg-server-db-legacy-npcs-"));
  const sqlitePath = path.join(tempDir, "legacy-npcs.sqlite");

  // Seed the legacy schema into a real file before triggering the server boot —
  // same shape as legacyDb() in sqlite-npc-profile-ownership.test.ts.
  const seed = new Database(sqlitePath);
  seed.pragma("foreign_keys = ON");
  seed.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE channels(id TEXT PRIMARY KEY);
    CREATE TABLE hermes_profiles(
      id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL, profile_name TEXT NOT NULL,
      token_encrypted TEXT NOT NULL, display_name TEXT, description TEXT,
      provisioned_by_deskrpg INTEGER NOT NULL DEFAULT 0,
      last_validated_at TEXT, last_validation_status TEXT, last_validation_error TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE npcs(
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position_x INTEGER NOT NULL, position_y INTEGER NOT NULL,
      direction TEXT DEFAULT 'down', appearance TEXT NOT NULL,
      adapter_type TEXT NOT NULL DEFAULT 'hermes', adapter_config TEXT,
      hermes_profile_id TEXT REFERENCES hermes_profiles(id) ON DELETE SET NULL,
      agent_config TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(channel_id, position_x, position_y));
    CREATE TABLE tasks(
      id TEXT PRIMARY KEY,
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      npc_task_id TEXT
    );
    INSERT INTO channels VALUES ('c1');
    INSERT INTO hermes_profiles(id,gateway_id,profile_name,token_encrypted) VALUES ('p1','g','p','t');
    INSERT INTO npcs(id,channel_id,name,position_x,position_y,appearance,hermes_profile_id,updated_at)
      VALUES ('old','c1','old',1,1,'{"v":"old"}','p1','2026-01-01T00:00:00Z');
  `);
  seed.close();

  process.env.DB_TYPE = "sqlite";
  process.env.SQLITE_PATH = sqlitePath;

  const modulePath = require.resolve("./server-db.js");
  delete require.cache[modulePath];
  require("./server-db.js");

  const sqlite = new Database(sqlitePath);

  const npcCols = sqlite.prepare("PRAGMA table_info(npcs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  assert.ok(
    npcCols.some((c) => c.name === "active" && c.notnull === 1),
    "소켓 서버 부트 경로도 레거시 npcs 를 active NOT NULL 정의로 재생성해야 한다",
  );

  const fk = sqlite.prepare("PRAGMA foreign_key_list(npcs)").all() as Array<{
    table: string;
    on_delete: string;
  }>;
  const profileFk = fk.find((f) => f.table === "hermes_profiles");
  assert.equal(
    profileFk?.on_delete,
    "CASCADE",
    "소켓 서버 부트 경로도 hermes_profile_id 를 CASCADE FK 로 재생성해야 한다",
  );
});
