import assert from "node:assert/strict";
import test from "node:test";

import { autoOpenDialogOnArrival, isRoomViewActive } from "./arrival-dialog";

test("the room view is active only while a room is shown and no 1:1 dialog covers it", () => {
  assert.equal(isRoomViewActive({ dialogOpen: false, view: "room" }), true);
  assert.equal(isRoomViewActive({ dialogOpen: true, view: "room" }), false);
  assert.equal(isRoomViewActive({ dialogOpen: false, view: "list" }), false);
  assert.equal(isRoomViewActive({ dialogOpen: false, view: "compose" }), false);
});

const base = { hasName: true, fromMapChat: false, calledToTalk: false, roomViewActive: false };

test("a plain arrival opens the 1:1 dialog when no room is being viewed", () => {
  assert.equal(autoOpenDialogOnArrival(base), true);
});

test("an arrival while a room is being viewed leaves the room on screen", () => {
  // A room @mention or a report brings the employee over — the room stays; the navigator shows them waiting.
  assert.equal(autoOpenDialogOnArrival({ ...base, roomViewActive: true }), false);
});

test("an employee the viewer called over to talk opens the dialog even from a room", () => {
  assert.equal(
    autoOpenDialogOnArrival({ ...base, roomViewActive: true, calledToTalk: true }),
    true,
  );
});

test("map chat walkers never open the dialog, and neither does a nameless arrival", () => {
  assert.equal(autoOpenDialogOnArrival({ ...base, fromMapChat: true }), false);
  assert.equal(autoOpenDialogOnArrival({ ...base, fromMapChat: true, calledToTalk: true }), false);
  assert.equal(autoOpenDialogOnArrival({ ...base, hasName: false }), false);
});
