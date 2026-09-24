// Per-tab read state table for the staff panel. Called by both bootstrap paths
// (src/db/index.ts, server-db.js) — adding it to only one silently produces "no such table"
// only on the DB that path opens (kept as a shared module for the same reason as
// sqlite-kanban-cron-bookkeeping.js).
"use strict";

const NPC_PANEL_READS_TABLE = `
  CREATE TABLE IF NOT EXISTS npc_panel_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
    tab TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    seen_ids TEXT,
    PRIMARY KEY (user_id, npc_id, tab)
  );
`;

/** Creates the table. Idempotent — fine to run on every boot. */
function ensureNpcPanelReads(sqlite) {
  sqlite.exec(NPC_PANEL_READS_TABLE);
}

module.exports = { ensureNpcPanelReads };
