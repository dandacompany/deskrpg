// src/db/schema.pg.cjs
// CommonJS mirror of the PostgreSQL schema, required at runtime by the custom
// server (server.js -> src/db/server-db.js), which cannot import the TypeScript
// schema.ts directly. The canonical typed definitions live in src/db/schema.ts
// (consumed by the Next.js app and read by drizzle-kit for migrations); this file
// MUST stay structurally identical to it. src/db/schema-drift.test.ts guards drift.

"use strict";

const { sql } = require("drizzle-orm");
const {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  date,
  index,
  unique,
  uniqueIndex,
  primaryKey,
} = require("drizzle-orm/pg-core");

const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  loginId: varchar("login_id", { length: 50 }).unique().notNull(),
  nickname: varchar("nickname", { length: 50 }).unique().notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  systemRole: varchar("system_role", { length: 20 }).notNull().default("user"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(),
    appearance: jsonb("appearance").notNull(),
    bio: text("bio"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("idx_characters_user_id").on(table.userId)],
);

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
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
  mapData: jsonb("map_data"),
  mapConfig: jsonb("map_config"),
  isPublic: boolean("is_public").default(true),
  inviteCode: varchar("invite_code", { length: 20 }).unique(),
  maxPlayers: integer("max_players").default(50),
  password: varchar("password", { length: 255 }),
  gatewayConfig: jsonb("gateway_config"),
  motionConfig: jsonb("motion_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

const gatewayResources = pgTable(
  "gateway_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    baseUrl: text("base_url").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    pairedDeviceId: text("paired_device_id"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastValidationStatus: varchar("last_validation_status", { length: 40 }),
    lastValidationError: text("last_validation_error"),
    localDiscoveryOptedInAt: timestamp("local_discovery_opted_in_at", { withTimezone: true }),
    localDiscoveryOptedInBy: uuid("local_discovery_opted_in_by").references(() => users.id, {
      onDelete: "set null",
    }),
    pluginStatus: varchar("plugin_status", { length: 40 }),
    pluginVersion: text("plugin_version"),
    pluginCheckedAt: timestamp("plugin_checked_at", { withTimezone: true }),
    // Cache of the `GET /deskrpg/info` response body (JSON string). plugin_status/plugin_version
    // are the verdict summary; support for detail features like kanban/cron is read from this raw text.
    pluginInfoJson: text("plugin_info_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_gateway_resources_owner_user_id").on(table.ownerUserId)],
);

const gatewayShares = pgTable(
  "gateway_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gatewayId: uuid("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull().default("use"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_gateway_shares_gateway_id").on(table.gatewayId),
    index("idx_gateway_shares_user_id").on(table.userId),
    uniqueIndex("gateway_shares_gateway_user_idx").on(table.gatewayId, table.userId),
  ],
);

const hermesProfiles = pgTable(
  "hermes_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gatewayId: uuid("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    profileName: varchar("profile_name", { length: 120 }).notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    displayName: varchar("display_name", { length: 120 }),
    description: text("description"),
    /** Character appearance. Source of truth for the NPC — npcs.appearance is kept this release but unused. */
    appearance: jsonb("appearance"),
    provisionedByDeskrpg: boolean("provisioned_by_deskrpg").notNull().default(false),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastValidationStatus: varchar("last_validation_status", { length: 40 }),
    lastValidationError: text("last_validation_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_hermes_profiles_gateway_id").on(table.gatewayId),
    uniqueIndex("hermes_profiles_gateway_name_idx").on(table.gatewayId, table.profileName),
  ],
);

