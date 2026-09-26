import test from "node:test";
import assert from "node:assert/strict";

import { allActivityKeys, describeActivity } from "./npc-activity";

test("the actual function name that arrives is converted to human-readable text", () => {
  // Measured (2026-08-28): what arrives in the event is the individual function name
  // (`web_search`), not the toolset name (`web`). It was originally written against toolset names and every one missed.
  assert.deepEqual(describeActivity("web_search"), { key: "npc.activity.searching" });
  assert.deepEqual(describeActivity("read_file"), { key: "npc.activity.readingFile" });
  assert.deepEqual(describeActivity("terminal"), { key: "npc.activity.runningCommand" });
  assert.deepEqual(describeActivity("skill_view"), { key: "npc.activity.organizing" });
});

test("the more specific prefix wins", () => {
  // browser_vision is more specific than browser_ — it's looking at the screen, not browsing.
  assert.deepEqual(describeActivity("browser_navigate"), { key: "npc.activity.browsing" });
  assert.deepEqual(describeActivity("browser_vision"), { key: "npc.activity.lookingAtImage" });
});

test("_thinking shows as thinking", () => {
  // This is the exact tool that made the answer appear twice. Only the name is used, not the body.
  assert.deepEqual(describeActivity("_thinking"), { key: "npc.activity.thinking" });
});

test("an unknown tool's internal name is never exposed", () => {
  const notice = describeActivity("some_internal_tool_v2");
  assert.deepEqual(notice, { key: "npc.activity.working" });
  assert.ok(!JSON.stringify(notice).includes("some_internal_tool_v2"));
});

test("nothing is shown when there's no name", () => {
  assert.equal(describeActivity(""), null);
  assert.equal(describeActivity("   "), null);
});

test("the display key list has no duplicates", () => {
  const keys = allActivityKeys();
  assert.equal(keys.length, new Set(keys).size);
});

test("every display key is in the npc.activity namespace", () => {
  for (const k of allActivityKeys()) assert.ok(k.startsWith("npc.activity."), k);
});

// --- Locale guard: prevents a key with no translated text from leaking onto the screen as its raw key name ---

import { readFileSync } from "node:fs";

const LOCALES = ["en", "ko", "ja", "zh"];

test("every activity key has text in all four locales", () => {
  const missing: string[] = [];
  for (const loc of LOCALES) {
    const src = readFileSync(`src/lib/i18n/locales/${loc}.ts`, "utf8");
    for (const key of allActivityKeys()) {
      if (!src.includes(`"${key}"`)) missing.push(`${loc}:${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("a question for the user reads as asking you, not a teammate", () => {
  for (const tool of ["clarify", "deskrpg_ask_user"])
    assert.deepEqual(describeActivity(tool), { key: "npc.activity.askingYou" }, tool);
  assert.deepEqual(describeActivity("delegate_task"), { key: "npc.activity.askingAround" });
  assert.deepEqual(describeActivity("a2a_send"), { key: "npc.activity.askingAround" });
});
