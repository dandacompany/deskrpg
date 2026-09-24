import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { needsPolling, eligibleParticipants, selectNextSpeaker } from "./turn-policy";
import type { Participant } from "./turn-policy";

function p(npcId: string, over: Partial<Participant> = {}): Participant {
  return { npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0, ...over };
}

describe("needsPolling", () => {
  test("peer does not poll — raising a hand in a 2-person chat would just double the calls", () => {
    assert.equal(needsPolling("peer"), false);
  });
  test("meeting and group poll", () => {
    assert.equal(needsPolling("meeting"), true);
    assert.equal(needsPolling("group"), true);
  });
});

describe("eligibleParticipants", () => {
  test("unseated participants are excluded", () => {
    const all = [p("a"), p("b", { seated: false })];
    const got = eligibleParticipants(all, () => 5);
    assert.deepEqual(
      got.map((x) => x.npcId),
      ["a"],
    );
  });
  test("participants who exhausted their quota are excluded", () => {
    const all = [p("a"), p("b")];
    const got = eligibleParticipants(all, (id) => (id === "a" ? 0 : 3));
    assert.deepEqual(
      got.map((x) => x.npcId),
      ["b"],
    );
  });
  test("participants who satisfy both stay", () => {
    const all = [p("a"), p("b")];
    assert.equal(eligibleParticipants(all, () => 1).length, 2);
  });
});

describe("selectNextSpeaker", () => {
  test("peer alternates to whoever did not speak last", () => {
    const cands = [p("a"), p("b")];
    assert.equal(selectNextSpeaker("peer", cands, "a")?.npcId, "b");
    assert.equal(selectNextSpeaker("peer", cands, "b")?.npcId, "a");
  });
  test("peer starts with the first participant when there is no last speaker", () => {
    assert.equal(selectNextSpeaker("peer", [p("a"), p("b")], null)?.npcId, "a");
  });
  test("meeting picks whoever has gone longest without speaking", () => {
    const cands = [p("a", { lastSpokeAt: 100 }), p("b", { lastSpokeAt: 50 })];
    assert.equal(selectNextSpeaker("meeting", cands, null)?.npcId, "b");
  });
  test("group uses the same fairness rule", () => {
    const cands = [p("a", { lastSpokeAt: 10 }), p("b", { lastSpokeAt: 99 })];
    assert.equal(selectNextSpeaker("group", cands, null)?.npcId, "a");
  });
  test("returns null when there are no candidates", () => {
    assert.equal(selectNextSpeaker("meeting", [], null), null);
  });
});
