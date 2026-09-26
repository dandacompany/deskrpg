import assert from "node:assert/strict";
import test from "node:test";

import { parseReadMark } from "./read-mark";

const ID = "0192f1a2-7b3c-7d4e-8f90-123456789abc";

test("a room or DM mark with a uuid is accepted, with its time", () => {
  assert.deepEqual(parseReadMark({ kind: "room", id: ID, at: "2026-09-26T10:00:00.000Z" }), {
    kind: "room",
    id: ID,
    at: new Date("2026-09-26T10:00:00.000Z"),
  });
  assert.equal(parseReadMark({ kind: "dm", id: ID })?.kind, "dm");
});

test("a missing or unreadable time means now", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  assert.deepEqual(parseReadMark({ kind: "dm", id: ID, at: "soon" }, now)?.at, now);
  assert.deepEqual(parseReadMark({ kind: "dm", id: ID }, now)?.at, now);
});

test("unknown kinds, non-uuid ids and non-objects are refused", () => {
  for (const bad of [
    null,
    "x",
    { kind: "report", id: ID },
    { kind: "room", id: "office" },
    { kind: "room" },
  ])
    assert.equal(parseReadMark(bad), null);
});
