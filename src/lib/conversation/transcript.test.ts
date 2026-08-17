import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  test("턴을 순번과 함께 기록한다", () => {
    const t = new Transcript();
    const first = t.add("a", "에이", "안녕", 1000);
    const second = t.add("b", "비", "반가워", 2000);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(t.all().length, 2);
  });

  test("참가자별 발언 수를 센다", () => {
    const t = new Transcript();
    t.add("a", "에이", "1", 1);
    t.add("a", "에이", "2", 2);
    t.add("b", "비", "3", 3);
    assert.equal(t.turnCountFor("a"), 2);
    assert.equal(t.turnCountFor("b"), 1);
    assert.equal(t.turnCountFor("없음"), 0);
  });

  test("마지막 발언 시각을 기억한다", () => {
    const t = new Transcript();
    t.add("a", "에이", "x", 500);
    assert.equal(t.lastSpokeAt("a"), 500);
    assert.equal(t.lastSpokeAt("b"), 0, "발언한 적 없으면 0");
  });

  test("recent는 뒤에서 n개만 준다", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.deepEqual(t.recent(2).map((x) => x.content), ["4", "5"]);
  });

  test("conversation_history는 role/content 배열로 나온다", () => {
    const t = new Transcript();
    t.add("user", "단테", "주제는 배포입니다", 1);
    t.add("a", "에이", "제 의견은", 2);
    const hist = t.toConversationHistory(10);
    assert.deepEqual(hist, [
      { role: "user", content: "단테: 주제는 배포입니다" },
      { role: "assistant", content: "에이: 제 의견은" },
    ]);
  });

  test("conversation_history가 limit을 지킨다", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.equal(t.toConversationHistory(2).length, 2);
  });
});
