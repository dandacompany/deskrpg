"use strict";

function ensureSqliteBaseSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      login_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      system_role TEXT NOT NULL DEFAULT 'user',
      last_active_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      appearance TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);

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

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      map_data TEXT,
      map_config TEXT,
      is_public INTEGER DEFAULT 1,
      invite_code TEXT UNIQUE,
      max_players INTEGER DEFAULT 50,
      password TEXT,
      gateway_config TEXT,
      created_at TEXT,
      updated_at TEXT
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
    CREATE UNIQUE INDEX IF NOT EXISTS group_join_requests_group_user_unique ON group_join_requests(group_id, user_id);

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

    CREATE TABLE IF NOT EXISTS channel_members (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      last_x INTEGER,
      last_y INTEGER,
      joined_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_members_channel_id ON channel_members(channel_id);
    CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON channel_members(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS channel_members_channel_user_unique ON channel_members(channel_id, user_id);

    CREATE TABLE IF NOT EXISTS maps (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      tilemap_path TEXT NOT NULL,
      config TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS map_portals (
      id TEXT PRIMARY KEY NOT NULL,
      from_map_id TEXT REFERENCES maps(id),
      to_map_id TEXT REFERENCES maps(id),
      from_x INTEGER NOT NULL,
      from_y INTEGER NOT NULL,
      to_x INTEGER NOT NULL,
      to_y INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_templates (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🗺️',
      description TEXT,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      layers TEXT,
      objects TEXT,
      tiled_json TEXT,
      thumbnail TEXT,
      spawn_col INTEGER NOT NULL,
      spawn_row INTEGER NOT NULL,
      tags TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS npcs (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position_x INTEGER NOT NULL,
      position_y INTEGER NOT NULL,
      direction TEXT DEFAULT 'down',
      appearance TEXT NOT NULL,
      openclaw_config TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(channel_id, position_x, position_y)
    );
    CREATE INDEX IF NOT EXISTS idx_npcs_channel_id ON npcs(channel_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      assigner_id TEXT NOT NULL REFERENCES characters(id),
      npc_task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      auto_nudge_count INTEGER NOT NULL DEFAULT 0,
      auto_nudge_max INTEGER NOT NULL DEFAULT 5,
      last_nudged_at TEXT,
      last_reported_at TEXT,
      stalled_at TEXT,
      stalled_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_npc ON tasks(npc_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_npc_task_id ON tasks(npc_id, npc_task_id);

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

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY NOT NULL,
      character_id TEXT NOT NULL REFERENCES characters(id),
      npc_id TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_lookup ON chat_messages(character_id, npc_id, created_at);

    CREATE TABLE IF NOT EXISTS meeting_minutes (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      transcript TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]',
      total_turns INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER,
      initiator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      key_topics TEXT NOT NULL DEFAULT '[]',
      conclusions TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_minutes_channel ON meeting_minutes(channel_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_minutes_created ON meeting_minutes(created_at);

    CREATE TABLE IF NOT EXISTS stamps (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      tile_width INTEGER NOT NULL DEFAULT 32,
      tile_height INTEGER NOT NULL DEFAULT 32,
      layers TEXT NOT NULL,
      tilesets TEXT NOT NULL,
      thumbnail TEXT,
      created_by TEXT REFERENCES users(id),
      built_in INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tileset_images (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      tilewidth INTEGER NOT NULL DEFAULT 32,
      tileheight INTEGER NOT NULL DEFAULT 32,
      columns INTEGER NOT NULL,
      tilecount INTEGER NOT NULL,
      image TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      tags TEXT,
      created_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tileset_images_name ON tileset_images(name);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      thumbnail TEXT,
      tiled_json TEXT,
      settings TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_tilesets (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tileset_id TEXT NOT NULL REFERENCES tileset_images(id) ON DELETE CASCADE,
      firstgid INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      UNIQUE(project_id, tileset_id)
    );

    CREATE TABLE IF NOT EXISTS project_stamps (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stamp_id TEXT NOT NULL REFERENCES stamps(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      UNIQUE(project_id, stamp_id)
    );
  `);
}

module.exports = { ensureSqliteBaseSchema };
