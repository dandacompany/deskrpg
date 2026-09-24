// SQLite can't change NOT NULL/FK via ALTER, so npcs is rebuilt with the new definition.
// The same work on the PostgreSQL side is in drizzle/0008_npc_profile_ownership.sql. Both
// files keep the same order: move → back up → delete → constrain.
"use strict";

function columns(sqlite, table) {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function tableExists(sqlite, table) {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

// Columns the migration query actually reads and writes. If even one is missing, npcs isn't
// really in the "legacy" shape yet — a minimal fixture used by things like RBAC tests
// (npcs with just id, channel_id) is like that. Such a DB is left untouched here; it's
// sqlite-base-schema.js's job to create it with the new definition.
const LEGACY_NPC_COLUMNS = [
  "appearance",
  "hermes_profile_id",
  "channel_id",
  "created_at",
  "updated_at",
];

// Tables that reference `npcs.id` with ON DELETE CASCADE. Backed up into the same-named
// backup tables as PostgreSQL 0008's steps 4a/5a. A minimal fixture may not have them, so
// only existing tables are scanned. (The old task/report tables that 0008 used to back up
// were dropped along with the 2026-04 task system retirement — 0012 / sqlite-legacy-tasks-drop.js.)
const CASCADING_CHILD_TABLES = [
  ["chat_messages", "npcs_removed_chat_messages_backup"],
  ["npc_sessions", "npcs_removed_npc_sessions_backup"],
];

/** Moves child rows hanging off the soon-to-be-deleted NPC set (`sourceBackup`'s ids) into the backup table. */
function backupCascadingChildren(sqlite, sourceBackup) {
  for (const [child, backup] of CASCADING_CHILD_TABLES) {
    if (!tableExists(sqlite, child)) continue;
    const select = `SELECT * FROM ${child} WHERE npc_id IN (SELECT id FROM ${sourceBackup})`;
    if (tableExists(sqlite, backup)) {
      sqlite.exec(`INSERT INTO ${backup} ${select}`);
    } else {
      sqlite.exec(`CREATE TABLE ${backup} AS ${select}`);
    }
  }
}

function migrateNpcsToProfileOwnership(sqlite) {
  // A DB where npcs or hermes_profiles doesn't exist yet (minimal fixture, pre-bootstrap stage)
  // has nothing to move or rebuild — sqlite-base-schema.js creates it with the new definition.
  if (!tableExists(sqlite, "npcs") || !tableExists(sqlite, "hermes_profiles")) return null;
  const npcCols = columns(sqlite, "npcs");
  if (npcCols.includes("active")) return null; // already applied
  if (!LEGACY_NPC_COLUMNS.every((c) => npcCols.includes(c))) return null; // not really the legacy shape

  // 1) Appearance migration + backup + deletion in one transaction. SQLite ignores
  // `PRAGMA foreign_keys` changes inside a transaction, so the table rebuild is split out into its own transaction.
  const prepare = sqlite.transaction(() => {
    if (!columns(sqlite, "hermes_profiles").includes("appearance")) {
      sqlite.exec(`ALTER TABLE hermes_profiles ADD COLUMN appearance TEXT`);
    }

    // 2) Appearance migration — the most recent NPC per profile
    const moved = sqlite
      .prepare(
        `
      UPDATE hermes_profiles SET appearance = (
        SELECT n.appearance FROM npcs n
        WHERE n.hermes_profile_id = hermes_profiles.id
        ORDER BY n.updated_at DESC, n.created_at DESC LIMIT 1)
      WHERE appearance IS NULL
        AND EXISTS (SELECT 1 FROM npcs n WHERE n.hermes_profile_id = hermes_profiles.id)`,
      )
      .run().changes;

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS npcs_appearance_conflicts AS
      SELECT n.id AS npc_id, n.hermes_profile_id, n.channel_id, n.appearance, n.updated_at
      FROM npcs n WHERE n.hermes_profile_id IS NOT NULL AND n.id <> (
        SELECT m.id FROM npcs m WHERE m.hermes_profile_id = n.hermes_profile_id
        ORDER BY m.updated_at DESC, m.created_at DESC LIMIT 1)`);

    // 4) Back up and delete unbound NPCs
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS npcs_unprofiled_backup AS SELECT * FROM npcs WHERE hermes_profile_id IS NULL`,
    );
    backupCascadingChildren(sqlite, "npcs_unprofiled_backup");
    const removedUnprofiled = sqlite
      .prepare(`DELETE FROM npcs WHERE hermes_profile_id IS NULL`)
      .run().changes;

    // 5) Back up and delete duplicates
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS npcs_duplicate_backup AS
      SELECT * FROM npcs n WHERE n.id <> (
        SELECT m.id FROM npcs m WHERE m.channel_id = n.channel_id AND m.hermes_profile_id = n.hermes_profile_id
        ORDER BY m.updated_at DESC, m.created_at DESC LIMIT 1)`);
    backupCascadingChildren(sqlite, "npcs_duplicate_backup");
    const removedDuplicates = sqlite
      .prepare(`DELETE FROM npcs WHERE id IN (SELECT id FROM npcs_duplicate_backup)`)
      .run().changes;

    return { moved, removedUnprofiled, removedDuplicates };
  });

  const result = prepare();

  // 6-8) Rebuild with the new definition. FK checks are turned off briefly outside the
  // transaction (references like chat_messages.npc_id wobble momentarily while the table is
  // swapped) — this PRAGMA is ignored inside a transaction.
  sqlite.pragma("foreign_keys = OFF");
  const rebuild = sqlite.transaction(() => {
    // If a previous run died between CREATE and DROP, npcs_new is left behind and blocks the next boot.
    sqlite.exec(`DROP TABLE IF EXISTS npcs_new`);
    sqlite.exec(`
      CREATE TABLE npcs_new (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        name TEXT,
        position_x INTEGER,
        position_y INTEGER,
        direction TEXT DEFAULT 'down',
        appearance TEXT,
        adapter_type TEXT NOT NULL DEFAULT 'hermes',
        adapter_config TEXT,
        hermes_profile_id TEXT NOT NULL REFERENCES hermes_profiles(id) ON DELETE CASCADE,
        agent_config TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(channel_id, position_x, position_y),
        UNIQUE(channel_id, hermes_profile_id)
      );
      INSERT INTO npcs_new (id, channel_id, name, position_x, position_y, direction, appearance,
                            adapter_type, adapter_config, hermes_profile_id, agent_config, created_at, updated_at)
      SELECT id, channel_id, name, position_x, position_y, direction, appearance,
             adapter_type, adapter_config, hermes_profile_id, agent_config, created_at, updated_at
      FROM npcs;
      DROP TABLE npcs;
      ALTER TABLE npcs_new RENAME TO npcs;
      CREATE INDEX IF NOT EXISTS idx_npcs_channel_id ON npcs(channel_id);
    `);
  });
  try {
    rebuild();
  } finally {
    // Even if this throws, this connection must never keep living without FK checks.
    sqlite.pragma("foreign_keys = ON");
  }

  // Scoped to npcs — scanning the whole DB would let one unrelated stale orphan row block startup.
  const broken = sqlite.pragma("foreign_key_check(npcs)");
  if (broken.length > 0) {
    throw new Error(
      `npcs 재생성 후 외래키 무결성이 깨졌습니다(${broken.length}건): ` +
        JSON.stringify(broken.slice(0, 5)),
    );
  }

  // I4) Hires profiles of already-bound gateways — this only works with OR IGNORE **after**
  // the unique constraint exists. As part of a one-time migration, it does not revive an NPC
  // the user later put to sleep (PostgreSQL does the same thing via drizzle/0009).
  if (tableExists(sqlite, "channel_gateway_bindings")) {
    sqlite.exec(`
      INSERT OR IGNORE INTO npcs (id, channel_id, hermes_profile_id, active)
      SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
             substr(lower(hex(randomblob(2))),2) || '-' ||
             substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
             b.channel_id, hp.id, 1
      FROM channel_gateway_bindings b
      JOIN hermes_profiles hp ON hp.gateway_id = b.gateway_id`);
  }

  return result;
}

module.exports = { migrateNpcsToProfileOwnership };
