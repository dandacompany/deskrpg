ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_at" timestamp with time zone;
ALTER TABLE "gateway_resources" ADD COLUMN IF NOT EXISTS "local_discovery_opted_in_by" uuid;
-- uuid 다. users.id 가 uuid 이므로 text 로 만들면 아래 FK 가
-- "incompatible types: text and uuid" 로 실패하고, 마이그레이션 트랜잭션이
-- 통째로 롤백돼 컨테이너가 기동 루프에 빠진다.
DO $$ BEGIN
  ALTER TABLE "gateway_resources"
    ADD CONSTRAINT "gateway_resources_local_discovery_opted_in_by_users_id_fk"
    FOREIGN KEY ("local_discovery_opted_in_by") REFERENCES "users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
