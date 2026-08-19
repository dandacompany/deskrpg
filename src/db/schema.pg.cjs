// src/db/schema.pg.cjs
// CommonJS mirror of the PostgreSQL schema, required at runtime by the custom
// server (server.js -> src/db/server-db.js), which cannot import the TypeScript
// schema.ts directly. The canonical typed definitions live in src/db/schema.ts
// (consumed by the Next.js app and read by drizzle-kit for migrations); this file
// MUST stay structurally identical to it. src/db/schema-drift.test.ts guards drift.

"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  index,
  unique,
  uniqueIndex,
} = require("drizzle-orm/pg-core");

const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  loginId: varchar("login_id", { length: 50 }).unique().notNull(),
  nickname: varchar("nickname", { length: 50 }).unique().notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  systemRole: varchar("system_role", { length: 20 }).notNull().default("user"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const characters = pgTable("characters", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 50 }).notNull(),
  appearance: jsonb("appearance").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_characters_user_id").on(table.userId),
]);

const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  description: varchar("description", { length: 500 }),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  description: varchar("description", { length: 500 }),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
  mapData: jsonb("map_data"),
  mapConfig: jsonb("map_config"),
  isPublic: boolean("is_public").default(true),
  inviteCode: varchar("invite_code", { length: 20 }).unique(),
  maxPlayers: integer("max_players").default(50),
  password: varchar("password", { length: 255 }),
  gatewayConfig: jsonb("gateway_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const gatewayResources = pgTable("gateway_resources", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  baseUrl: text("base_url").notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  pairedDeviceId: text("paired_device_id"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationStatus: varchar("last_validation_status", { length: 40 }),
  lastValidationError: text("last_validation_error"),
  localDiscoveryOptedInAt: timestamp("local_discovery_opted_in_at"),
  localDiscoveryOptedInBy: text("local_discovery_opted_in_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_gateway_resources_owner_user_id").on(table.ownerUserId),
]);

const gatewayShares = pgTable("gateway_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  gatewayId: uuid("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 32 }).notNull().default("use"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_gateway_shares_gateway_id").on(table.gatewayId),
  index("idx_gateway_shares_user_id").on(table.userId),
  uniqueIndex("gateway_shares_gateway_user_idx").on(table.gatewayId, table.userId),
]);

const hermesProfiles = pgTable("hermes_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  gatewayId: uuid("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  profileName: varchar("profile_name", { length: 120 }).notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  displayName: varchar("display_name", { length: 120 }),
  description: text("description"),
  provisionedByDeskrpg: boolean("provisioned_by_deskrpg").notNull().default(false),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationStatus: varchar("last_validation_status", { length: 40 }),
  lastValidationError: text("last_validation_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_hermes_profiles_gateway_id").on(table.gatewayId),
  uniqueIndex("hermes_profiles_gateway_name_idx").on(table.gatewayId, table.profileName),
]);

const providerResources = pgTable("provider_resources", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  providerType: varchar("provider_type", { length: 20 }).notNull(),
  displayName: varchar("display_name", { length: 120 }),
  authMethod: varchar("auth_method", { length: 20 }).notNull(),
  credentialsEncrypted: text("credentials_encrypted"),
  baseUrl: text("base_url"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastValidationStatus: varchar("last_validation_status", { length: 40 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_provider_resources_owner").on(table.ownerUserId),
]);

const providerShares = pgTable("provider_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull().references(() => providerResources.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 10 }).notNull().default("use"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_provider_shares_provider").on(table.providerId),
  uniqueIndex("provider_shares_provider_user_idx").on(table.providerId, table.userId),
]);

const channelGatewayBindings = pgTable("channel_gateway_bindings", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  gatewayId: uuid("gateway_id").notNull().references(() => gatewayResources.id, { onDelete: "cascade" }),
  boundByUserId: uuid("bound_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  boundAt: timestamp("bound_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_channel_gateway_bindings_gateway_id").on(table.gatewayId),
  uniqueIndex("channel_gateway_bindings_channel_idx").on(table.channelId),
]);

const groupMembers = pgTable("group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull().default("member"),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_group_members_group_id").on(table.groupId),
  index("idx_group_members_user_id").on(table.userId),
  unique("group_members_group_user_unique").on(table.groupId, table.userId),
]);

const groupInvites = pgTable("group_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).unique().notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
  targetLoginId: varchar("target_login_id", { length: 50 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_group_invites_group_id").on(table.groupId),
  index("idx_group_invites_target_user_id").on(table.targetUserId),
]);

const groupJoinRequests = pgTable("group_join_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  message: text("message"),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_group_join_requests_group_id").on(table.groupId),
  index("idx_group_join_requests_user_id").on(table.userId),
  unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
]);

const groupPermissions = pgTable("group_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  permissionKey: varchar("permission_key", { length: 50 }).notNull(),
  effect: varchar("effect", { length: 10 }).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_group_permissions_group_id").on(table.groupId),
  unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
]);

const userPermissionOverrides = pgTable("user_permission_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permissionKey: varchar("permission_key", { length: 50 }).notNull(),
  effect: varchar("effect", { length: 10 }).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_user_permission_overrides_group_id").on(table.groupId),
  index("idx_user_permission_overrides_user_id").on(table.userId),
  unique("user_permission_overrides_group_user_permission_unique").on(table.groupId, table.userId, table.permissionKey),
]);

const channelMembers = pgTable("channel_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull().default("member"),
  lastX: integer("last_x"),
  lastY: integer("last_y"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_channel_members_channel_id").on(table.channelId),
  index("idx_channel_members_user_id").on(table.userId),
  unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
]);

