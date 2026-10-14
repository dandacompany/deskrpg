CREATE TABLE "education_workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" varchar(40) NOT NULL,
	"actor" varchar(120) NOT NULL,
	"source" varchar(16) NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"request_text" text NOT NULL,
	"stage" varchar(40) DEFAULT 'topic_recommendation' NOT NULL,
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"state_json" text DEFAULT '{}' NOT NULL,
	"source" varchar(16) NOT NULL,
	"external_session_id" varchar(255),
	"idempotency_key" varchar(128) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "education_workflows_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "education_workflow_events" ADD CONSTRAINT "education_workflow_events_workflow_id_education_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."education_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_workflows" ADD CONSTRAINT "education_workflows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "education_workflow_events_workflow_version_idx" ON "education_workflow_events" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "education_workflows_updated_idx" ON "education_workflows" USING btree ("updated_at");