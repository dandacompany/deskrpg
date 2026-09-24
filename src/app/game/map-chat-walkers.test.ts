import assert from "node:assert/strict";
import test from "node:test";

import { MapChatWalkers } from "./map-chat-walkers";

test("an NPC called via map chat does not open the 1:1 dialog on arrival", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  assert.equal(w.takeOnArrival("danvi"), true);
});

test("an NPC called via the context menu opens the dialog on arrival", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi"); // no reason
  assert.equal(w.takeOnArrival("danvi"), false);
});

test("a context menu call invalidates a previous map chat wait", () => {
  // The user called via map chat, then called again by right-click before arrival. The game scene
  // silently ignores recalls of an NPC already walking, so arrival happens from the original walk.
  // Without clearing, that arrival would be read as the map chat one, swallowing the dialog just explicitly requested.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.noteCall("danvi");
  assert.equal(w.takeOnArrival("danvi"), false, "대화창이 삼켜집니다.");
});

test("an arrival is consumed only once", () => {
  // When the same NPC is later called via the context menu, the dialog must open then.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  assert.equal(w.takeOnArrival("danvi"), true);
  assert.equal(w.takeOnArrival("danvi"), false, "대기가 소비되지 않고 남았습니다.");
});

test("a walk that ends without arrival leaves no wait behind", () => {
  // Returning to the seat sends no arrival event. If left behind, that NPC's next arrival
  // would wrongly be read as a map chat one.
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.forget("danvi");
  assert.equal(w.takeOnArrival("danvi"), false, "복귀 후에도 대기가 남았습니다.");
});

test("counted separately per NPC", () => {
  const w = new MapChatWalkers();
  w.noteCall("danvi", "map-chat");
  w.noteCall("mia");
  assert.equal(w.takeOnArrival("mia"), false);
  assert.equal(w.takeOnArrival("danvi"), true, "다른 NPC 의 호출이 대기를 지웠습니다.");
});