const maps = pgTable("maps", {
  id: varchar("id", { length: 100 }).primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  tilemapPath: varchar("tilemap_path", { length: 500 }).notNull(),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const mapPortals = pgTable("map_portals", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromMapId: varchar("from_map_id", { length: 100 }).references(() => maps.id),
  toMapId: varchar("to_map_id", { length: 100 }).references(() => maps.id),
  fromX: integer("from_x").notNull(),
  fromY: integer("from_y").notNull(),
  toX: integer("to_x").notNull(),
  toY: integer("to_y").notNull(),
});

const mapTemplates = pgTable("map_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  icon: varchar("icon", { length: 10 }).notNull().default("\u{1F5FA}️"),
  description: varchar("description", { length: 500 }),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  layers: jsonb("layers"),
  objects: jsonb("objects"),
  tiledJson: jsonb("tiled_json"),
  thumbnail: text("thumbnail"),
  spawnCol: integer("spawn_col").notNull(),
  spawnRow: integer("spawn_row").notNull(),
  tags: varchar("tags", { length: 500 }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const npcs = pgTable("npcs", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  positionX: integer("position_x").notNull(),
  positionY: integer("position_y").notNull(),
  direction: varchar("direction", { length: 10 }).default("down"),
  appearance: jsonb("appearance").notNull(),
  openclawConfig: jsonb("openclaw_config").notNull(),
  adapterType: varchar("adapter_type", { length: 20 }).notNull().default("openclaw"),
  adapterConfig: jsonb("adapter_config"),
  hermesProfileId: uuid("hermes_profile_id").references(() => hermesProfiles.id, { onDelete: "set null" }),
  agentConfig: jsonb("agent_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_npcs_channel_id").on(table.channelId),
  unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
]);

const npcSessions = pgTable("npc_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  npcId: uuid("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  adapterType: varchar("adapter_type", { length: 20 }).notNull(),
  sessionType: varchar("session_type", { length: 20 }).notNull(),
  sessionRef: varchar("session_ref", { length: 200 }).notNull(),
  contextKey: varchar("context_key", { length: 200 }).notNull(),
  lastSummary: text("last_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_npc_sessions_npc").on(table.npcId),
  uniqueIndex("npc_sessions_npc_user_context_idx").on(table.npcId, table.userId, table.contextKey),
]);

const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  npcId: uuid("npc_id").references(() => npcs.id, { onDelete: "cascade" }),
  assignerId: uuid("assigner_id").notNull().references(() => characters.id),
  npcTaskId: varchar("npc_task_id", { length: 64 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  summary: text("summary"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  autoNudgeCount: integer("auto_nudge_count").notNull().default(0),
  autoNudgeMax: integer("auto_nudge_max").notNull().default(5),
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  lastReportedAt: timestamp("last_reported_at", { withTimezone: true }),
  stalledAt: timestamp("stalled_at", { withTimezone: true }),
  stalledReason: varchar("stalled_reason", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("idx_tasks_channel").on(table.channelId),
  index("idx_tasks_npc").on(table.npcId),
  uniqueIndex("idx_tasks_npc_task_id").on(table.npcId, table.npcTaskId),
]);

const npcReports = pgTable("npc_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  npcId: uuid("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  targetUserId: uuid("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 20 }).notNull(),
  message: text("message").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  characterId: uuid("character_id").notNull().references(() => characters.id),
  npcId: uuid("npc_id").notNull().references(() => npcs.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 10 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_chat_messages_lookup").on(table.characterId, table.npcId, table.createdAt),
]);

const meetingMinutes = pgTable("meeting_minutes", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  topic: text("topic").notNull(),
  transcript: text("transcript").notNull(),
  participants: jsonb("participants").notNull().default([]),
  totalTurns: integer("total_turns").notNull().default(0),
  durationSeconds: integer("duration_seconds"),
  initiatorId: uuid("initiator_id").references(() => users.id, { onDelete: "set null" }),
  keyTopics: jsonb("key_topics").notNull().default([]),
  conclusions: text("conclusions"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_meeting_minutes_channel").on(table.channelId),
  index("idx_meeting_minutes_created").on(table.createdAt),
]);

const stamps = pgTable("stamps", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  tileWidth: integer("tile_width").notNull().default(32),
  tileHeight: integer("tile_height").notNull().default(32),
  layers: jsonb("layers").notNull(),
  tilesets: jsonb("tilesets").notNull(),
  thumbnail: text("thumbnail"),
  createdBy: uuid("created_by").references(() => users.id),
  builtIn: boolean("built_in").default(false).notNull(),
  tags: text("tags"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

const tilesetImages = pgTable("tileset_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  tilewidth: integer("tilewidth").notNull().default(32),
  tileheight: integer("tileheight").notNull().default(32),
  columns: integer("columns").notNull(),
  tilecount: integer("tilecount").notNull(),
  image: text("image").notNull(),
  builtIn: boolean("built_in").default(false).notNull(),
  tags: text("tags"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_tileset_images_name").on(table.name),
]);

const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  thumbnail: text("thumbnail"),
  tiledJson: jsonb("tiled_json"),
  settings: jsonb("settings"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

const projectTilesets = pgTable("project_tilesets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tilesetId: uuid("tileset_id").notNull().references(() => tilesetImages.id, { onDelete: "cascade" }),
  firstgid: integer("firstgid").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("uq_project_tileset").on(t.projectId, t.tilesetId),
]);

const projectStamps = pgTable("project_stamps", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  stampId: uuid("stamp_id").notNull().references(() => stamps.id, { onDelete: "cascade" }),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
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
