-- How far each user has read each conversation (room · 1:1 DM) and which reports they acknowledged.
-- Add-only. The FK stays inside CREATE instead of a separate ALTER — PostgreSQL has no
-- `ADD CONSTRAINT IF NOT EXISTS`, so a rerun would break.
CREATE TABLE IF NOT EXISTS "conversation_reads" (
	"user_id" uuid NOT NULL,
	"kind" varchar(8) NOT NULL,
	"target_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"seen_ids" text,
	CONSTRAINT "conversation_reads_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id"),
	CONSTRAINT "conversation_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
