import assert from "node:assert/strict";
import test from "node:test";

import { pushNotification, type GameNotification } from "./notification-list";

const n = (id: string, timestamp: number, read = false): GameNotification => ({
  id,
  message: `m-${id}-${timestamp}`,
  timestamp,
  read,
});

test("a repeated id replaces the old entry and moves to the top, unread", () => {
  const list = [n("b", 2), n("socket-disconnected", 1, true)];
  const next = pushNotification(list, n("socket-disconnected", 3));
  assert.deepEqual(
    next.map((x) => [x.id, x.timestamp, x.read]),
    [
      ["socket-disconnected", 3, false],
      ["b", 2, false],
    ],
  );
});

test("distinct ids stack newest first and keep their order", () => {
  const next = pushNotification([n("b", 2), n("a", 1)], n("c", 3));
  assert.deepEqual(
    next.map((x) => x.id),
    ["c", "b", "a"],
  );
});

test("the list is capped, dropping the oldest", () => {
  let list: GameNotification[] = [];
  for (let i = 0; i < 25; i++) list = pushNotification(list, n(`id-${i}`, i), 20);
  assert.equal(list.length, 20);
  assert.equal(list[0].id, "id-24");
  assert.equal(list[19].id, "id-5");
});

test("ids stay unique after many repeats of the same event", () => {
  let list: GameNotification[] = [];
  for (let i = 0; i < 10; i++) list = pushNotification(list, n("npc-place-occupied", i));
  assert.equal(list.length, 1);
  assert.equal(list[0].timestamp, 9);
});
