import test from "node:test";
import assert from "node:assert/strict";
import { meetingOverflow } from "./capacity";

test("nobody is left over while the picked NPCs and the people in the room fit the meeting spots", () => {
  assert.equal(meetingOverflow({ seats: 4, standing: 9 }, 12, 1), 0);
});

test("everyone past the seats and standing spots attends from where they stand", () => {
  assert.equal(meetingOverflow({ seats: 4, standing: 2 }, 12, 1), 7);
  assert.equal(meetingOverflow({ seats: 4, standing: 2 }, 6, 2), 2);
});

test("an unknown room says nothing rather than guessing", () => {
  assert.equal(meetingOverflow(null, 12, 1), 0);
});

test("the person opening the meeting counts even before the room lists them", () => {
  assert.equal(meetingOverflow({ seats: 2, standing: 0 }, 2, 0), 1);
});
