import test from "node:test";
import assert from "node:assert/strict";

import { MeetingFloorController } from "./floor-controller";
import type { NpcRuntime } from "./npc-runtime";
import type { Participant } from "./turn-policy";

// Distinguishes a participant the poll **couldn't reach** from one who stayed silent.
//
// A failed participant used to vanish — it went into neither raises nor passes. So the
// decision became `all-passed` and the screen showed "everyone PASSed" — even though no
// one actually passed. The past "everyone PASSed" incident was exactly this shape. Hermes
// clearly rejects with 429 when the concurrent-run cap is exceeded (api_server.py:7154),
// but that rejection evaporated here.

function participant(npcId: string): Participant {
  return { npcId, displayName: npcId, seated: true, turnCount: 0, lastSpokeAt: 0 } as Participant;
}

function controllerWith(
  poll: (npcId: string) => Promise<{ wantsToSpeak: boolean; reason: string }>,
) {
  const fc = new MeetingFloorController({
    inbox: { take: () => null } as never,
    mode: "meeting",
    maxConcurrentPolls: 4,
    onPollStart: () => {},
  });
  const runtimeFor = (npcId: string) =>
    ({ poll: () => poll(npcId), isBurnedOut: () => false }) as unknown as NpcRuntime;
  return (candidates: Participant[]) =>
    fc.next({
      participants: candidates,
      runtimeFor,
      remainingTurns: () => 5,
      lastSpeakerId: null,
      pollingAllowed: true,
      onSkippedGrant: () => {},
    });
}

test("an unreachable participant is recorded in failures, not as a PASS", async () => {
  const next = controllerWith(async (npcId) => {
    if (npcId === "b") throw new Error("Too many concurrent runs (max 2)");
    return { wantsToSpeak: false, reason: "" };
  });
  const decision = await next([participant("a"), participant("b")]);

  assert.equal(decision.kind, "all-passed");
  const report = "pollResult" in decision ? decision.pollResult : null;
  assert.ok(report);
  assert.deepEqual(report.passes, ["a"], "a 만 진짜 PASS 다");
  assert.deepEqual(
    report.failures?.map((f) => f.npcId),
    ["b"],
    "b 는 닿지 못한 것이지 패스한 게 아니다",
  );
});

test("if no one is reachable, passes is empty and only failures is filled", async () => {
  const next = controllerWith(async () => {
    throw new Error("Too many concurrent runs (max 2)");
  });
  const decision = await next([participant("a"), participant("b")]);

  const report = "pollResult" in decision ? decision.pollResult : null;
  assert.ok(report);
  assert.deepEqual(report.passes, [], "아무도 패스하지 않았다");
  assert.equal(report.failures?.length, 2);
});

test("if no one fails, failures is an empty array", async () => {
  const next = controllerWith(async () => ({ wantsToSpeak: false, reason: "" }));
  const decision = await next([participant("a")]);
  const report = "pollResult" in decision ? decision.pollResult : null;
  assert.deepEqual(report?.failures, []);
});
