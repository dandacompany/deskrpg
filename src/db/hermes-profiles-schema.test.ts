import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";

import { hermesProfiles, npcs } from "./schema";

test("hermes_profiles has the profile triple and validation columns", () => {
  const cols = getTableColumns(hermesProfiles);
  for (const name of [
    "id", "gatewayId", "profileName", "tokenEncrypted", "displayName",
    "description", "provisionedByDeskrpg",
    "lastValidatedAt", "lastValidationStatus", "lastValidationError",
    "createdAt", "updatedAt",
  ]) {
    assert.ok(name in cols, `missing column: ${name}`);
  }
});

test("hermes_profiles enforces one profile name per gateway", () => {
  const config = getTableConfig(hermesProfiles);
  const unique = config.uniqueConstraints.concat(
    config.indexes.filter((i) => i.config.unique) as never[],
  );
  assert.ok(unique.length > 0, "expected a unique constraint on (gateway_id, profile_name)");
});

test("npcs 는 agent_config 로 살고 openclaw_config 는 남아 있지 않다", () => {
  // P1 에서는 롤백을 위해 openclaw_config 를 남겨 뒀지만, 그 열은 이름만 OpenClaw 였고
  // 실제로는 페르소나 저장소였다. 은퇴 마이그레이션이 내용을 agent_config 로 옮기고
  // 열을 없앴다 — 두 열이 공존하면 어느 쪽이 정본인지 알 수 없어진다.
  const cols = getTableColumns(npcs);
  assert.ok("hermesProfileId" in cols);
  assert.ok("agentConfig" in cols);
  assert.ok(
    !("openclawConfig" in cols),
    "openclaw_config 가 스키마에 남아 있습니다 — 페르소나의 정본은 agent_config 하나여야 합니다.",
  );
});

test("새 NPC 의 기본 엔진은 hermes 다", () => {
  // 예전 기본값은 'openclaw' 였다. adapterType 을 넣지 않고 만든 NPC 가 존재하지 않는
  // 백엔드로 저장돼, 사용자는 대화를 걸어야 비로소 그 사실을 알았다.
  const cols = getTableColumns(npcs);
  assert.equal((cols.adapterType as { default?: unknown }).default, "hermes");
});
