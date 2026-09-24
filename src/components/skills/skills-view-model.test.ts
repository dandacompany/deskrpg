import test from "node:test";
import assert from "node:assert/strict";

import type { SkillRow } from "@/lib/hermes/plugin-client-types";
import {
  groupSkills,
  isValidSkillName,
  skillTemplate,
  unusedSkillNames,
} from "./skills-view-model";

const r = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({
  name,
  category: "",
  description: `${name} 설명`,
  disabled: false,
  essential: false,
  source: "local",
  useCount: 0,
  viewCount: 0,
  ...over,
});

test("groups by source, puts external in the bundled group, drops empty groups", () => {
  const groups = groupSkills(
    [r("a"), r("b", { source: "hub" }), r("c", { source: "external" })],
    "",
  );
  assert.deepEqual(
    groups.map((g) => [g.key, g.rows.map((x) => x.name)]),
    [
      ["local", ["a"]],
      ["hub", ["b"]],
      ["bundled", ["c"]],
    ],
  );
});

test("search matches name and description, case-insensitive", () => {
  const groups = groupSkills(
    [r("Weekly"), r("pdf", { description: "문서 WEEKLY 요약" }), r("x")],
    "weekly",
  );
  assert.deepEqual(
    groups.flatMap((g) => g.rows.map((x) => x.name)),
    ["Weekly", "pdf"],
  );
});

test("an old plugin row with no source is treated as local", () => {
  const groups = groupSkills(
    [{ name: "a", category: "", description: "", disabled: false, essential: false }],
    "",
  );
  assert.equal(groups[0].key, "local");
});

test("unused means 0 uses/views, enabled, and not essential or pinned", () => {
  const names = unusedSkillNames([
    r("a"),
    r("b", { useCount: 1 }),
    r("c", { disabled: true }),
    r("d", { essential: true }),
    r("e", { pinned: true }),
    r("f", { viewCount: 2 }),
  ]);
  assert.deepEqual(names, ["a"]);
});

test("name rules and the SKILL.md template", () => {
  assert.equal(isValidSkillName("invoice-check"), true);
  assert.equal(isValidSkillName("Invoice"), false);
  assert.equal(isValidSkillName("a/b"), false);
  assert.equal(
    skillTemplate("invoice-check", "청구서 확인"),
    "---\nname: invoice-check\ndescription: 청구서 확인\n---\n\n# invoice-check\n\n## 언제 쓰나\n\n## 절차\n\n1. \n\n## 확인\n",
  );
});
