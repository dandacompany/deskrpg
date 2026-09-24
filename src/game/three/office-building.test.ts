import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";

import { addOfficeBuildingLights, buildOfficeBuilding } from "./office-building";

test("the headquarters model stands on the ground, and the trees can be turned off (for the mark)", () => {
  const withTrees = buildOfficeBuilding();
  const bare = buildOfficeBuilding({ trees: false });
  assert.ok(withTrees.children.length > bare.children.length, "나무가 빠지지 않았다");
  const box = new T.Box3().setFromObject(bare);
  assert.ok(box.min.y >= -0.05, "모델이 지면 아래로 내려갔다");
  assert.ok(box.max.y > 2.5, "탑이 너무 낮다");
  // The mark must fit within a square — if too wide, it smears at 16px.
  assert.ok(box.max.x - box.min.x < 3.4, "나무를 뺀 폭이 너무 넓다");
});

test("the screen and the mark use the same lighting", () => {
  const scene = new T.Scene();
  const sun = addOfficeBuildingLights(scene);
  assert.equal(sun.castShadow, true);
  assert.equal(scene.children.filter((c) => c instanceof T.Light).length, 2);
});
