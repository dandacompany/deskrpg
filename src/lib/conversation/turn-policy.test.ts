import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { needsPolling, eligibleParticipants, selectNextSpeaker } from "./turn-policy";
import type { Participant } from "./turn-policy";

function p(npcId: string, over: Partial<Participant> = {}): Participant {
  return { npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0, ...over };
}

describe("needsPolling", () => {
  test("peer는 폴링하지 않는다 — 2인 대화에서 손들기는 호출을 2배로 만드는 낭비", () => {
    assert.equal(needsPolling("peer"), false);
  });
  test("meeting과 group은 폴링한다", () => {
    assert.equal(needsPolling("meeting"), true);
    assert.equal(needsPolling("group"), true);
  });
});

describe("eligibleParticipants", () => {
  test("착석하지 않은 참가자는 제외된다", () => {
    const all = [p("a"), p("b", { seated: false })];
    const got = eligibleParticipants(all, () => 5);
    assert.deepEqual(got.map((x) => x.npcId), ["a"]);
  });
  test("할당량을 소진한 참가자는 제외된다", () => {
    const all = [p("a"), p("b")];
    const got = eligibleParticipants(all, (id) => (id === "a" ? 0 : 3));
    assert.deepEqual(got.map((x) => x.npcId), ["b"]);
  });
  test("둘 다 만족하면 남는다", () => {
    const all = [p("a"), p("b")];
    assert.equal(eligibleParticipants(all, () => 1).length, 2);
  });
});

describe("selectNextSpeaker", () => {
  test("peer는 직전 발언자가 아닌 쪽으로 교대한다", () => {
    const cands = [p("a"), p("b")];
    assert.equal(selectNextSpeaker("peer", cands, "a")?.npcId, "b");
    assert.equal(selectNextSpeaker("peer", cands, "b")?.npcId, "a");
  });
  test("peer에서 직전 발언자가 없으면 첫 참가자가 시작한다", () => {
    assert.equal(selectNextSpeaker("peer", [p("a"), p("b")], null)?.npcId, "a");
  });
  test("meeting은 가장 오래 발언하지 않은 쪽을 고른다", () => {
    const cands = [p("a", { lastSpokeAt: 100 }), p("b", { lastSpokeAt: 50 })];
    assert.equal(selectNextSpeaker("meeting", cands, null)?.npcId, "b");
  });
  test("group도 같은 공정성 규칙을 쓴다", () => {
    const cands = [p("a", { lastSpokeAt: 10 }), p("b", { lastSpokeAt: 99 })];
    assert.equal(selectNextSpeaker("group", cands, null)?.npcId, "a");
  });
  test("후보가 없으면 null", () => {
    assert.equal(selectNextSpeaker("meeting", [], null), null);
  });
});
