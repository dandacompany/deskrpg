// SQLite counterpart of the project registry table (design 2026-09-21 project-registry).
//
// Does two things:
//   1. **Rebuilds** an existing DB's `channel_kanban_boards` — to move the PK from channel_id
//      to a surrogate id key. SQLite can't change a PK via ALTER, so the only path is copying
//      into a new table and renaming it. An empty DB already gets the new shape from
//      `sqlite-kanban-cron-bookkeeping.js`, so there's nothing to do here (checked via whether
//      the `id` column exists).
//   2. Creates the project/subproject metadata tables.
//
// Called by both bootstrap paths (src/db/index.ts, server-db.js) — adding it to only one
// silently produces "no such table/column" only on the DB that path opens.
//
// **Order matters.** The rebuild must finish before `channel_projects` exists. If the metadata
// table is created first, its FK ends up pointing at `channel_kanban_boards` while the DROP
// runs — this fails on a DB with foreign keys on, or silently leaves a broken reference on one with them off.
"use strict";

const { randomUUID } = require("node:crypto");

const PROJECT_TABLES = `
  CREATE TABLE IF NOT EXISTS channel_projects (
    id TEXT PRIMARY KEY NOT NULL,
    board_link_id TEXT NOT NULL UNIQUE REFERENCES channel_kanban_boards(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'planned',
    lead_npc_id TEXT REFERENCES npcs(id) ON DELETE SET NULL,
    target_date TEXT,
    color TEXT,
    icon TEXT,
    pause_reason TEXT,
    origin_meeting_id TEXT REFERENCES meeting_minutes(id) ON DELETE SET NULL,
    hermes_project_id TEXT,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channel_projects_channel ON channel_projects(channel_id);
  CREATE TABLE IF NOT EXISTS channel_subprojects (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES channel_projects(id) ON DELETE CASCADE,
    tenant_slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    lead_npc_id TEXT REFERENCES npcs(id) ON DELETE SET NULL,
    target_date TEXT,
    color TEXT,
    icon TEXT,
    pause_reason TEXT,
    origin_meeting_id TEXT REFERENCES meeting_minutes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS channel_subprojects_project_tenant_idx
    ON channel_subprojects(project_id, tenant_slug);
`;

const REBUILT_BOARDS_TABLE = `
  CREATE TABLE channel_kanban_boards__new (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
    board_slug TEXT NOT NULL,
    is_event_carrier INTEGER NOT NULL DEFAULT 0,
    board_name_synced_at TEXT,
    event_cursor TEXT,
    event_carrier_handoff_json TEXT,
    last_polled_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const BOARD_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_channel_kanban_boards_gateway_id ON channel_kanban_boards(gateway_id);
  CREATE UNIQUE INDEX IF NOT EXISTS channel_kanban_boards_channel_slug_idx
    ON channel_kanban_boards(channel_id, board_slug);
  CREATE UNIQUE INDEX IF NOT EXISTS channel_kanban_boards_carrier_idx
    ON channel_kanban_boards(channel_id) WHERE is_event_carrier;
  CREATE UNIQUE INDEX IF NOT EXISTS channel_kanban_boards_handoff_idx
    ON channel_kanban_boards(channel_id) WHERE event_carrier_handoff_json IS NOT NULL;
`;

const CARRIED_COLUMNS = [
  "channel_id",
  "gateway_id",
  "board_slug",
  "board_name_synced_at",
  "event_cursor",
  "last_polled_at",
  "last_error",
  "created_at",
  "updated_at",
];

function tableExists(sqlite, table) {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

function hasColumn(sqlite, table, column) {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

/**
 * Moves the old shape (channel_id as PK) to the new shape (id as PK, has is_event_carrier).
 *
 * Rows and `event_cursor` are carried over as-is — dropping the cursor would make that channel
 * miss an entire stretch of events. Every pre-migration row was its channel's only board and
 * was already receiving cron/artifact events, so all of them get `is_event_carrier = 1`.
 */
function rebuildBoardsTable(sqlite) {
  const rows = sqlite
    .prepare(`SELECT ${CARRIED_COLUMNS.join(", ")} FROM channel_kanban_boards`)
    .all();

  sqlite.exec("DROP TABLE IF EXISTS channel_kanban_boards__new");
  sqlite.exec(REBUILT_BOARDS_TABLE);

  const insert = sqlite.prepare(
    `INSERT INTO channel_kanban_boards__new (id, is_event_carrier, ${CARRIED_COLUMNS.join(", ")})
     VALUES (@id, 1, ${CARRIED_COLUMNS.map((c) => `@${c}`).join(", ")})`,
  );
  for (const row of rows) insert.run({ ...row, id: randomUUID() });

  sqlite.exec("DROP TABLE channel_kanban_boards");
  sqlite.exec("ALTER TABLE channel_kanban_boards__new RENAME TO channel_kanban_boards");
  sqlite.exec(BOARD_INDEXES);
  return rows.length;
}

/**
 * Rebuild plus metadata table creation. Idempotent — fine to run on every boot.
 *
 * Foreign keys are turned off only for the duration of the rebuild, to keep `DROP TABLE` from
 * breaking references, and restored to their original value afterward. PRAGMA can't be changed
 * inside a transaction, so it's handled outside one.
 */
function ensureProjectRegistry(sqlite) {
  if (
    tableExists(sqlite, "channel_kanban_boards") &&
    !hasColumn(sqlite, "channel_kanban_boards", "id")
  ) {
    const fkWasOn = sqlite.pragma("foreign_keys", { simple: true });
    if (fkWasOn) sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.transaction(() => rebuildBoardsTable(sqlite))();
    } finally {
      if (fkWasOn) sqlite.pragma("foreign_keys = ON");
    }
  }
  // On an existing DB, the column must be backfilled first before the partial index can be created.
  if (
    tableExists(sqlite, "channel_kanban_boards") &&
    !hasColumn(sqlite, "channel_kanban_boards", "event_carrier_handoff_json")
  ) {
    sqlite.exec("ALTER TABLE channel_kanban_boards ADD COLUMN event_carrier_handoff_json TEXT");
  }
  // Always ensure the indexes, whether or not a rebuild happened (including on an empty DB).
  if (tableExists(sqlite, "channel_kanban_boards")) sqlite.exec(BOARD_INDEXES);
  sqlite.exec(PROJECT_TABLES);
}

module.exports = { ensureProjectRegistry };
