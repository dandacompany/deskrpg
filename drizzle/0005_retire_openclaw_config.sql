-- OpenClaw 은퇴 — 스키마 정리
--
-- 배경: `openclaw_config` 는 이름만 OpenClaw 다. 실제로 담고 있는 것은 NPC 의 페르소나
-- (identity/soul/personaConfig), locale, meetingProtocol, passPolicy — 즉 백엔드와 무관한
-- NPC 설정 전반이다. NOT NULL 이고 모든 NPC 가 이 열로 살아 있다.
--
-- 한편 `agent_config` 는 P1 에서 만들어졌지만 아무도 읽지도 쓰지도 않는 빈 열이었다.
-- 실데이터가 잘못된 이름의 열에 들어 있고, 올바른 이름의 열은 비어 있는 상태.
--
-- 이 마이그레이션은 그 둘을 바로잡는다. 순서가 중요하다 — 지우기 전에 옮기고,
-- 되돌릴 수 없는 삭제 전에 백업한다.

-- 1) 페르소나를 올바른 이름의 열로 옮긴다.
--    agent_config 가 이미 채워진 행은 건드리지 않는다(재실행 안전).
UPDATE "npcs"
SET "agent_config" = "openclaw_config"
WHERE "agent_config" IS NULL;

-- 2) 레거시 OpenClaw NPC 는 지운다. OpenClaw 런타임이 사라져 이 NPC 들은 어떤 백엔드로도
--    대화할 수 없다. 다만 되돌릴 수 없는 삭제이므로 행 전체를 백업 테이블에 남긴다 —
--    사용자가 페르소나를 되살려 Hermes 프로필에 다시 묶을 수 있어야 한다.
CREATE TABLE IF NOT EXISTS "npcs_openclaw_backup" AS
SELECT * FROM "npcs" WHERE "adapter_type" = 'openclaw';

DELETE FROM "npcs" WHERE "adapter_type" = 'openclaw';

-- 3) 새 NPC 의 기본 엔진은 Hermes 다. 예전 기본값이 'openclaw' 여서, adapterType 을
--    넣지 않고 만든 NPC 는 존재하지 않는 백엔드로 저장됐다.
ALTER TABLE "npcs" ALTER COLUMN "adapter_type" SET DEFAULT 'hermes';

-- 4) 이제 이름과 내용이 어긋난 열을 없앤다.
ALTER TABLE "npcs" DROP COLUMN IF EXISTS "openclaw_config";
