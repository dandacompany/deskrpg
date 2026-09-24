import assert from "node:assert/strict";
import test from "node:test";

import { decideNpcUpdate, type ProjectedNpcLike } from "./npc-updated-dispatch";

function projected(overrides: Partial<ProjectedNpcLike> = {}): ProjectedNpcLike {
  return {
    id: "n1",
    name: "소피",
    positionX: 3,
    positionY: 4,
    direction: "down",
    appearance: { body: "light" },
    active: true,
    ...overrides,
  };
}

const noSprites = () => false;
const hasSprites = () => true;

test("the old shape updates only when a sprite exists", () => {
  assert.deepEqual(decideNpcUpdate({ npcId: "n1", name: "소피" }, hasSprites), {
    kind: "update",
    npcId: "n1",
    fields: { name: "소피", direction: undefined, appearance: undefined },
  });
  assert.deepEqual(decideNpcUpdate({ npcId: "n1", name: "소피" }, noSprites), { kind: "ignore" });
});

test("a clocked-out NPC is removed from the map", () => {
  assert.deepEqual(decideNpcUpdate({ npc: projected({ active: false }) }, hasSprites), {
    kind: "remove",
    npcId: "n1",
  });
});

test("an NPC that lost its seat is removed from the map too", () => {
  assert.deepEqual(
    decideNpcUpdate({ npc: projected({ positionX: null, positionY: null }) }, hasSprites),
    { kind: "remove", npcId: "n1" },
  );
});

test("clocked in without a sprite: draw a new one", () => {
  assert.deepEqual(decideNpcUpdate({ npc: projected() }, noSprites), {
    kind: "spawn",
    npc: {
      id: "n1",
      name: "소피",
      positionX: 3,
      positionY: 4,
      direction: "down",
      appearance: { body: "light" },
    },
  });
});

test("clocked in with a sprite: update it", () => {
  assert.deepEqual(decideNpcUpdate({ npc: projected({ name: "새이름" }) }, hasSprites), {
    kind: "update",
    npcId: "n1",
    fields: { name: "새이름", direction: "down", appearance: { body: "light" } },
  });
});

test("an empty payload is ignored", () => {
  assert.deepEqual(decideNpcUpdate(null, hasSprites), { kind: "ignore" });
  assert.deepEqual(decideNpcUpdate({}, hasSprites), { kind: "ignore" });
});
