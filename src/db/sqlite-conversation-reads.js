// Conversation read-state table. Called by both bootstrap paths (src/db/index.ts, server-db.js) —
// adding it to only one silently produces "no such table" only on the DB that path opens (same
// reason as sqlite-npc-panel-reads.js).
"use strict";

const CONVERSATION_READS_TABLE = `
  CREATE TABLE IF NOT EXISTS conversation_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    seen_ids TEXT,
    PRIMARY KEY (user_id, kind, target_id)
  );
`;

/** Creates the table. Idempotent — fine to run on every boot. */
function ensureConversationReads(sqlite) {
  sqlite.exec(CONVERSATION_READS_TABLE);
}

module.exports = { ensureConversationReads };
