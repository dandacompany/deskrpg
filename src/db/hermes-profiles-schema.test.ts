import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";

import { hermesProfiles, npcs } from "./schema";

test("hermes_profiles has the profile triple and validation columns", () => {
  const cols = getTableColumns(hermesProfiles);
  for (const name of [
    "id",
    "gatewayId",
    "profileName",
    "tokenEncrypted",
    "displayName",
    "description",
    "provisionedByDeskrpg",
    "lastValidatedAt",
    "lastValidationStatus",
    "lastValidationError",
    "createdAt",
    "updatedAt",
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

test("npcs lives on agent_config, and openclaw_config no longer remains", () => {
  // P1 kept openclaw_config around for rollback, but that column was OpenClaw in name
  // only — it was actually the persona store. The retirement migration moved its
  // contents to agent_config and dropped the column — if both columns coexisted,
  // there'd be no way to tell which one is the source of truth.
  const cols = getTableColumns(npcs);
  assert.ok("hermesProfileId" in cols);
  assert.ok("agentConfig" in cols);
  assert.ok(
    !("openclawConfig" in cols),
    "openclaw_config 가 스키마에 남아 있습니다 — 페르소나의 정본은 agent_config 하나여야 합니다.",
  );
});

test("a new NPC's default engine is hermes", () => {
  // The old default was 'openclaw'. An NPC created without an adapterType was saved
  // pointing at a nonexistent backend, and the user only found out once they tried to chat.
  const cols = getTableColumns(npcs);
  assert.equal((cols.adapterType as { default?: unknown }).default, "hermes");
});
