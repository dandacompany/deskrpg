// src/db/schema.sqlite.cjs
// CommonJS mirror of the SQLite schema, required at runtime by the custom server
// (server.js -> src/db/server-db.js), which cannot import the TypeScript
// schema-sqlite.ts directly. The canonical typed definitions live in
// src/db/schema-sqlite.ts; this file MUST stay structurally identical to it.
// src/db/schema-drift.test.ts guards drift.

"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  uniqueIndex,
} = require("drizzle-orm/sqlite-core");
const { randomUUID } = require("node:crypto");

const isoNow = () => new Date().toISOString();

const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  loginId: text("login_id").unique().notNull(),
  nickname: text("nickname").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  systemRole: text("system_role").notNull().default("user"),
  lastActiveAt: text("last_active_at"),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
});

const characters = sqliteTable("characters", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  appearance: text("appearance").notNull(),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_characters_user_id").on(table.userId),
]);

const groups = sqliteTable("groups", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  description: text("description"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
});

const channels = sqliteTable("channels", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
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
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
});

const gatewayResources = sqliteTable("gateway_resources", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  pairedDeviceId: text("paired_device_id"),
  lastValidatedAt: text("last_validated_at"),
  lastValidationStatus: text("last_validation_status"),
  lastValidationError: text("last_validation_error"),
  localDiscoveryOptedInAt: text("local_discovery_opted_in_at"),
  localDiscoveryOptedInBy: text("local_discovery_opted_in_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  updatedAt: text("updated_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_gateway_resources_owner_user_id").on(table.ownerUserId),
]);

const gatewayShares = sqliteTable("gateway_shares", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  gatewayId: text("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("use"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_gateway_shares_gateway_id").on(table.gatewayId),
  index("idx_gateway_shares_user_id").on(table.userId),
  uniqueIndex("gateway_shares_gateway_user_idx").on(table.gatewayId, table.userId),
]);

const hermesProfiles = sqliteTable("hermes_profiles", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  gatewayId: text("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  profileName: text("profile_name").notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  provisionedByDeskrpg: integer("provisioned_by_deskrpg", { mode: "boolean" }).notNull().default(false),
  lastValidatedAt: text("last_validated_at"),
  lastValidationStatus: text("last_validation_status"),
  lastValidationError: text("last_validation_error"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  updatedAt: text("updated_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_hermes_profiles_gateway_id").on(table.gatewayId),
  uniqueIndex("hermes_profiles_gateway_name_idx").on(table.gatewayId, table.profileName),
]);

const providerResources = sqliteTable("provider_resources", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerType: text("provider_type").notNull(),
  displayName: text("display_name"),
  authMethod: text("auth_method").notNull(),
  credentialsEncrypted: text("credentials_encrypted"),
  baseUrl: text("base_url"),
  lastValidatedAt: text("last_validated_at"),
  lastValidationStatus: text("last_validation_status"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  updatedAt: text("updated_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_provider_resources_owner").on(table.ownerUserId),
]);

const providerShares = sqliteTable("provider_shares", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  providerId: text("provider_id").notNull().references(() => providerResources.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("use"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_provider_shares_provider").on(table.providerId),
  uniqueIndex("provider_shares_provider_user_idx").on(table.providerId, table.userId),
]);

const channelGatewayBindings = sqliteTable("channel_gateway_bindings", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  gatewayId: text("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  boundByUserId: text("bound_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  boundAt: text("bound_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_channel_gateway_bindings_gateway_id").on(table.gatewayId),
  uniqueIndex("channel_gateway_bindings_channel_idx").on(table.channelId),
]);

const groupMembers = sqliteTable("group_members", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: text("approved_at"),
  joinedAt: text("joined_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_group_members_group_id").on(table.groupId),
  index("idx_group_members_user_id").on(table.userId),
  unique("group_members_group_user_unique").on(table.groupId, table.userId),
]);

const groupInvites = sqliteTable("group_invites", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  token: text("token").unique().notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
  targetLoginId: text("target_login_id"),
  expiresAt: text("expires_at"),
  acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: text("accepted_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_group_invites_group_id").on(table.groupId),
  index("idx_group_invites_target_user_id").on(table.targetUserId),
]);

