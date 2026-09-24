import test from "node:test";
import assert from "node:assert/strict";

import { shouldReplacePresetText } from "./npc-preset-apply-decision";

const untouched = { identity: false, soul: false };

// --- Appearance preset: it's an implicit action, so keep the persona the user wrote ---

test("an appearance preset does not overwrite an edited identity", () => {
  assert.equal(shouldReplacePresetText("appearance", { identity: true, soul: false }), false);
});

test("an appearance preset protects soul too even if only identity was edited", () => {
  // A common case where only identity was touched. Swapping in the preset for soul would
  // produce a mixed persona — user's identity, preset's soul — making the displayed preset name a lie.
  assert.equal(shouldReplacePresetText("appearance", { identity: true, soul: false }), false);
});

test("an appearance preset protects identity too even if only soul was edited", () => {
  assert.equal(shouldReplacePresetText("appearance", { identity: false, soul: true }), false);
});

test("an appearance preset fills the persona if nothing was touched", () => {
  assert.equal(shouldReplacePresetText("appearance", untouched), true);
});

// --- Persona select: replacement is the request itself ---

test("picking a persona directly replaces edited text too", () => {
  assert.equal(shouldReplacePresetText("persona", { identity: true, soul: true }), true);
});

test("picking a persona directly fills empty text too", () => {
  assert.equal(shouldReplacePresetText("persona", untouched), true);
});
