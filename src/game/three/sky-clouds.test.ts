import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";

import { addCloudLights, buildCloud, cloudPuffs } from "./sky-clouds";

test("a cloud spreads several lumps horizontally to make a cumulus silhouette", () => {
  for (const variant of [0, 1, 2] as const) {
    const puffs = cloudPuffs(variant);
    assert.ok(puffs.length >= 5, "덩어리가 적으면 타원 두 개처럼 보인다");
    const box = new T.Box3().setFromObject(buildCloud(variant));
    const width = box.max.x - box.min.x;
    const height = box.max.y - box.min.y;
    assert.ok(width / height > 1.8, `가로로 퍼지지 않았다(${width / height})`);
  }
});

test("the same seed gives the same cloud — the screen and the baking script do not drift apart", () => {
  assert.deepEqual(cloudPuffs(1), cloudPuffs(1));
  assert.notDeepEqual(cloudPuffs(0), cloudPuffs(2));
});

test("cloud lighting is two lights: white from above and sky blue from below", () => {
  const scene = new T.Scene();
  addCloudLights(scene);
  assert.equal(scene.children.filter((c) => c instanceof T.Light).length, 2);
});
