// Group chat room tables. Called by both bootstrap paths (src/db/index.ts, server-db.js) —
// adding it to only one leaves the table missing from the DB the socket server opens, killing
// chat outright (same failure type as the 2026-09 T2 incident).
"use strict";

const CHAT_ROOM_TABLES = `
  CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    reply_policy TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    last_message_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_chat_rooms_channel ON chat_rooms(channel_id, last_message_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_rooms_office_per_channel ON chat_rooms(channel_id) WHERE kind = 'office';
  CREATE TABLE IF NOT EXISTS chat_room_members (
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    member_kind TEXT NOT NULL,
    member_id TEXT NOT NULL,
    invited_by TEXT REFERENCES users(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, member_kind, member_id)
  );
  CREATE TABLE IF NOT EXISTS chat_room_messages (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_kind TEXT NOT NULL,
    sender_id TEXT,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_room_messages_room ON chat_room_messages(room_id, created_at);
`;

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
 * Creates the tables and backfills an office room per channel. Idempotent — fine to run on
 * every boot. The backfill only runs when the `channels` table exists and has an `owner_id`
 * column — a minimal fixture used by things like RBAC (channels with just an id, or no
 * channels table at all) doesn't have that shape yet.
 */
function ensureChatRoomTables(sqlite) {
  sqlite.exec(CHAT_ROOM_TABLES);
  if (!tableExists(sqlite, "channels") || !hasColumn(sqlite, "channels", "owner_id")) {
    console.warn(
      "[chat-rooms] channels.owner_id is missing, so the office room backfill is skipped — channel chat in this DB may look empty",
    );
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO chat_rooms (id, channel_id, kind, name, reply_policy, created_by, created_at)
       SELECT lower(hex(randomblob(16))), c.id, 'office', 'office', 'mention', c.owner_id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
       FROM channels c
       WHERE NOT EXISTS (SELECT 1 FROM chat_rooms r WHERE r.channel_id = c.id AND r.kind = 'office')`,
    )
    .run();
}

module.exports = { CHAT_ROOM_TABLES, ensureChatRoomTables };
