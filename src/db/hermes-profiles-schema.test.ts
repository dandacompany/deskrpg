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

test("npcs gains hermes_profile_id and agent_config while keeping openclaw_config", () => {
  const cols = getTableColumns(npcs);
  assert.ok("hermesProfileId" in cols);
  assert.ok("agentConfig" in cols);
  assert.ok("openclawConfig" in cols, "openclaw_config must survive P1 for rollback");
});
