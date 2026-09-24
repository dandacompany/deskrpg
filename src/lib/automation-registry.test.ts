import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  getAutomationHooks,
  readWorkingSnapshot,
  registerAutomationHooks,
  requestPollNow,
  requestRefreshPollers,
  resetAutomationHooksForTests,
  requestEmitRoomMessage,
} from "./automation-registry";

afterEach(() => resetAutomationHooksForTests());

test("everything is a silent no-op when there's no hook — pollNow is null, the snapshot is an empty array", async () => {
  assert.equal(getAutomationHooks(), undefined);
  assert.equal(await requestPollNow("ch-1"), null);
  await requestRefreshPollers();
  assert.deepEqual(readWorkingSnapshot("ch-1"), []);
});

test("delegates to a registered hook, and resetting reverts it back to a no-op", async () => {
  const calls: string[] = [];
  registerAutomationHooks({
    pollNow: async (channelId) => {
      calls.push(`poll:${channelId}`);
      return { ok: true };
    },
    refreshPollers: async () => {
      calls.push("refresh");
    },
    getWorkingSnapshot: (channelId) => [
      { npcId: `npc-of-${channelId}`, working: true, sources: { runningCards: 1, cronRuns: 0 } },
    ],
    emitRoomMessage: (roomId) => {
      calls.push(`emit:${roomId}`);
    },
  });

  assert.deepEqual(await requestPollNow("ch-1"), { ok: true });
  await requestRefreshPollers();
  assert.equal(readWorkingSnapshot("ch-1")[0]?.npcId, "npc-of-ch-1");
  requestEmitRoomMessage("room-1", { id: "m1" });
  assert.deepEqual(calls, ["poll:ch-1", "refresh", "emit:room-1"]);

  resetAutomationHooksForTests();
  assert.equal(await requestPollNow("ch-1"), null);
  assert.deepEqual(readWorkingSnapshot("ch-1"), []);
  // Doesn't throw even with no hook — a broadcast not going out and a notice not being
  // created carry different weight.
  requestEmitRoomMessage("room-1", { id: "m1" });
});

test("the caller keeps going even if the broadcast throws", () => {
  registerAutomationHooks({
    pollNow: async () => null,
    refreshPollers: async () => {},
    getWorkingSnapshot: () => [],
    emitRoomMessage: () => {
      throw new Error("socket down");
    },
  });
  // Throwing here would fail approval creation — so it's swallowed.
  requestEmitRoomMessage("room-1", { id: "m1" });
  resetAutomationHooksForTests();
});
