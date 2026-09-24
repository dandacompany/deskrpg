import test from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { buildPublishingAsset } from "./publishing-assets";
import { addPublishingArchitecture } from "./publishing-scene";
import type { MapSnapshot } from "./bridge";
import { disposeTree } from "./dispose-tree";

test("books laid flat on the new releases display do not overlap the page front with the cover box", () => {
  const root = buildPublishingAsset("pub-newbook-display");
  try {
    const pages = root.children.filter(
      (o) =>
        o instanceof T.Mesh &&
        (o.material as T.MeshStandardMaterial).color.getHexString() === "f2ead8" &&
        Math.abs(o.position.z - 0.239) < 0.00001 &&
        o.position.y > 0.84,
    );
    assert.equal(pages.length, 3);
    for (const page of pages) {
      const p = new T.Box3().setFromObject(page);
      for (const other of root.children) {
        if (other === page || !(other instanceof T.Mesh)) continue;
        const b = new T.Box3().setFromObject(other);
        const overlap = Math.min(p.max.y, b.max.y) - Math.max(p.min.y, b.min.y);
        if (overlap > 0.001 && p.min.x < b.max.x && p.max.x > b.min.x)
          assert.ok(Math.abs(p.max.z - b.max.z) > 0.001, "속지와 표지 앞면 중첩");
      }
    }
  } finally {
    disposeTree(root);
  }
});

test("publisher baseboards protrude beyond both wall faces and do not form a coplanar surface", () => {
  const root = new T.Group();
  try {
    const scene = addPublishingArchitecture(root, {
      cols: 30,
      rows: 26,
      objects: [],
    } as unknown as MapSnapshot);
    for (const host of scene.userData.meetingWalls as T.Group[]) {
      const wall = new T.Box3().setFromObject(host.children[0]);
      const trim = new T.Box3().setFromObject(host.children[2]);
      const axis = wall.max.x - wall.min.x < wall.max.z - wall.min.z ? "x" : "z";
      assert.ok(wall.min[axis] - trim.min[axis] > 0.01);
      assert.ok(trim.max[axis] - wall.max[axis] > 0.01);
    }
  } finally {
    disposeTree(root);
  }
});
