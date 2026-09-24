import assert from "node:assert/strict";
import test from "node:test";

import { buildAttentionInbox } from "./attention-inbox";

const card = (id: string, status: string, title = id, at: string | null = null) => ({
  id,
  status,
  title,
  at,
});
const T = (n: number) => `2026-09-21T00:00:0${n}.000Z`;

const base = {
  cards: [] as { id: string; status: string; title: string }[],
  approvals: [] as {
    id: string;
    title: string;
    requestedBy: string;
    createdAt: string;
    taskIds: string[];
  }[],
  cronFailures: [] as { messageId: string; jobId: string; jobName: string; createdAt: string }[],
};

test("an empty board yields an empty list", () => {
  assert.deepEqual(buildAttentionInbox(base), []);
});

test("a pending approval becomes one row — it carries the card count", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("t1", "blocked"), card("t2", "blocked")],
    approvals: [
      {
        id: "a1",
        title: "2건 수행할까요?",
        requestedBy: "sophie",
        createdAt: T(1),
        taskIds: ["t1", "t2"],
      },
    ],
  });
  assert.equal(rows.length, 1, "승인 대기 카드는 각각이 아니라 승인 한 줄로 모인다");
  assert.deepEqual(rows[0], {
    kind: "approval",
    id: "a1",
    title: "2건 수행할까요?",
    at: T(1),
    requestedBy: "sophie",
    count: 2,
  });
});

test("a blocked card not tied to an approval stands alone as 'blocked'", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("t1", "blocked", "오류로 막힘")],
  });
  assert.deepEqual(rows, [
    { kind: "blocked", id: "t1", title: "오류로 막힘", at: null, requestedBy: null, count: 1 },
  ]);
});

test("a card pending approval doesn't also show up as 'blocked'", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("t1", "blocked"), card("t2", "blocked")],
    approvals: [
      { id: "a1", title: "묶음", requestedBy: "sophie", createdAt: T(1), taskIds: ["t1"] },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id]),
    [
      ["approval", "a1"],
      ["blocked", "t2"],
    ],
  );
});

test("cards pending review each stand as their own row", () => {
  const rows = buildAttentionInbox({ ...base, cards: [card("t9", "review", "결과 검토")] });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["review"],
  );
});

test("a status with nothing for a human to do doesn't appear in the list", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: ["triage", "todo", "scheduled", "ready", "running", "done", "archived"].map((s, i) =>
      card(`t${i}`, s),
    ),
  });
  assert.deepEqual(rows, [], "무엇이 이것을 전진시키는가에 답할 수 없는 줄은 넣지 않는다");
});

test("a failed cron run becomes one row", () => {
  const rows = buildAttentionInbox({
    ...base,
    cronFailures: [{ messageId: "m1", jobId: "j1", jobName: "야간 집계", createdAt: T(2) }],
  });
  assert.deepEqual(rows, [
    { kind: "cron_failed", id: "j1", title: "야간 집계", at: T(2), requestedBy: null, count: 1 },
  ]);
});

test("the oldest comes first — surfaces what's been neglected", () => {
  const rows = buildAttentionInbox({
    ...base,
    approvals: [
      { id: "new", title: "새것", requestedBy: "s", createdAt: T(9), taskIds: [] },
      { id: "old", title: "오래된 것", requestedBy: "s", createdAt: T(1), taskIds: [] },
    ],
    cronFailures: [{ messageId: "m", jobId: "j", jobName: "중간", createdAt: T(5) }],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["old", "j", "new"],
  );
});

test("a row with no timestamp comes after rows that have one — id breaks ties so order doesn't wobble", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("b2", "blocked"), card("b1", "blocked")],
    cronFailures: [{ messageId: "m", jobId: "j", jobName: "크론", createdAt: T(1) }],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["j", "b1", "b2"],
  );
});

test("cards with a timestamp are ordered alongside everything else — uses the board response's created_at", () => {
  // `KanbanTask.created_at` arrives as epoch seconds. The caller reads it with `taskTimeMs` and passes it through as ISO.
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("late", "review", "늦은 검토", T(9)), card("early", "blocked", "이른 막힘", T(1))],
    cronFailures: [{ messageId: "m", jobId: "j", jobName: "중간", createdAt: T(5) }],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["early", "j", "late"],
    "시각이 있으면 종류와 무관하게 오래된 순이다",
  );
});

test("only cards whose timestamp couldn't be read go last", () => {
  const rows = buildAttentionInbox({
    ...base,
    cards: [card("unknown", "review", "시각 없음"), card("known", "review", "시각 있음", T(3))],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["known", "unknown"],
  );
});
