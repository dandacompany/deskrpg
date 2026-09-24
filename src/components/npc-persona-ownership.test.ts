import test from "node:test";
import assert from "node:assert/strict";

import { isPersonaOwnedByProfile } from "./npc-persona-ownership";

test("the persona of a hermes NPC is owned by the profile", () => {
  // DeskRPG can't own the persona since SOUL.md can't be turned off over HTTP.
  assert.equal(isPersonaOwnedByProfile({ adapterType: "hermes" }), true);
});

test("picking an existing agent in the gateway means the profile owns it, regardless of adapter", () => {
  assert.equal(
    isPersonaOwnedByProfile({ adapterType: "claude", existingAgentSelected: true }),
    true,
  );
});

test("DeskRPG owns the persona for a CLI adapter", () => {
  // CLI adapters like claude/codex have no notion of a profile SOUL.md — open the edit field.
  for (const t of ["claude", "codex", "gemini", "opencode"]) {
    assert.equal(isPersonaOwnedByProfile({ adapterType: t }), false, t);
  }
});

test("an empty adapter does not block editing", () => {
  assert.equal(isPersonaOwnedByProfile({ adapterType: null }), false);
  assert.equal(isPersonaOwnedByProfile({ adapterType: undefined }), false);
});