const groupJoinRequests = sqliteTable("group_join_requests", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  message: text("message"),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_group_join_requests_group_id").on(table.groupId),
  index("idx_group_join_requests_user_id").on(table.userId),
  unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
]);

const groupPermissions = sqliteTable("group_permissions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  permissionKey: text("permission_key").notNull(),
  effect: text("effect").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_group_permissions_group_id").on(table.groupId),
  unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
]);

const userPermissionOverrides = sqliteTable("user_permission_overrides", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permissionKey: text("permission_key").notNull(),
  effect: text("effect").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_user_permission_overrides_group_id").on(table.groupId),
  index("idx_user_permission_overrides_user_id").on(table.userId),
  unique("user_permission_overrides_group_user_permission_unique").on(table.groupId, table.userId, table.permissionKey),
]);

const channelMembers = sqliteTable("channel_members", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  lastX: integer("last_x"),
  lastY: integer("last_y"),
  joinedAt: text("joined_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_channel_members_channel_id").on(table.channelId),
  index("idx_channel_members_user_id").on(table.userId),
  unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
]);

const maps = sqliteTable("maps", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tilemapPath: text("tilemap_path").notNull(),
  config: text("config"),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
});

const mapPortals = sqliteTable("map_portals", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  fromMapId: text("from_map_id").references(() => maps.id),
  toMapId: text("to_map_id").references(() => maps.id),
  fromX: integer("from_x").notNull(),
  fromY: integer("from_y").notNull(),
  toX: integer("to_x").notNull(),
  toY: integer("to_y").notNull(),
});

const mapTemplates = sqliteTable("map_templates", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("\u{1F5FA}️"),
  description: text("description"),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: text("layers"),
  objects: text("objects"),
  tiledJson: text("tiled_json"),
  thumbnail: text("thumbnail"),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  tags: text("tags"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
});

const npcs = sqliteTable("npcs", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  positionX: integer("position_x").notNull(),
  positionY: integer("position_y").notNull(),
  direction: text("direction").default("down"),
  appearance: text("appearance").notNull(),
  openclawConfig: text("openclaw_config").notNull(),
  adapterType: text("adapter_type").notNull().default("openclaw"),
  adapterConfig: text("adapter_config"),
  hermesProfileId: text("hermes_profile_id").references(() => hermesProfiles.id, { onDelete: "set null" }),
  agentConfig: text("agent_config"),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_npcs_channel_id").on(table.channelId),
  unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
]);

const npcSessions = sqliteTable("npc_sessions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  adapterType: text("adapter_type").notNull(),
  sessionType: text("session_type").notNull(),
  sessionRef: text("session_ref").notNull(),
  contextKey: text("context_key").notNull(),
  lastSummary: text("last_summary"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  updatedAt: text("updated_at").$defaultFn(isoNow).notNull(),
}, (table) => [
  index("idx_npc_sessions_npc").on(table.npcId),
  uniqueIndex("npc_sessions_npc_user_context_idx").on(table.npcId, table.userId, table.contextKey),
]);

// Forward declared so npcReports can reference it.
const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id),
  npcId: text("npc_id").references(() => npcs.id, { onDelete: "cascade" }),
  assignerId: text("assigner_id").notNull().references(() => characters.id),
  npcTaskId: text("npc_task_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  status: text("status").notNull().default("pending"),
  autoNudgeCount: integer("auto_nudge_count").notNull().default(0),
  autoNudgeMax: integer("auto_nudge_max").notNull().default(5),
  lastNudgedAt: text("last_nudged_at"),
  lastReportedAt: text("last_reported_at"),
  stalledAt: text("stalled_at"),
  stalledReason: text("stalled_reason"),
  createdAt: text("created_at").$defaultFn(isoNow),
  updatedAt: text("updated_at").$defaultFn(isoNow),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_tasks_channel").on(table.channelId),
  index("idx_tasks_npc").on(table.npcId),
  uniqueIndex("idx_tasks_npc_task_id").on(table.npcId, table.npcTaskId),
]);

