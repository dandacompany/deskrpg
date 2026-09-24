// The kanban board/cron job ledger tables plus their two extra columns. Called by both
// bootstrap paths (src/db/index.ts, server-db.js) — adding it to only one silently produces
// "no such table/column" only on the DB that path opens (kept as a shared module for the same
// reason as chat_rooms).
"use strict";

const KANBAN_CRON_TABLES = `
  CREATE TABLE IF NOT EXISTS channel_kanban_boards (
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
  -- The (channel_id, board_slug) and carrier unique indexes are not created here. An existing DB still has the
  -- old shape (no carrier column) at this point and would fail — that belongs to sqlite-project-registry.js after its rebuild.
  CREATE INDEX IF NOT EXISTS idx_channel_kanban_boards_gateway_id ON channel_kanban_boards(gateway_id);
  CREATE TABLE IF NOT EXISTS cron_job_origins (
    id TEXT PRIMARY KEY NOT NULL,
    gateway_id TEXT NOT NULL REFERENCES gateway_resources(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL,
    job_id TEXT NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE(gateway_id, profile_name, job_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cron_job_origins_channel_id ON cron_job_origins(channel_id);
  CREATE UNIQUE INDEX IF NOT EXISTS cron_job_origins_gateway_profile_job_idx ON cron_job_origins(gateway_id, profile_name, job_id);
`;

/** Columns to add to an existing DB. Grouped by table, and the group is skipped if the table doesn't exist. */
const KANBAN_CRON_COLUMNS = {
  // Cache of the raw `GET /deskrpg/info` response — kanban/cron support is read from here.
  gateway_resources: ["ALTER TABLE gateway_resources ADD COLUMN plugin_info_json TEXT"],
  // Structured payload for a system message. NULL for ordinary messages.
  chat_room_messages: ["ALTER TABLE chat_room_messages ADD COLUMN notice_json TEXT"],
};

function tableExists(sqlite, table) {
  return Boolean(
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

/**
 * Creates the two tables and adds the two columns. Idempotent — fine to run on every boot.
 * The ALTER only swallows "duplicate column name" and rethrows any other error.
 */
function ensureKanbanCronBookkeeping(sqlite) {
  sqlite.exec(KANBAN_CRON_TABLES);
  for (const [table, statements] of Object.entries(KANBAN_CRON_COLUMNS)) {
    if (!tableExists(sqlite, table)) continue;
    for (const statement of statements) {
      try {
        sqlite.exec(statement);
      } catch (error) {
        if (!String(error).includes("duplicate column name")) throw error;
      }
    }
  }
}

module.exports = { KANBAN_CRON_TABLES, KANBAN_CRON_COLUMNS, ensureKanbanCronBookkeeping };
