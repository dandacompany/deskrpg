import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  test("records turns with a sequence number", () => {
    const t = new Transcript();
    const first = t.add("a", "에이", "안녕", 1000);
    const second = t.add("b", "비", "반가워", 2000);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(t.all().length, 2);
  });

  test("counts turns per participant", () => {
    const t = new Transcript();
    t.add("a", "에이", "1", 1);
    t.add("a", "에이", "2", 2);
    t.add("b", "비", "3", 3);
    assert.equal(t.turnCountFor("a"), 2);
    assert.equal(t.turnCountFor("b"), 1);
    assert.equal(t.turnCountFor("없음"), 0);
  });

  test("remembers the last spoken timestamp", () => {
    const t = new Transcript();
    t.add("a", "에이", "x", 500);
    assert.equal(t.lastSpokeAt("a"), 500);
    assert.equal(t.lastSpokeAt("b"), 0, "발언한 적 없으면 0");
  });

  test("recent returns only the last n", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.deepEqual(
      t.recent(2).map((x) => x.content),
      ["4", "5"],
    );
  });

  test("conversation_history comes out as a role/content array", () => {
    const t = new Transcript();
    t.add("user", "단테", "주제는 배포입니다", 1);
    t.add("a", "에이", "제 의견은", 2);
    const hist = t.toConversationHistory(10);
    assert.deepEqual(hist, [
      { role: "user", content: "단테: 주제는 배포입니다" },
      { role: "assistant", content: "에이: 제 의견은" },
    ]);
  });

  test("conversation_history respects the limit", () => {
    const t = new Transcript();
    for (let i = 1; i <= 5; i++) t.add("a", "에이", String(i), i);
    assert.equal(t.toConversationHistory(2).length, 2);
  });
});
