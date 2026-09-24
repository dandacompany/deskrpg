// src/db/schema-sqlite.ts
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  unique,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  loginId: text("login_id").unique().notNull(),
  nickname: text("nickname").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  systemRole: text("system_role").notNull().default("user"),
  /** True once an admin/CLI issues a temporary password. Reverts to false once the user changes it. */
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  lastActiveAt: text("last_active_at"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const characters = sqliteTable(
  "characters",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    appearance: text("appearance").notNull(),
    bio: text("bio"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("idx_characters_user_id").on(table.userId)],
);

export const groups = sqliteTable("groups", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").unique().notNull(),
  description: text("description"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const channels = sqliteTable("channels", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }),
  mapData: text("map_data"),
  mapConfig: text("map_config"),
  isPublic: integer("is_public", { mode: "boolean" }).default(true),
  inviteCode: text("invite_code").unique(),
  maxPlayers: integer("max_players").default(50),
  password: text("password"),
  gatewayConfig: text("gateway_config"),
  /** NPC walk speed (`npc-motion-config`). Empty means default — a channel-shared setting. */
  motionConfig: text("motion_config"),
  createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const gatewayResources = sqliteTable(
  "gateway_resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    pairedDeviceId: text("paired_device_id"),
    lastValidatedAt: text("last_validated_at"),
    lastValidationStatus: text("last_validation_status"),
    lastValidationError: text("last_validation_error"),
    localDiscoveryOptedInAt: text("local_discovery_opted_in_at"),
    localDiscoveryOptedInBy: text("local_discovery_opted_in_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Cache of the `GET /deskrpg/info` verdict. This exists so we don't hit the remote on every
    // screen visit; it's refreshed when the gateway is tested/edited. The `plugin_status` value
    // is the same string as PluginStatus in src/lib/hermes/plugin-capability.ts.
    pluginStatus: text("plugin_status"),
    pluginVersion: text("plugin_version"),
    pluginCheckedAt: text("plugin_checked_at"),
    // Cache of the `GET /deskrpg/info` response body (JSON string). plugin_status/plugin_version
    // are the verdict summary; support for detail features like kanban/cron is read from this raw text.
    pluginInfoJson: text("plugin_info_json"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [index("idx_gateway_resources_owner_user_id").on(table.ownerUserId)],
);

export const gatewayShares = sqliteTable(
  "gateway_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("use"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [
    index("idx_gateway_shares_gateway_id").on(table.gatewayId),
    index("idx_gateway_shares_user_id").on(table.userId),
    uniqueIndex("gateway_shares_gateway_user_idx").on(table.gatewayId, table.userId),
  ],
);

export const hermesProfiles = sqliteTable(
  "hermes_profiles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    profileName: text("profile_name").notNull(),
    tokenEncrypted: text("token_encrypted").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    /** Character appearance. Source of truth for the NPC — npcs.appearance is kept this release but unused. */
    appearance: text("appearance"),
    provisionedByDeskrpg: integer("provisioned_by_deskrpg", { mode: "boolean" })
      .notNull()
      .default(false),
    lastValidatedAt: text("last_validated_at"),
    lastValidationStatus: text("last_validation_status"),
    lastValidationError: text("last_validation_error"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [
    index("idx_hermes_profiles_gateway_id").on(table.gatewayId),
    uniqueIndex("hermes_profiles_gateway_name_idx").on(table.gatewayId, table.profileName),
  ],
);

export const providerResources = sqliteTable(
  "provider_resources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerType: text("provider_type").notNull(),
    displayName: text("display_name"),
    authMethod: text("auth_method").notNull(),
    credentialsEncrypted: text("credentials_encrypted"),
    baseUrl: text("base_url"),
    lastValidatedAt: text("last_validated_at"),
    lastValidationStatus: text("last_validation_status"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [index("idx_provider_resources_owner").on(table.ownerUserId)],
);

export const providerShares = sqliteTable(
  "provider_shares",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerResources.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("use"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [
    index("idx_provider_shares_provider").on(table.providerId),
    uniqueIndex("provider_shares_provider_user_idx").on(table.providerId, table.userId),
  ],
);

export const channelGatewayBindings = sqliteTable(
  "channel_gateway_bindings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    boundByUserId: text("bound_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    boundAt: text("bound_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
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
export const channelKanbanBoards = sqliteTable(
  "channel_kanban_boards",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    boardSlug: text("board_slug").notNull(),
    isEventCarrier: integer("is_event_carrier", { mode: "boolean" }).notNull().default(false),
    boardNameSyncedAt: text("board_name_synced_at"),
    eventCursor: text("event_cursor"),
    eventCarrierHandoffJson: text("event_carrier_handoff_json"),
    lastPolledAt: text("last_polled_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
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
export const cronJobOrigins = sqliteTable(
  "cron_job_origins",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gatewayResources.id, { onDelete: "cascade" }),
    profileName: text("profile_name").notNull(),
    jobId: text("job_id").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
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

export const groupMembers = sqliteTable(
  "group_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: text("approved_at"),
    joinedAt: text("joined_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_group_members_group_id").on(table.groupId),
    index("idx_group_members_user_id").on(table.userId),
    unique("group_members_group_user_unique").on(table.groupId, table.userId),
  ],
);

export const groupInvites = sqliteTable(
  "group_invites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    token: text("token").unique().notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetLoginId: text("target_login_id"),
    expiresAt: text("expires_at"),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_group_invites_group_id").on(table.groupId),
    index("idx_group_invites_target_user_id").on(table.targetUserId),
  ],
);

export const groupJoinRequests = sqliteTable(
  "group_join_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_group_join_requests_group_id").on(table.groupId),
    index("idx_group_join_requests_user_id").on(table.userId),
    unique("group_join_requests_group_user_unique").on(table.groupId, table.userId),
  ],
);

export const groupPermissions = sqliteTable(
  "group_permissions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    effect: text("effect").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_group_permissions_group_id").on(table.groupId),
    unique("group_permissions_group_permission_unique").on(table.groupId, table.permissionKey),
  ],
);

export const userPermissionOverrides = sqliteTable(
  "user_permission_overrides",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    effect: text("effect").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
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

export const channelMembers = sqliteTable(
  "channel_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    lastX: integer("last_x"),
    lastY: integer("last_y"),
    joinedAt: text("joined_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_channel_members_channel_id").on(table.channelId),
    index("idx_channel_members_user_id").on(table.userId),
    unique("channel_members_channel_user_unique").on(table.channelId, table.userId),
  ],
);

export const npcs = sqliteTable(
  "npcs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name"),
    positionX: integer("position_x"),
    positionY: integer("position_y"),
    direction: text("direction").default("down"),
    appearance: text("appearance"),
    adapterType: text("adapter_type").notNull().default("hermes"),
    adapterConfig: text("adapter_config"),
    hermesProfileId: text("hermes_profile_id")
      .notNull()
      .references(() => hermesProfiles.id, { onDelete: "cascade" }),
    agentConfig: text("agent_config"),
    /** Whether it's clocked in for this channel. If false, the seat is remembered but it's off the map. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_npcs_channel_id").on(table.channelId),
    unique("npcs_channel_position_unique").on(table.channelId, table.positionX, table.positionY),
    uniqueIndex("npcs_channel_profile_idx").on(table.channelId, table.hermesProfileId),
  ],
);

export const npcSessions = sqliteTable(
  "npc_sessions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    npcId: text("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    adapterType: text("adapter_type").notNull(),
    sessionType: text("session_type").notNull(),
    sessionRef: text("session_ref").notNull(),
    contextKey: text("context_key").notNull(),
    lastSummary: text("last_summary"),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
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

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id),
    npcId: text("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_chat_messages_lookup").on(table.characterId, table.npcId, table.createdAt),
  ],
);

export const chatRooms = sqliteTable(
  "chat_rooms",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    replyPolicy: text("reply_policy").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
    lastMessageAt: text("last_message_at"),
  },
  (t) => [
    index("idx_chat_rooms_channel").on(t.channelId, t.lastMessageAt),
    uniqueIndex("uq_chat_rooms_office_per_channel")
      .on(t.channelId)
      .where(sql`kind = 'office'`),
  ],
);

export const chatRoomMembers = sqliteTable(
  "chat_room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    memberKind: text("member_kind").notNull(),
    memberId: text("member_id").notNull(),
    invitedBy: text("invited_by").references(() => users.id),
    joinedAt: text("joined_at").$defaultFn(() => new Date().toISOString()),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.memberKind, t.memberId] })],
);

export const chatRoomMessages = sqliteTable(
  "chat_room_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: text("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    senderKind: text("sender_kind").notNull(),
    senderId: text("sender_id"),
    senderName: text("sender_name").notNull(),
    content: text("content").notNull(),
    // Structured payload for a system message (JSON string). A notice such as a kanban card move
    // or a cron result puts data here for card rendering, separate from the body (content).
    // NULL for ordinary messages.
    noticeJson: text("notice_json"),
    createdAt: text("created_at").$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_chat_room_messages_room").on(t.roomId, t.createdAt)],
);

export const meetingMinutes = sqliteTable(
  "meeting_minutes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    transcript: text("transcript").notNull(),
    participants: text("participants").notNull().default("[]"),
    totalTurns: integer("total_turns").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    initiatorId: text("initiator_id").references(() => users.id, { onDelete: "set null" }),
    keyTopics: text("key_topics").notNull().default("[]"),
    conclusions: text("conclusions"),
    // Structured meeting outcome (decisions, follow-ups, project recommendations). A draft, not a card copy.
    outcomeJson: text("outcome_json"),
    summaryStatus: text("summary_status").notNull().default("ok"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
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

export const channelProjects = sqliteTable(
  "channel_projects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    boardLinkId: text("board_link_id")
      .notNull()
      .unique()
      .references(() => channelKanbanBoards.id, { onDelete: "cascade" }),
    // Denormalized to allow per-channel listing queries without a join. Always matches the linked row's channel.
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("planned"),
    leadNpcId: text("lead_npc_id").references(() => npcs.id, { onDelete: "set null" }),
    targetDate: text("target_date"),
    color: text("color"),
    icon: text("icon"),
    // A pause is not a status — it's in_progress with this field filled in (same treatment as Paperclip).
    pauseReason: text("pause_reason"),
    originMeetingId: text("origin_meeting_id").references(() => meetingMinutes.id, {
      onDelete: "set null",
    }),
    /** Decision C-1 — reserves the slot only. This design neither reads nor writes it. */
    hermesProjectId: text("hermes_project_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [index("idx_channel_projects_channel").on(table.channelId)],
);

export const channelSubprojects = sqliteTable(
  "channel_subprojects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => channelProjects.id, { onDelete: "cascade" }),
    /**
     * The value that goes straight into Hermes `tasks.tenant`. **Never change it after creation**
     * — the dispatcher passes `HERMES_TENANT` to the worker and child cards inherit it, so
     * changing the value orphans cards that already exist. To change the display name, change
     * only `name`.
     */
    tenantSlug: text("tenant_slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("planned"),
    leadNpcId: text("lead_npc_id").references(() => npcs.id, { onDelete: "set null" }),
    targetDate: text("target_date"),
    color: text("color"),
    icon: text("icon"),
    pauseReason: text("pause_reason"),
    originMeetingId: text("origin_meeting_id").references(() => meetingMinutes.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
    updatedAt: text("updated_at")
      .$defaultFn(() => new Date().toISOString())
      .notNull(),
  },
  (table) => [
    uniqueIndex("channel_subprojects_project_tenant_idx").on(table.projectId, table.tenantSlug),
  ],
);

/**
 * Records for the pre-execution approval gate. Must have the same column set as approvals/approvalTargets
 * on the PG side. Timestamps are ISO strings per SQLite convention.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull(),
    requestedBy: text("requested_by").notNull(),
    title: text("title").notNull(),
    sourceJson: text("source_json").notNull(),
    payloadJson: text("payload_json"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: text("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("approvals_channel_status_idx").on(t.channelId, t.status)],
);

export const approvalTargets = sqliteTable(
  "approval_targets",
  {
    approvalId: text("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    decision: text("decision"),
  },
  (t) => [
    primaryKey({ columns: [t.approvalId, t.taskId] }),
    index("approval_targets_task_idx").on(t.taskId),
  ],
);

// Per-tab read state for the staff panel. Must have the same column set as npcPanelReads on the PG side.
export const npcPanelReads = sqliteTable(
  "npc_panel_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    npcId: text("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    tab: text("tab").notNull(), // "cron" | "cards"
    seenAt: text("seen_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // For the cards tab. KanbanTask has no updated_at, so a time watermark can't be used.
    seenIds: text("seen_ids"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.npcId, t.tab] })],
);