const providerResources = pgTable(
  "provider_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerType: varchar("provider_type", { length: 20 }).notNull(),
    displayName: varchar("display_name", { length: 120 }),
    authMethod: varchar("auth_method", { length: 20 }).notNull(),
    credentialsEncrypted: text("credentials_encrypted"),
    baseUrl: text("base_url"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastValidationStatus: varchar("last_validation_status", { length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_provider_resources_owner").on(table.ownerUserId)],
);

const providerShares = pgTable(
  "provider_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providerResources.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 10 }).notNull().default("use"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_provider_shares_provider").on(table.providerId),
    uniqueIndex("provider_shares_provider_user_idx").on(table.providerId, table.userId),
  ],
);

const channelGatewayBindings = pgTable(
  "channel_gateway_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    gatewayId: uuid("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    boundByUserId: uuid("bound_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    boundAt: timestamp("bound_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_channel_gateway_bindings_gateway_id").on(table.gatewayId),
    uniqueIndex("channel_gateway_bindings_channel_idx").on(table.channelId),
  ],
);

// Channel ↔ Hermes kanban board binding ledger. One board per channel, so channel_id is
// effectively the PK. event_cursor is the last consumed board event position, last_error is
// the reason the last poll failed. Hermes is the source of truth for the board name, and
// board_name_synced_at is when it was last synced from there.
const channelKanbanBoards = pgTable(
  "channel_kanban_boards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    gatewayId: uuid("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    boardSlug: varchar("board_slug", { length: 64 }).notNull(),
    isEventCarrier: boolean("is_event_carrier").notNull().default(false),
    boardNameSyncedAt: timestamp("board_name_synced_at", { withTimezone: true }),
    eventCursor: text("event_cursor"),
    eventCarrierHandoffJson: text("event_carrier_handoff_json"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_channel_kanban_boards_gateway_id").on(table.gatewayId),
    uniqueIndex("channel_kanban_boards_channel_slug_idx").on(table.channelId, table.boardSlug),
    // Exactly one event-carrier board (the row that receives cron/artifacts) per channel — same trick as the office room invariant.
    uniqueIndex("channel_kanban_boards_carrier_idx")
      .on(table.channelId)
      .where(sql`${table.isEventCarrier}`),
    uniqueIndex("channel_kanban_boards_handoff_idx")
      .on(table.channelId)
      .where(sql`${table.eventCarrierHandoffJson} IS NOT NULL`),
  ],
);

// Origin ledger for Hermes cron jobs created by DeskRPG. A Hermes-side job is uniquely
// determined by (gateway, profile, job id), so that combination is unique. The ledger
// disappears with the channel, but the job itself must survive if the creating user leaves,
// so created_by is set null.
const cronJobOrigins = pgTable(
  "cron_job_origins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    gatewayId: uuid("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    profileName: varchar("profile_name", { length: 120 }).notNull(),
    jobId: varchar("job_id", { length: 120 }).notNull(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_cron_job_origins_channel_id").on(table.channelId),
    uniqueIndex("cron_job_origins_gateway_profile_job_idx").on(
      table.gatewayId,
      table.profileName,
      table.jobId,
    ),
  ],
);

const groupMembers = pgTable(
  "group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_group_members_group_id").on(table.groupId),
    index("idx_group_members_user_id").on(table.userId),
    unique("group_members_group_user_unique").on(table.groupId, table.userId),
  ],
);

const groupInvites = pgTable(
  "group_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).unique().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetLoginId: varchar("target_login_id", { length: 50 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_group_invites_group_id").on(table.groupId),
    index("idx_group_invites_target_user_id").on(table.targetUserId),
  ],
);

const groupJoinRequests = pgTable(
  "group_join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    message: text("message"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_group_join_requests_group_id").on(table.groupId),
    index("idx_group_join_requests_user_id").on(table.userId),
    unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
  ],
);

const groupPermissions = pgTable(
  "group_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 50 }).notNull(),
    effect: varchar("effect", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_group_permissions_group_id").on(table.groupId),
    unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
  ],
);

const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissionKey: varchar("permission_key", { length: 50 }).notNull(),
    effect: varchar("effect", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_user_permission_overrides_group_id").on(table.groupId),
    index("idx_user_permission_overrides_user_id").on(table.userId),
    unique("user_permission_overrides_group_user_permission_unique").on(
      table.groupId,
      table.userId,
      table.permissionKey,
    ),
  ],
);

const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    lastX: integer("last_x"),
    lastY: integer("last_y"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_channel_members_channel_id").on(table.channelId),
    index("idx_channel_members_user_id").on(table.userId),
    unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
  ],
);

