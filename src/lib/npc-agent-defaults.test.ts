import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGatewayAgentFiles,
  buildPersonaConfig,
  getDefaultAgentIdForPreset,
  getNpcPresetDefaults,
} from "./npc-agent-defaults";

test("getDefaultAgentIdForPreset returns stable office preset id", () => {
  assert.equal(getDefaultAgentIdForPreset("dev-a"), "dev-a");
});

test("getNpcPresetDefaults applies NPC name to preset identity and soul", () => {
  const defaults = getNpcPresetDefaults("dev-a", "Alice");

  assert.equal(defaults.defaultAgentId, "dev-a");
  assert.match(defaults.identity, /Alice/);
  assert.match(defaults.soul, /Alice/);
});

test("getNpcPresetDefaults injects locale-specific language policy into preset docs", () => {
  const defaults = getNpcPresetDefaults({
    presetId: "dev-a",
    npcName: "Alice",
    locale: "ja",
  });

  assert.match(defaults.identity, /日本語/);
  assert.match(defaults.soul, /日本語/);
  assert.match(defaults.meetingProtocol, /日本語/);
});

test("buildPersonaConfig prefers explicit overrides over preset defaults", () => {
  const config = buildPersonaConfig({
    presetId: "dev-a",
    npcName: "Alice",
    identityOverride: "Custom identity for Alice",
    soulOverride: "Custom soul for Alice",
  });

  assert.match(config.identity, /Custom identity for Alice/);
  assert.match(config.soul, /Custom soul for Alice/);
});

test("buildGatewayAgentFiles returns IDENTITY, SOUL, and AGENTS payloads", () => {
  const files = buildGatewayAgentFiles({
    presetId: "dev-a",
    npcName: "Alice",
  });

  assert.deepEqual(
    files.map((file) => file.name),
    ["IDENTITY.md", "SOUL.md", "AGENTS.md"],
  );
  assert.match(files[0].content, /Task Management Protocol/);
  assert.match(files[0].content, /Alice/);
  assert.match(files[2].content, /AGENTS\.md - Your Workspace/);
});

test("buildPersonaConfig injects language policy into custom overrides", () => {
  const config = buildPersonaConfig({
    presetId: "dev-a",
    npcName: "Alice",
    locale: "en",
    identityOverride: "Custom identity for Alice",
    soulOverride: "Custom soul for Alice",
  });

  assert.match(config.identity, /Language Policy/);
  assert.match(config.identity, /English/);
  assert.match(config.soul, /English/);
});
