import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const { migrateNpcsToProfileOwnership } = require("./sqlite-npc-profile-ownership.js") as {
  migrateNpcsToProfileOwnership: (db: Database.Database) => null | {
    moved: number;
    removedUnprofiled: number;
    removedDuplicates: number;
  };
};

function legacyDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE channels(id TEXT PRIMARY KEY);
    CREATE TABLE gateway_resources(id TEXT PRIMARY KEY);
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
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY, npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE, content TEXT);
    CREATE TABLE channel_gateway_bindings(
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, gateway_id TEXT NOT NULL, bound_by_user_id TEXT);
    INSERT INTO channels VALUES ('c1');
    INSERT INTO hermes_profiles(id,gateway_id,profile_name,token_encrypted) VALUES ('p1','g','p','t');
    INSERT INTO npcs(id,channel_id,name,position_x,position_y,appearance,hermes_profile_id,updated_at)
      VALUES ('old','c1','old',1,1,'{"v":"old"}','p1','2026-01-01T00:00:00Z'),
             ('new','c1','new',2,2,'{"v":"new"}','p1','2026-02-01T00:00:00Z'),
             ('orphan','c1','orphan',3,3,'{"v":"o"}',NULL,'2026-02-01T00:00:00Z');
    INSERT INTO chat_messages VALUES ('m1','orphan','orphan chat'),('m2','old','dup chat');
  `);
  return db;
}

test("moves appearance to the profile and rebuilds npcs with the new definition", () => {
  const db = legacyDb();
  const r = migrateNpcsToProfileOwnership(db);
  assert.deepEqual(r, { moved: 1, removedUnprofiled: 1, removedDuplicates: 1 });

  const prof = db.prepare("SELECT appearance FROM hermes_profiles WHERE id='p1'").get() as {
    appearance: string;
  };
  assert.equal(prof.appearance, '{"v":"new"}');

  const cols = db.prepare("PRAGMA table_info(npcs)").all() as { name: string; notnull: number }[];
  const by = Object.fromEntries(cols.map((c) => [c.name, c.notnull]));
  assert.equal(by.active, 1, "active 컬럼이 NOT NULL 로 생겨야 한다");
  assert.equal(by.position_x, 0, "자리 미정을 허용해야 한다");
  assert.equal(by.hermes_profile_id, 1, "프로필은 필수여야 한다");

  const fk = db.prepare("PRAGMA foreign_key_list(npcs)").all() as {
    table: string;
    on_delete: string;
  }[];
  const profFk = fk.find((f) => f.table === "hermes_profiles");
  assert.equal(profFk?.on_delete, "CASCADE");

  assert.equal((db.prepare("SELECT count(*) AS n FROM npcs").get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM npcs_unprofiled_backup").get() as { n: number }).n,
    1,
  );

  // C1: child rows dropped along via CASCADE are backed up — unbound 1 + duplicate 1
  for (const table of ["npcs_removed_chat_messages_backup"]) {
    assert.equal(
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      2,
      `${table} 에 지워진 자식 행이 남아야 한다`,
    );
  }

  // M2: after the rebuild, FK is back on and integrity wasn't broken
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1, "FK 검사가 다시 켜져야 한다");
  assert.deepEqual(db.pragma("foreign_key_check"), []);

  // Deleting the profile also removes its NPC deployment
  db.prepare("DELETE FROM hermes_profiles WHERE id='p1'").run();
  assert.equal((db.prepare("SELECT count(*) AS n FROM npcs").get() as { n: number }).n, 0);
});

test("I4: hires the unhired profiles of an already-bound gateway", () => {
  const db = legacyDb();
  db.exec(`
    INSERT INTO hermes_profiles(id,gateway_id,profile_name,token_encrypted) VALUES ('p2','g','p2','t');
    INSERT INTO channel_gateway_bindings VALUES ('b1','c1','g','u1');
  `);
  migrateNpcsToProfileOwnership(db);

  const added = db
    .prepare("SELECT active, position_x FROM npcs WHERE hermes_profile_id='p2'")
    .get() as { active: number; position_x: number | null } | undefined;
  assert.ok(added, "미고용 프로필이 출근부에 나타나야 한다");
  assert.equal(added.active, 1);
  assert.equal(added.position_x, null, "자리는 미정으로 만든다");
});

test("M2: can be run again even if npcs_new was left behind", () => {
  const db = legacyDb();
  // Simulates a previous run that died right after CREATE
  db.exec("CREATE TABLE npcs_new(id TEXT PRIMARY KEY)");
  migrateNpcsToProfileOwnership(db);
  const cols = db.prepare("PRAGMA table_info(npcs)").all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "active"));
});

test("is safe to run twice", () => {
  const db = legacyDb();
  migrateNpcsToProfileOwnership(db);
  assert.equal(migrateNpcsToProfileOwnership(db), null);
});
