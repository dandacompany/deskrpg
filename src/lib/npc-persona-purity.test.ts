import test from "node:test";
import assert from "node:assert/strict";

import { buildPersonaConfig } from "./npc-agent-defaults";

// The stored persona never mixes in task procedure text.
//
// It used to: `injectTaskPrompt()` saved the procedure by **prepending** it to the persona
// string. Measured (2026-08-30, staging Sophie): of a stored persona's 2,496 characters,
// 1,704 (68%) were injected procedure. Editing the persona could delete the procedure along
// with it, and a profile that already had a persona had no way to add just the procedure.
//
// The task system was retired in 2026-09, but this contract stays — procedure such as
// meeting rules goes to the system-instruction layer (npc-prompt-layers), and the stored
// persona holds only what the user wrote.

test("the stored persona never mixes in task procedure text", () => {
  const cfg = buildPersonaConfig({
    presetId: "dev-a",
    npcName: "앨리스",
    locale: "ko",
    identityOverride: "나는 앨리스다.",
  });
  assert.equal(cfg.identity.includes("Task Management Protocol"), false);
});

test("preset default personas don't mix it in either", () => {
  const cfg = buildPersonaConfig({ presetId: "dev-a", npcName: "앨리스", locale: "ko" });
  assert.equal(cfg.identity.includes("Task Management Protocol"), false);
});

test("the user-written persona is present untouched", () => {
  // `localizeNpcPromptDocument` prepends a "## Language Policy" block — that's document
  // localization, not task procedure. What's pinned here is that **the user-written body
  // is not truncated or altered**.
  const written = "나는 앨리스다.\n\n## 원칙\n- 짧게 말한다";
  const cfg = buildPersonaConfig({
    presetId: "dev-a",
    npcName: "앨리스",
    locale: "ko",
    identityOverride: written,
  });
  assert.ok(cfg.identity.includes(written), "사용자 본문이 그대로 들어 있어야 한다");
  assert.equal(cfg.identity.includes("Task Management Protocol"), false);
});
