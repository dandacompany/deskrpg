import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyLoad,
  groupSkills,
  initialSelection,
  toggle,
  toggleSkill,
  toggleToolset,
} from "./picker-model";

const ts = (name: string, enabled: boolean) => ({
  name,
  label: name,
  description: "",
  enabled,
  configured: true,
});
const sk = (name: string, category: string, disabled = false, essential = false) => ({
  name,
  category,
  description: `${name} 설명`,
  disabled,
  essential,
});

describe("picker-model", () => {
  it("the initial selection is the server's current state", () => {
    assert.deepEqual(
      initialSelection(
        [ts("web", true), ts("file", false), ts("tts", true)],
        [sk("pdf", "docs", true), sk("xlsx", "docs")],
      ),
      { enabledToolsets: ["tts", "web"], disabledSkills: ["pdf"] },
    );
  });
  it("toggle returns a new, sorted, deduplicated array", () => {
    const base = ["web"];
    assert.deepEqual(toggle(base, "file", true), ["file", "web"]);
    assert.deepEqual(toggle(base, "web", true), ["web"]);
    assert.deepEqual(toggle(base, "web", false), []);
    assert.deepEqual(base, ["web"]);
  });
  it("skills are grouped by category and filtered by name/description", () => {
    const skills = [
      sk("pdf", "docs"),
      sk("xlsx", "docs"),
      sk("hermes-agent", "core"),
      sk("misc", ""),
    ];
    assert.deepEqual(
      groupSkills(skills, "").map((g) => [g.category, g.skills.length]),
      [
        ["", 1],
        ["core", 1],
        ["docs", 2],
      ],
    );
    assert.deepEqual(
      groupSkills(skills, "PDF").map((g) => g.skills.map((s) => s.name)),
      [["pdf"]],
    );
    assert.deepEqual(
      groupSkills(skills, "xlsx 설").map((g) => g.skills.map((s) => s.name)),
      [["xlsx"]],
    );
  });
  it("is unsupported if either one needs an upgrade", () => {
    assert.equal(
      classifyLoad([{ errorCode: "plugin_upgrade_required" }, { skills: [] }]),
      "unsupported",
    );
    assert.equal(classifyLoad([{ errorCode: "config_unreadable" }, { skills: [] }]), "error");
    assert.equal(classifyLoad([{ toolsets: [] }, { skills: [] }]), "ok");
  });
  it("changing a toolset never carries a name outside the loaded list (MCP or unknown names)", () => {
    const rows = [ts("web", true), ts("tts", false)];
    assert.deepEqual(toggleToolset(["web", "my-mcp", "ghost"], "tts", true, rows), ["tts", "web"]);
    assert.deepEqual(toggleToolset(["web", "my-mcp"], "web", false, rows), []);
  });
  it("changing a skill never carries an essential or unknown name into the disabled list", () => {
    const rows = [sk("hermes-agent", "core", false, true), sk("pdf", "docs"), sk("xlsx", "docs")];
    assert.deepEqual(toggleSkill(["hermes-agent", "ghost", "xlsx"], "pdf", false, rows), [
      "pdf",
      "xlsx",
    ]);
    assert.deepEqual(toggleSkill(["hermes-agent", "ghost", "xlsx"], "xlsx", true, rows), []);
  });
});
