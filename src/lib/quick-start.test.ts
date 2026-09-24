import test from "node:test";
import assert from "node:assert/strict";

import {
  QUICK_START_APPEARANCE,
  quickStartChannelName,
  quickStartCharacterName,
  quickStartGamePath,
} from "./quick-start";
import { validateOfficeAppearance } from "../game/three/office-appearance";

test("the default appearance is the first male look that passes the character route's validation", () => {
  assert.equal(validateOfficeAppearance(QUICK_START_APPEARANCE), null);
  assert.deepEqual(QUICK_START_APPEARANCE, { officeLookId: "office-jun", bodyType: "male" });
});

test("the name derives from the nickname and never exceeds the length limit", () => {
  assert.equal(quickStartCharacterName("  단테  "), "단테");
  assert.equal(quickStartCharacterName(""), "Player");
  assert.equal(quickStartCharacterName("x".repeat(80)).length, 50);
  assert.equal(quickStartChannelName(null), "My Office");
  assert.equal(quickStartChannelName("x".repeat(200)).length, 100);
});

test("the game path carries only the channel — the server decides the character", () => {
  assert.equal(quickStartGamePath({ channelId: "c 1" }), "/game?channelId=c+1");
});
