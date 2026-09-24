import test from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { FurnitureHighlight } from "./furniture-highlight";

const close = (a: number[], b: number[]) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-8));
test("the hover shape follows the rotation, translation and parent transform of the hidden seat proxy", () => {
  const scene = new T.Scene(),
    world = new T.Group(),
    owner = new T.Group();
  scene.add(world);
  world.add(owner);
  world.position.set(4, 0, -2);
  world.rotation.y = 0.3;
  owner.position.set(2, 0.1, 5);
  owner.rotation.y = Math.PI / 2;
  const chair = new T.Mesh(new T.BoxGeometry(0.8, 1, 0.7), new T.MeshStandardMaterial());
  owner.add(chair);
  chair.position.set(0.1, 0.5, -0.2);
  chair.visible = false;
  chair.userData.seatPickProxy = true;
  const highlight = new FurnitureHighlight(scene);
  highlight.highlight(owner);
  scene.updateMatrixWorld(true);
  assert.equal(highlight.group.children.length, 1);
  const overlay = highlight.group.children[0] as T.Mesh;
  close(overlay.matrixWorld.toArray(), chair.matrixWorld.toArray());
  assert.equal(overlay.geometry, chair.geometry);
  owner.position.x += 2;
  highlight.highlight(owner);
  scene.updateMatrixWorld(true);
  close(overlay.matrixWorld.toArray(), chair.matrixWorld.toArray());
  highlight.dispose();
  chair.geometry.dispose();
  (chair.material as T.Material).dispose();
});
test("a composite sofa highlights every cushion without changing the original material or shape lifetime", () => {
  const sofa = new T.Group(),
    material = new T.MeshStandardMaterial({ color: "#526f59" }),
    geometry = new T.BoxGeometry();
  for (let i = 0; i < 3; i++) {
    const mesh = new T.Mesh(geometry, material);
    mesh.position.x = i;
    sofa.add(mesh);
  }
  const hidden = new T.Mesh(geometry, material);
  hidden.visible = false;
  sofa.add(hidden);
  const before = material.color.getHex(),
    highlight = new FurnitureHighlight();
  let geometryDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  highlight.highlight(sofa);
  assert.equal(highlight.group.children.length, 3);
  for (const item of highlight.group.children) {
    const overlay = item as T.Mesh,
      m = overlay.material as T.MeshBasicMaterial;
    assert.notEqual(m, material);
    assert.equal(m.depthTest, true);
    assert.equal(m.depthWrite, false);
    assert.equal(m.polygonOffset, true);
    const hits: T.Intersection[] = [];
    overlay.raycast(new T.Raycaster(), hits);
    assert.equal(hits.length, 0);
  }
  assert.equal(material.color.getHex(), before);
  assert.equal(material.opacity, 1);
  highlight.highlight(null);
  assert.equal(highlight.group.children.length, 0);
  highlight.dispose();
  highlight.dispose();
  assert.equal(geometryDisposals, 0);
  geometry.dispose();
  material.dispose();
});
test("asset swaps and hidden parents leave no stale hover shape", () => {
  const owner = new T.Group(),
    a = new T.Mesh(new T.BoxGeometry(), new T.MeshBasicMaterial());
  owner.add(a);
  const highlight = new FurnitureHighlight();
  highlight.highlight(owner);
  owner.remove(a);
  highlight.highlight(owner);
  assert.equal(highlight.group.visible, false);
  owner.add(a);
  owner.visible = false;
  highlight.highlight(owner);
  assert.equal(highlight.group.children.length, 0);
  highlight.dispose();
  a.geometry.dispose();
  (a.material as T.Material).dispose();
});
