import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingSummaryPrompt,
  MEETING_OUTCOME_LIMITS,
  parseMeetingOutcome,
  type OutcomeParticipant,
} from "./meeting-outcome";

const participants: OutcomeParticipant[] = [
  { npcId: "npc-sophie", name: "소피" },
  { npcId: "npc-noah", name: "Noah" },
];

function parse(json: unknown, raw = false) {
  return parseMeetingOutcome(raw ? (json as string) : JSON.stringify(json), participants);
}

test("reads decisions, follow-ups, and a project recommendation from the wide JSON", () => {
  const parsed = parse({
    keyTopics: ["가격", "일정"],
    conclusions: "A안으로 간다.",
    decisions: ["A안 채택", "9월 말 초안"],
    followUps: [
      {
        title: "경쟁사 가격 조사",
        summary: "세 곳을 본다",
        acceptance: "표 한 장",
        assignee: "소피",
      },
      { title: "초안 작성", assignee: "noah", after: [0] },
    ],
    project: { recommended: true, name: "가격 개편", reason: "세 단계로 이어진다" },
  });

  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.keyTopics, ["가격", "일정"]);
  assert.equal(parsed.conclusions, "A안으로 간다.");
  assert.deepEqual(parsed.outcome?.decisions, ["A안 채택", "9월 말 초안"]);
  assert.deepEqual(parsed.outcome?.followUps, [
    {
      title: "경쟁사 가격 조사",
      summary: "세 곳을 본다",
      acceptance: "표 한 장",
      assigneeNpcId: "npc-sophie",
      assigneeName: "소피",
      after: [],
    },
    {
      title: "초안 작성",
      summary: null,
      acceptance: null,
      assigneeNpcId: "npc-noah",
      assigneeName: "noah",
      after: [0],
    },
  ]);
  assert.deepEqual(parsed.outcome?.project, {
    recommended: true,
    name: "가격 개편",
    reason: "세 단계로 이어진다",
  });
});

test("finds and reads the JSON chunk even with other text attached before/after", () => {
  const parsed = parse('알겠습니다.\n```json\n{"keyTopics":["a"],"conclusions":"b"}\n```', true);
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.keyTopics, ["a"]);
  assert.deepEqual(parsed.outcome, { decisions: [], followUps: [], project: null });
});

test("marks it failed when JSON is missing or broken — doesn't fake success with empty values", () => {
  for (const raw of ["", "요약할 수 없습니다", '{"keyTopics": [']) {
    const parsed = parse(raw, true);
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.outcome, null);
    assert.deepEqual(parsed.keyTopics, []);
    assert.equal(parsed.conclusions, null);
  }
});

test("leaves a non-participant assignee unassigned but keeps the name the model wrote", () => {
  const parsed = parse({
    followUps: [
      { title: "검토", assignee: "리나" },
      { title: "정리", assignee: null },
    ],
  });
  assert.deepEqual(
    parsed.outcome?.followUps.map((item) => [item.assigneeNpcId, item.assigneeName]),
    [
      [null, "리나"],
      [null, null],
    ],
  );
});

test("after filters out out-of-range, self-referencing, and duplicate entries", () => {
  const parsed = parse({
    followUps: [{ title: "a", after: [0, 1, 1, 9, -1, "x"] }, { title: "b" }],
  });
  assert.deepEqual(parsed.outcome?.followUps[0].after, [1]);
});

test("when after forms a cycle, drops the link that closes the loop", () => {
  const parsed = parse({
    followUps: [
      { title: "a", after: [2] },
      { title: "b", after: [0] },
      { title: "c", after: [1] },
    ],
  });
  const after = parsed.outcome?.followUps.map((item) => item.after);
  // Accepted from the front, dropping only the final link that closes the loop (c → b).
  assert.deepEqual(after, [[2], [0], []]);
});

test("drops titleless items and remaps the remaining items' after to new indices", () => {
  const parsed = parse({
    followUps: [{ title: "  " }, { title: "a" }, { title: "b", after: [0, 1] }],
  });
  assert.deepEqual(
    parsed.outcome?.followUps.map((item) => [item.title, item.after]),
    [
      ["a", []],
      ["b", [0]],
    ],
  );
});

test("truncates count and length at the limits", () => {
  const parsed = parse({
    decisions: Array.from({ length: 30 }, (_, i) => `결정 ${i}`),
    followUps: Array.from({ length: 30 }, (_, i) => ({ title: `${i}`.padEnd(500, "x") })),
  });
  assert.equal(parsed.outcome?.decisions.length, MEETING_OUTCOME_LIMITS.decisions);
  assert.equal(parsed.outcome?.followUps.length, MEETING_OUTCOME_LIMITS.followUps);
  assert.equal(parsed.outcome?.followUps[0].title.length, MEETING_OUTCOME_LIMITS.title);
});

test("null when project is missing or malformed", () => {
  assert.equal(parse({ project: "yes" }).outcome?.project, null);
  assert.deepEqual(parse({ project: { recommended: "true", name: 3 } }).outcome?.project, {
    recommended: false,
    name: null,
    reason: null,
  });
});

test("the summary prompt pins the assignee candidates to attending employee names", () => {
  const prompt = buildMeetingSummaryPrompt("가격 개편", "소피: A안이 낫습니다", participants);
  assert.match(prompt, /참석 직원: 소피, Noah/);
  assert.match(prompt, /회의 주제: 가격 개편/);
  assert.match(prompt, /소피: A안이 낫습니다/);
  for (const key of ["decisions", "followUps", "project", "after", "acceptance"])
    assert.ok(prompt.includes(`"${key}"`), key);
});
