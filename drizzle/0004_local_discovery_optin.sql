ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_at" timestamp;
ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_by" text;
DO $$ BEGIN
  ALTER TABLE "gateway_resources"
    ADD CONSTRAINT "gateway_resources_local_discovery_opted_in_by_users_id_fk"
    FOREIGN KEY ("local_discovery_opted_in_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
