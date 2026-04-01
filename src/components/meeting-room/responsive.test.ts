import assert from "node:assert/strict";
import test from "node:test";

import {
  clampMeetingSidebarWidth,
  computeMeetingSceneScale,
  computeMeetingSceneFrameWidth,
} from "./responsive";

test("clampMeetingSidebarWidth enforces min and max bounds", () => {
  assert.equal(clampMeetingSidebarWidth(240, 1600), 320);
  assert.equal(clampMeetingSidebarWidth(720, 1600), 560);
});

test("clampMeetingSidebarWidth preserves minimum room for the table scene", () => {
  assert.equal(clampMeetingSidebarWidth(500, 980), 320);
  assert.equal(clampMeetingSidebarWidth(360, 1200), 360);
});

test("computeMeetingSceneFrameWidth grows with long tables", () => {
  assert.equal(computeMeetingSceneFrameWidth(520), 980);
  assert.equal(computeMeetingSceneFrameWidth(900), 1160);
});

test("computeMeetingSceneScale keeps full size until the frame gets tighter", () => {
  assert.equal(computeMeetingSceneScale(1160, 980), 1);
  assert.equal(computeMeetingSceneScale(870, 980), 0.89);
  assert.equal(computeMeetingSceneScale(320, 980), 0.58);
});
