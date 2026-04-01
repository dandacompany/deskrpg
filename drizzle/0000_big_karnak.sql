CREATE TABLE "channel_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"last_x" integer,
	"last_y" integer,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "channel_members_channel_user_unique" UNIQUE("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(500),
	"owner_id" uuid NOT NULL,
	"group_id" uuid,
	"map_data" jsonb,
	"map_config" jsonb,
	"is_public" boolean DEFAULT true,
	"invite_code" varchar(20),
	"max_players" integer DEFAULT 50,
	"password" varchar(255),
	"gateway_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "channels_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(50) NOT NULL,
	"appearance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"role" varchar(10) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "group_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"token" varchar(64) NOT NULL,
	"created_by" uuid NOT NULL,
	"target_user_id" uuid,
	"target_login_id" varchar(50),
	"expires_at" timestamp with time zone,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "group_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "group_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"message" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "group_join_requests_group_user_unique" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "group_members_group_user_unique" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"permission_key" varchar(50) NOT NULL,
	"effect" varchar(10) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "group_permissions_group_permission_unique" UNIQUE("group_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" varchar(500),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "map_portals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_map_id" varchar(100),
	"to_map_id" varchar(100),
	"from_x" integer NOT NULL,
	"from_y" integer NOT NULL,
	"to_x" integer NOT NULL,
	"to_y" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"icon" varchar(10) DEFAULT '🗺️' NOT NULL,
	"description" varchar(500),
	"cols" integer NOT NULL,
	"rows" integer NOT NULL,
	"layers" jsonb,
	"objects" jsonb,
	"tiled_json" jsonb,
	"thumbnail" text,
	"spawn_col" integer NOT NULL,
	"spawn_row" integer NOT NULL,
	"tags" varchar(500),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"tilemap_path" varchar(500) NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "meeting_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"transcript" text NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_turns" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"initiator_id" uuid,
	"key_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conclusions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "npc_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "npcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"position_x" integer NOT NULL,
	"position_y" integer NOT NULL,
	"direction" varchar(10) DEFAULT 'down',
	"appearance" jsonb NOT NULL,
	"openclaw_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "npcs_channel_position_unique" UNIQUE("channel_id","position_x","position_y")
);
--> statement-breakpoint
CREATE TABLE "project_stamps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stamp_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_stamp" UNIQUE("project_id","stamp_id")
);
--> statement-breakpoint
CREATE TABLE "project_tilesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"tileset_id" uuid NOT NULL,
	"firstgid" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_project_tileset" UNIQUE("project_id","tileset_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"thumbnail" text,
	"tiled_json" jsonb,
	"settings" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stamps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"cols" integer NOT NULL,
	"rows" integer NOT NULL,
	"tile_width" integer DEFAULT 32 NOT NULL,
	"tile_height" integer DEFAULT 32 NOT NULL,
	"layers" jsonb NOT NULL,
	"tilesets" jsonb NOT NULL,
	"thumbnail" text,
	"created_by" uuid,
	"built_in" boolean DEFAULT false NOT NULL,
	"tags" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"assigner_id" uuid NOT NULL,
	"npc_task_id" varchar(64) NOT NULL,
	"title" varchar(200) NOT NULL,
	"summary" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"auto_nudge_count" integer DEFAULT 0 NOT NULL,
	"auto_nudge_max" integer DEFAULT 5 NOT NULL,
	"last_nudged_at" timestamp with time zone,
	"last_reported_at" timestamp with time zone,
	"stalled_at" timestamp with time zone,
	"stalled_reason" varchar(50),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tileset_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"tilewidth" integer DEFAULT 32 NOT NULL,
	"tileheight" integer DEFAULT 32 NOT NULL,
	"columns" integer NOT NULL,
	"tilecount" integer NOT NULL,
	"image" text NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"tags" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission_key" varchar(50) NOT NULL,
	"effect" varchar(10) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_permission_overrides_group_user_permission_unique" UNIQUE("group_id","user_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_id" varchar(50) NOT NULL,
	"nickname" varchar(50) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"system_role" varchar(20) DEFAULT 'user' NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_login_id_unique" UNIQUE("login_id"),
	CONSTRAINT "users_nickname_unique" UNIQUE("nickname")
);
--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_npc_id_npcs_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_requests" ADD CONSTRAINT "group_join_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_permissions" ADD CONSTRAINT "group_permissions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_portals" ADD CONSTRAINT "map_portals_from_map_id_maps_id_fk" FOREIGN KEY ("from_map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_portals" ADD CONSTRAINT "map_portals_to_map_id_maps_id_fk" FOREIGN KEY ("to_map_id") REFERENCES "public"."maps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_templates" ADD CONSTRAINT "map_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_reports" ADD CONSTRAINT "npc_reports_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_reports" ADD CONSTRAINT "npc_reports_npc_id_npcs_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_reports" ADD CONSTRAINT "npc_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_reports" ADD CONSTRAINT "npc_reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npcs" ADD CONSTRAINT "npcs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stamps" ADD CONSTRAINT "project_stamps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stamps" ADD CONSTRAINT "project_stamps_stamp_id_stamps_id_fk" FOREIGN KEY ("stamp_id") REFERENCES "public"."stamps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tilesets" ADD CONSTRAINT "project_tilesets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tilesets" ADD CONSTRAINT "project_tilesets_tileset_id_tileset_images_id_fk" FOREIGN KEY ("tileset_id") REFERENCES "public"."tileset_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamps" ADD CONSTRAINT "stamps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_npc_id_npcs_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigner_id_characters_id_fk" FOREIGN KEY ("assigner_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_members_channel_id" ON "channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_channel_members_user_id" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_characters_user_id" ON "characters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_lookup" ON "chat_messages" USING btree ("character_id","npc_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_group_invites_group_id" ON "group_invites" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_group_invites_target_user_id" ON "group_invites" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "idx_group_join_requests_group_id" ON "group_join_requests" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_group_join_requests_user_id" ON "group_join_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_group_members_group_id" ON "group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_group_members_user_id" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_group_permissions_group_id" ON "group_permissions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_minutes_channel" ON "meeting_minutes" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_minutes_created" ON "meeting_minutes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_npcs_channel_id" ON "npcs" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_channel" ON "tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_npc" ON "tasks" USING btree ("npc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_npc_task_id" ON "tasks" USING btree ("npc_id","npc_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tileset_images_name" ON "tileset_images" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_user_permission_overrides_group_id" ON "user_permission_overrides" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_user_permission_overrides_user_id" ON "user_permission_overrides" USING btree ("user_id");