const npcReports = sqliteTable("npc_reports", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  targetUserId: text("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  deliveredAt: text("delivered_at"),
  consumedAt: text("consumed_at"),
});

const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  characterId: text("character_id").notNull().references(() => characters.id),
  npcId: text("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  index("idx_chat_messages_lookup").on(table.characterId, table.npcId, table.createdAt),
]);

const meetingMinutes = sqliteTable("meeting_minutes", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  topic: text("topic").notNull(),
  transcript: text("transcript").notNull(),
  participants: text("participants").notNull().default("[]"),
  totalTurns: integer("total_turns").notNull().default(0),
  durationSeconds: integer("duration_seconds"),
  initiatorId: text("initiator_id").references(() => users.id, { onDelete: "set null" }),
  keyTopics: text("key_topics").notNull().default("[]"),
  conclusions: text("conclusions"),
  createdAt: text("created_at").notNull().$defaultFn(isoNow),
}, (table) => [
  index("idx_meeting_minutes_channel").on(table.channelId),
  index("idx_meeting_minutes_created").on(table.createdAt),
]);

const stamps = sqliteTable("stamps", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  tileWidth: integer("tile_width").notNull().default(32),
  tileHeight: integer("tile_height").notNull().default(32),
  layers: text("layers").notNull(),
  tilesets: text("tilesets").notNull(),
  thumbnail: text("thumbnail"),
  createdBy: text("created_by").references(() => users.id),
  builtIn: integer("built_in", { mode: "boolean" }).default(false).notNull(),
  tags: text("tags"),
  createdAt: text("created_at").$defaultFn(isoNow),
});

const tilesetImages = sqliteTable("tileset_images", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  tilewidth: integer("tilewidth").notNull().default(32),
  tileheight: integer("tileheight").notNull().default(32),
  columns: integer("columns").notNull(),
  tilecount: integer("tilecount").notNull(),
  image: text("image").notNull(), // base64 data URL
  builtIn: integer("built_in", { mode: "boolean" }).default(false).notNull(),
  tags: text("tags"),
  createdAt: text("created_at").$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_tileset_images_name").on(table.name),
]);

const projects = sqliteTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  name: text("name").notNull(),
  thumbnail: text("thumbnail"),
  tiledJson: text("tiled_json"),
  settings: text("settings"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").$defaultFn(isoNow).notNull(),
  updatedAt: text("updated_at").$defaultFn(isoNow).notNull(),
});

const projectTilesets = sqliteTable("project_tilesets", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tilesetId: text("tileset_id").notNull().references(() => tilesetImages.id, { onDelete: "cascade" }),
  firstgid: integer("firstgid").notNull(),
  addedAt: text("added_at").$defaultFn(isoNow).notNull(),
}, (t) => [
  unique("uq_project_tileset").on(t.projectId, t.tilesetId),
]);

const projectStamps = sqliteTable("project_stamps", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stampId: text("stamp_id").notNull().references(() => stamps.id, { onDelete: "cascade" }),
  addedAt: text("added_at").$defaultFn(isoNow).notNull(),
}, (t) => [
  unique("uq_project_stamp").on(t.projectId, t.stampId),
]);

module.exports = {
  users,
  characters,
  groups,
  channels,
  gatewayResources,
  gatewayShares,
  hermesProfiles,
  providerResources,
  providerShares,
  channelGatewayBindings,
  groupMembers,
  groupInvites,
  groupJoinRequests,
  groupPermissions,
  userPermissionOverrides,
  channelMembers,
  maps,
  mapPortals,
  mapTemplates,
  npcs,
  npcSessions,
  npcReports,
  chatMessages,
  meetingMinutes,
  tasks,
  stamps,
  tilesetImages,
  projects,
  projectTilesets,
  projectStamps,
};
