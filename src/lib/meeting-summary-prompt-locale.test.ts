import assert from "node:assert/strict";
import test from "node:test";
import { buildMeetingSummaryPrompt } from "./meeting-outcome";

const HANGUL = /[가-힣]/;
const participants = [{ npcId: "n1", name: "A" }];

for (const [locale, language] of [
  ["en", "English"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
  [null, "English"],
] as const) {
  test(`the ${String(locale)} summary prompt is English and asks for ${language} values`, () => {
    const prompt = buildMeetingSummaryPrompt("Topic", "[A] hi", participants, locale);
    assert.equal(HANGUL.test(prompt), false);
    assert.ok(prompt.includes("Meeting topic: Topic"));
    assert.ok(prompt.includes("Attending employees: A"));
    assert.ok(prompt.endsWith(`Write every string value in ${language}.`));
  });
}

test("the English summary prompt keeps the same JSON keys", () => {
  const prompt = buildMeetingSummaryPrompt("Topic", "[A] hi", participants, "en");
  for (const key of [
    '"keyTopics"',
    '"conclusions"',
    '"decisions"',
    '"followUps"',
    '"title"',
    '"summary"',
    '"acceptance"',
    '"assignee"',
    '"after"',
    '"project"',
    '"recommended"',
    '"name"',
    '"reason"',
  ]) {
    assert.ok(prompt.includes(key), key);
  }
});

test("the English summary prompt fills an empty participant list with (none)", () => {
  assert.ok(
    buildMeetingSummaryPrompt("Topic", "[A] hi", [], "en").includes("Attending employees: (none)"),
  );
});

test("passing ko explicitly matches the default Korean prompt", () => {
  assert.equal(
    buildMeetingSummaryPrompt("주제", "[A] hi", participants, "ko"),
    buildMeetingSummaryPrompt("주제", "[A] hi", participants),
  );
});
