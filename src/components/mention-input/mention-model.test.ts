import assert from "node:assert/strict";
import test from "node:test";

import {
  filterCandidates,
  findMentionQuery,
  reduceDropdown,
  serializeSegments,
  type Segment,
} from "./mention-model";

const cands = [
  { id: "a", name: "소피" },
  { id: "b", name: "올리버" },
  { id: "c", name: "소라" },
];

test("a chip serializes as @[name], and text serializes as-is", () => {
  const segs: Segment[] = [
    { kind: "mention", id: "a", name: "소피" },
    { kind: "text", text: " 안녕 " },
    { kind: "mention", id: "b", name: "올리버" },
    { kind: "text", text: " 회의하자" },
  ];
  assert.equal(serializeSegments(segs), "@[소피] 안녕 @[올리버] 회의하자");
});

test("finds an open @query in the text before the caret — closes on whitespace", () => {
  assert.deepEqual(findMentionQuery("안녕 @소"), { start: 3, query: "소" });
  assert.deepEqual(findMentionQuery("@"), { start: 0, query: "" });
  assert.equal(findMentionQuery("안녕 @소 피"), null, "공백 뒤는 쿼리가 아니다");
  assert.equal(findMentionQuery("이메일 a@b"), null, "단어 중간의 @ 는 멘션이 아니다");
  assert.equal(findMentionQuery("안녕"), null);
});

test("candidates match by substring, or all of them for an empty query", () => {
  assert.deepEqual(
    filterCandidates("소", cands).map((c) => c.name),
    ["소피", "소라"],
  );
  assert.deepEqual(filterCandidates("", cands).length, 3);
  assert.deepEqual(filterCandidates("zz", cands), []);
});

test("dropdown keyboard: up/down cycles, Enter selects, Esc closes", () => {
  let s = reduceDropdown({ open: true, index: 0, count: 3 }, "ArrowDown");
  assert.equal(s.index, 1);
  s = reduceDropdown(s, "ArrowUp");
  assert.equal(s.index, 0);
  s = reduceDropdown(s, "ArrowUp");
  assert.equal(s.index, 2, "맨 위에서 ↑ 는 맨 아래로");
  assert.equal(reduceDropdown(s, "Escape").open, false);
  assert.equal(reduceDropdown({ open: true, index: 1, count: 3 }, "Enter").select, 1);
  assert.equal(
    reduceDropdown({ open: true, index: 0, count: 0 }, "Enter").select,
    undefined,
    "후보 0건이면 선택 없음",
  );
});
