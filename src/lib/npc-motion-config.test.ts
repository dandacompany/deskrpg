import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NPC_MOTION,
  RUN_SPEED_THRESHOLD,
  normalizeNpcMotionConfig,
  tilesPerSecond,
} from "./npc-motion-config";

test("the default follows Dante's decision as-is — summon/meeting summon are 2x the normal walk speed", () => {
  assert.equal(DEFAULT_NPC_MOTION.summon, DEFAULT_NPC_MOTION.walk * 2);
  assert.equal(DEFAULT_NPC_MOTION.meetingSummon, DEFAULT_NPC_MOTION.walk * 2);
  assert.equal(DEFAULT_NPC_MOTION.walk, 150, "지금까지의 일반 이동 속도를 바꾸지 않는다");
  assert.equal(DEFAULT_NPC_MOTION.stroll, 55, "지금까지의 산책 속도를 바꾸지 않는다");
});

test("in the default config, summon runs while normal walking walks", () => {
  assert.ok(DEFAULT_NPC_MOTION.summon >= RUN_SPEED_THRESHOLD);
  assert.ok(DEFAULT_NPC_MOTION.meetingSummon >= RUN_SPEED_THRESHOLD);
  assert.ok(DEFAULT_NPC_MOTION.walk < RUN_SPEED_THRESHOLD);
  assert.ok(DEFAULT_NPC_MOTION.stroll < RUN_SPEED_THRESHOLD);
});

test("an empty or invalid value falls back to the default per field, and out-of-range values are clamped", () => {
  assert.deepEqual(normalizeNpcMotionConfig(null), DEFAULT_NPC_MOTION);
  assert.deepEqual(normalizeNpcMotionConfig("x"), DEFAULT_NPC_MOTION);
  const got = normalizeNpcMotionConfig({
    walk: 9999,
    stroll: -3,
    summon: "fast",
    meetingSummon: 212,
    extra: 1,
  });
  assert.equal(got.walk, 480);
  assert.equal(got.stroll, 20);
  assert.equal(got.summon, DEFAULT_NPC_MOTION.summon);
  assert.equal(got.meetingSummon, 210, "5 단위로 맞춘다");
  assert.equal("extra" in got, false, "모르는 키는 버린다");
});

test("tiles/second display", () => {
  assert.equal(tilesPerSecond(150), 4.7);
  assert.equal(tilesPerSecond(300), 9.4);
});
