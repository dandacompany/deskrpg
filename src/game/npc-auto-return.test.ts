import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoReturn, shouldReturnOnRoomChange } from "./npc-auto-return";

test("an NPC called directly (calledForRoom=null) runs the timer when there is no dialog", () => {
  assert.equal(
    shouldAutoReturn(
      { moveState: "waiting", calledForRoom: null },
      { dialogOpen: false, visibleRoomId: "r1" },
    ),
    true,
  );
  assert.equal(
    shouldAutoReturn(
      { moveState: "waiting", calledForRoom: null },
      { dialogOpen: true, visibleRoomId: null },
    ),
    false,
  );
});
test("an NPC called by a room stays while that room is visible — when another room is visible it runs the timer", () => {
  assert.equal(
    shouldAutoReturn(
      { moveState: "waiting", calledForRoom: "r1" },
      { dialogOpen: false, visibleRoomId: "r1" },
    ),
    false,
  );
  assert.equal(
    shouldAutoReturn(
      { moveState: "waiting", calledForRoom: "r1" },
      { dialogOpen: false, visibleRoomId: "r2" },
    ),
    true,
  );
  assert.equal(
    shouldAutoReturn(
      { moveState: "waiting", calledForRoom: "r1" },
      { dialogOpen: false, visibleRoomId: null },
    ),
    true,
  );
});
test("when the visible room changes, only NPCs that are waiting and not for that room go back immediately", () => {
  assert.equal(shouldReturnOnRoomChange({ moveState: "waiting", calledForRoom: "r1" }, "r2"), true);
  assert.equal(
    shouldReturnOnRoomChange({ moveState: "waiting", calledForRoom: "r1" }, "r1"),
    false,
  );
  assert.equal(
    shouldReturnOnRoomChange({ moveState: "waiting", calledForRoom: null }, null),
    false,
    "직접 부른 NPC 는 방 전환과 무관",
  );
  assert.equal(
    shouldReturnOnRoomChange({ moveState: "returning", calledForRoom: "r1" }, null),
    false,
  );
});
