import assert from "node:assert/strict";
import test from "node:test";

import type { MeetingOutcome } from "./meeting-outcome";
import { createOutcomeDraft, draftToRegistration, updateDraftItem } from "./meeting-outcome-draft";
import { isTenantSlug, tenantSlugFromName } from "./tenant-slug";

const followUp = (title: string, after: number[] = [], assigneeNpcId: string | null = null) => ({
  title,
  summary: null,
  acceptance: null,
  assigneeNpcId,
  assigneeName: null,
  after,
});

const outcome: MeetingOutcome = {
  decisions: [],
  followUps: [followUp("조사", [], "npc-1"), followUp("초안", [0]), followUp("검토", [1])],
  project: { recommended: true, name: "가격 개편", reason: null },
};

test("the draft starts with all items selected and suggests a subproject from the project name", () => {
  const draft = createOutcomeDraft(outcome);
  assert.deepEqual(
    draft.items.map((item) => [item.index, item.selected, item.title, item.npcId]),
    [
      [0, true, "조사", "npc-1"],
      [1, true, "초안", null],
      [2, true, "검토", null],
    ],
  );
  assert.equal(draft.subprojectName, "가격 개편");
});

test("with no recommendation, the subproject name is empty", () => {
  assert.equal(createOutcomeDraft({ ...outcome, project: null }).subprojectName, "");
});

test("editing an item changes only that item", () => {
  const draft = updateDraftItem(createOutcomeDraft(outcome), 1, {
    title: "초안 v2",
    npcId: "npc-2",
  });
  assert.deepEqual(
    draft.items.map((item) => [item.title, item.npcId]),
    [
      ["조사", "npc-1"],
      ["초안 v2", "npc-2"],
      ["검토", null],
    ],
  );
});

test("the registration body includes only selected items, and an after pointing to a dropped item is discarded", () => {
  const draft = updateDraftItem(createOutcomeDraft(outcome), 1, { selected: false });
  const body = draftToRegistration(draft);
  assert.deepEqual(body.items, [
    { index: 0, title: "조사", npcId: "npc-1", after: [] },
    { index: 2, title: "검토", npcId: null, after: [] },
  ]);
  assert.deepEqual(body.tenant, { slug: "가격-개편", name: "가격 개편" });
});

test("clearing the subproject name makes tenant null", () => {
  const draft = { ...createOutcomeDraft(outcome), subprojectName: "  " };
  assert.equal(draftToRegistration(draft).tenant, null);
});

test("an item with a blank title is excluded from the registration body", () => {
  const draft = updateDraftItem(createOutcomeDraft(outcome), 0, { title: "   " });
  assert.deepEqual(
    draftToRegistration(draft).items.map((item) => item.index),
    [1, 2],
  );
  // Item 0 was dropped, so item 1's after must also be empty.
  assert.deepEqual(draftToRegistration(draft).items[0].after, []);
});

test("a tenant slug is lowercase-and-hyphen and never exceeds 64 characters", () => {
  assert.equal(tenantSlugFromName("  Q4 Content  Pipeline! "), "q4-content-pipeline");
  assert.equal(tenantSlugFromName("가격 개편"), "가격-개편");
  assert.equal(tenantSlugFromName("---"), "");
  assert.equal(tenantSlugFromName("a".repeat(100)).length, 64);
  for (const slug of ["q4-content-pipeline", "가격-개편", "research_2"])
    assert.ok(isTenantSlug(slug), slug);
  for (const slug of ["", "-a", "Upper", "a b", "a".repeat(65)])
    assert.ok(!isTenantSlug(slug), slug);
});
