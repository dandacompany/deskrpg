import assert from "node:assert/strict";
import test from "node:test";

import { MapChatParticipants } from "./map-chat-participants";

test("an NPC who came via map chat becomes a participant of that room, and those to call again are participants not beside us", () => {
  const p = new MapChatParticipants();
  p.noteCalled("r1", "a", "map-chat");
  p.noteCalled("r1", "b", "map-chat");
  p.noteCalled("r1", "c"); // context menu — not a participant
  assert.deepEqual(p.recallTargets("r1", new Set(["a"])).sort(), ["b"], "a 는 이미 곁에 있다");
});

test("participants are split per room — participants of another room are not called", () => {
  const p = new MapChatParticipants();
  p.noteCalled("r1", "a", "map-chat");
  p.noteCalled("r2", "b", "map-chat");
  assert.deepEqual(p.recallTargets("r1", new Set()), ["a"]);
  assert.deepEqual(p.recallTargets("r2", new Set()), ["b"]);
  assert.deepEqual(p.recallTargets("r3", new Set()), [], "모르는 방은 빈 목록");
  assert.deepEqual(p.recallTargets(null, new Set()), [], "방이 없으면 아무도 부르지 않는다");
});

test("sending back (explicit dismiss) removes them from participants of every room — an automatic return does not", () => {
  const p = new MapChatParticipants();
  p.noteCalled("r1", "a", "map-chat");
  p.noteCalled("r2", "a", "map-chat");
  p.noteCalled("r1", "b", "map-chat");
  p.dismiss("a");
  assert.deepEqual(p.recallTargets("r1", new Set()), ["b"]);
  assert.deepEqual(p.recallTargets("r2", new Set()), []);
});

test("calling the same NPC several times counts once", () => {
  const p = new MapChatParticipants();
  p.noteCalled("r1", "a", "map-chat");
  p.noteCalled("r1", "a", "map-chat");
  assert.deepEqual(p.recallTargets("r1", new Set()), ["a"]);
});

test("calls without a roomId are ignored — it is unknown which room they participate in", () => {
  const p = new MapChatParticipants();
  p.noteCalled(undefined, "a", "map-chat");
  assert.deepEqual(p.recallTargets("r1", new Set()), []);
});
