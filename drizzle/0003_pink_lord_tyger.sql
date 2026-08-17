CREATE TABLE "hermes_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway_id" uuid NOT NULL,
	"profile_name" varchar(120) NOT NULL,
	"token_encrypted" text NOT NULL,
	"display_name" varchar(120),
	"description" text,
	"provisioned_by_deskrpg" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_validation_status" varchar(40),
	"last_validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "npcs" ADD COLUMN "hermes_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "npcs" ADD COLUMN "agent_config" jsonb;--> statement-breakpoint
ALTER TABLE "hermes_profiles" ADD CONSTRAINT "hermes_profiles_gateway_id_gateway_resources_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateway_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hermes_profiles_gateway_id" ON "hermes_profiles" USING btree ("gateway_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_profiles_gateway_name_idx" ON "hermes_profiles" USING btree ("gateway_id","profile_name");--> statement-breakpoint
ALTER TABLE "npcs" ADD CONSTRAINT "npcs_hermes_profile_id_hermes_profiles_id_fk" FOREIGN KEY ("hermes_profile_id") REFERENCES "public"."hermes_profiles"("id") ON DELETE set null ON UPDATE no action;