const npcs = pgTable(
  "npcs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }),
    positionX: integer("position_x"),
    positionY: integer("position_y"),
    direction: varchar("direction", { length: 10 }).default("down"),
    appearance: jsonb("appearance"),
    adapterType: varchar("adapter_type", { length: 20 }).notNull().default("hermes"),
    adapterConfig: jsonb("adapter_config"),
    hermesProfileId: uuid("hermes_profile_id")
      .notNull()
      .references(() => hermesProfiles.id, { onDelete: "cascade" }),
    agentConfig: jsonb("agent_config"),
    /** Whether it's clocked in for this channel. If false, the seat is remembered but it's off the map. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_npcs_channel_id").on(table.channelId),
    unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
    uniqueIndex("npcs_channel_profile_idx").on(table.channelId, table.hermesProfileId),
  ],
);

const npcSessions = pgTable(
  "npc_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    adapterType: varchar("adapter_type", { length: 20 }).notNull(),
    sessionType: varchar("session_type", { length: 20 }).notNull(),
    sessionRef: varchar("session_ref", { length: 200 }).notNull(),
    contextKey: varchar("context_key", { length: 200 }).notNull(),
    lastSummary: text("last_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_npc_sessions_npc").on(table.npcId),
    uniqueIndex("npc_sessions_npc_user_context_idx").on(
      table.npcId,
      table.userId,
      table.contextKey,
    ),
  ],
);

const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 10 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_chat_messages_lookup").on(table.characterId, table.npcId, table.createdAt),
  ],
);

const chatRooms = pgTable(
  "chat_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 10 }).notNull(), // "office" | "group"
    name: varchar("name", { length: 60 }).notNull(),
    replyPolicy: varchar("reply_policy", { length: 10 }).notNull(), // "mention" | "members"
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_chat_rooms_channel").on(t.channelId, t.lastMessageAt),
    uniqueIndex("uq_chat_rooms_office_per_channel")
      .on(t.channelId)
      .where(sql`kind = 'office'`),
  ],
);

const chatRoomMembers = pgTable(
  "chat_room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    memberKind: varchar("member_kind", { length: 8 }).notNull(), // "user" | "npc"
    memberId: uuid("member_id").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.memberKind, t.memberId] })],
);

const chatRoomMessages = pgTable(
  "chat_room_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    senderKind: varchar("sender_kind", { length: 8 }).notNull(), // "user" | "npc" | "system"
    senderId: uuid("sender_id"),
    senderName: varchar("sender_name", { length: 100 }).notNull(),
    content: text("content").notNull(),
    // Structured payload for a system message (JSON string). A notice such as a kanban card move
    // or a cron result puts data here for card rendering, separate from the body (content).
    // NULL for ordinary messages.
    noticeJson: text("notice_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_chat_room_messages_room").on(t.roomId, t.createdAt)],
);

const meetingMinutes = pgTable(
  "meeting_minutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    transcript: text("transcript").notNull(),
    participants: jsonb("participants").notNull().default([]),
    totalTurns: integer("total_turns").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    initiatorId: uuid("initiator_id").references(() => users.id, { onDelete: "set null" }),
    keyTopics: jsonb("key_topics").notNull().default([]),
    conclusions: text("conclusions"),
    // Structured meeting outcome (decisions, follow-ups, project recommendations). A draft, not a card copy.
    outcomeJson: jsonb("outcome_json"),
    summaryStatus: text("summary_status").notNull().default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_meeting_minutes_channel").on(table.channelId),
    index("idx_meeting_minutes_created").on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Project registry table (design 2026-09-21 project-registry)
//
// Board = project, tenant = subproject. **Name, description, and progress do not live here** —
// Hermes board metadata and `GET /kanban/boards`'s `counts` are the source of truth, and a copy
// would violate hard gate 1 and eventually drift. What stays here is only the human-side
// information Hermes has no place for: status, lead NPC, target date, color, icon, pause
// reason, and the origin meeting that answers "why are we doing this".
// ---------------------------------------------------------------------------

const channelProjects = pgTable(
  "channel_projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    boardLinkId: uuid("board_link_id")
      .notNull()
      .unique()
      .references(() => channelKanbanBoards.id, { onDelete: "cascade" }),
    // Denormalized to allow per-channel listing queries without a join. Always matches the linked row's channel.
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 24 }).notNull().default("planned"),
    leadNpcId: uuid("lead_npc_id").references(() => npcs.id, { onDelete: "set null" }),
    targetDate: date("target_date"),
    color: varchar("color", { length: 16 }),
    icon: varchar("icon", { length: 40 }),
    // A pause is not a status — it's in_progress with this field filled in (same treatment as Paperclip).
    pauseReason: text("pause_reason"),
    originMeetingId: uuid("origin_meeting_id").references(() => meetingMinutes.id, {
      onDelete: "set null",
    }),
    /** Decision C-1 — reserves the slot only. This design neither reads nor writes it. */
    hermesProjectId: varchar("hermes_project_id", { length: 64 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_channel_projects_channel").on(table.channelId)],
);

const channelSubprojects = pgTable(
  "channel_subprojects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => channelProjects.id, { onDelete: "cascade" }),
    /**
     * The value that goes straight into Hermes `tasks.tenant`. **Never change it after creation**
     * — the dispatcher passes `HERMES_TENANT` to the worker and child cards inherit it, so
     * changing the value orphans cards that already exist. To change the display name, change
     * only `name`.
     */
    tenantSlug: varchar("tenant_slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 24 }).notNull().default("planned"),
    leadNpcId: uuid("lead_npc_id").references(() => npcs.id, { onDelete: "set null" }),
    targetDate: date("target_date"),
    color: varchar("color", { length: 16 }),
    icon: varchar("icon", { length: 40 }),
    pauseReason: text("pause_reason"),
    originMeetingId: uuid("origin_meeting_id").references(() => meetingMinutes.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("channel_subprojects_project_tenant_idx").on(table.projectId, table.tenantSlug),
  ],
);

const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    requestedBy: varchar("requested_by", { length: 64 }).notNull(),
    title: text("title").notNull(),
    sourceJson: text("source_json").notNull(),
    payloadJson: text("payload_json"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("approvals_channel_status_idx").on(t.channelId, t.status)],
);

const approvalTargets = pgTable(
  "approval_targets",
  {
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    taskId: varchar("task_id", { length: 64 }).notNull(),
    decision: varchar("decision", { length: 16 }),
  },
  (t) => [
    primaryKey({ columns: [t.approvalId, t.taskId] }),
    index("approval_targets_task_idx").on(t.taskId),
  ],
);

// Per-tab read state for the staff panel. Hermes is the source of truth for cards/cron — this only tracks "how far has it been seen".
const npcPanelReads = pgTable(
  "npc_panel_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    tab: varchar("tab", { length: 8 }).notNull(), // "cron" | "cards"
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
    // For the cards tab. KanbanTask has no updated_at, so a time watermark can't be used.
    // On every read, intersect with the currently assigned cards to keep the size bounded by the assigned-card count.
    seenIds: text("seen_ids"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.npcId, t.tab] })],
);

// How far a user has read each conversation and which reports they acknowledged. `target_id` is
// polymorphic (room · NPC · channel), hence no FK on it.
const conversationReads = pgTable(
  "conversation_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 8 }).notNull(), // "room" | "dm" | "report"
    targetId: uuid("target_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
    seenIds: text("seen_ids"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.targetId] })],
);

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
  channelKanbanBoards,
  cronJobOrigins,
  groupMembers,
  groupInvites,
  groupJoinRequests,
  groupPermissions,
  userPermissionOverrides,
  channelMembers,
  npcs,
  npcSessions,
  chatMessages,
  chatRooms,
  chatRoomMembers,
  chatRoomMessages,
  meetingMinutes,
  channelProjects,
  channelSubprojects,
  approvals,
  approvalTargets,
  npcPanelReads,
  conversationReads,
};
