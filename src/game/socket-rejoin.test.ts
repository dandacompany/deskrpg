import assert from "node:assert/strict";
import test from "node:test";
import { createRejoinTracker, registerOnce, shouldRejoinForError } from "./socket-rejoin";

test("the first connect is not a rejoin — the spawn path already sent join", () => {
  const t = createRejoinTracker();
  assert.equal(t.shouldRejoin(true), false);
});

test("a connect after disconnect is a rejoin, consumed only once", () => {
  const t = createRejoinTracker();
  t.onDisconnect();
  assert.equal(t.shouldRejoin(true), true);
  assert.equal(
    t.shouldRejoin(true),
    false,
    "같은 재연결로 두 번 join 하면 player:joined 가 두 번 방송된다",
  );
});

test("if the player has not spawned yet, do not rejoin and leave the flag", () => {
  const t = createRejoinTracker();
  t.onDisconnect();
  assert.equal(t.shouldRejoin(false), false);
  assert.equal(t.shouldRejoin(true), true, "스폰 뒤 다음 connect 에서 잡아야 한다");
});

test("registerOnce attaches only once even if the same handler is registered twice", () => {
  const handlers = new Map<string, Set<() => void>>();
  const bus = {
    on(event: string, handler: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: () => void) {
      handlers.get(event)?.delete(handler);
    },
  };
  const handler = () => {};

  registerOnce(bus, "socket-rejoin", handler);
  registerOnce(bus, "socket-rejoin", handler);

  assert.equal(
    handlers.get("socket-rejoin")?.size,
    1,
    "setupSocketListeners 가 두 번 불려도 핸들러는 하나여야 한다",
  );
});

test("shouldRejoinForError: with the same socket id join already happened, so do not rejoin", () => {
  assert.equal(
    shouldRejoinForError("abc", "abc"),
    false,
    "connect 핸들러가 이미 이 id 로 join 했다",
  );
});

test("shouldRejoinForError: with a different socket id join has not happened yet, so rejoin", () => {
  assert.equal(shouldRejoinForError("new-id", "old-id"), true);
});

test("shouldRejoinForError: without a current socket id (disconnected) this id never joined, so rejoin", () => {
  assert.equal(shouldRejoinForError(undefined, "old-id"), true);
});

test("shouldRejoinForError: rejoin if join never happened in this session", () => {
  assert.equal(shouldRejoinForError("abc", undefined), true);
});
