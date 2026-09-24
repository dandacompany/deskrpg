import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createGltfActor, type ActorAssetLoader } from "./gltf-actor";
import { OFFICE_LOOKS } from "./office-looks";
import { COMMUTE_WALK_STRIDES, MINIATURE_WALK_STRIDE } from "./commute-walk";
const look = OFFICE_LOOKS.find((item) => item.id === "office-eun")!;

test("homepage phase follows scaled distance and survives late loading and pause", async () => {
  const source = asset();
  source.animations
    .find((clip) => clip.name === "walk")!
    .tracks.push(new T.NumberKeyframeTrack("body.position[x]", [0, 1], [0, 1]));
  let finish!: (value: GLTF) => void;
  const actor = createGltfActor(
    "distance",
    look,
    0,
    "distance",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { distanceWalk: true },
  );
  actor.root.scale.setScalar(1.15);
  actor.rig.rotation.y = 1.23;
  const distance = (MINIATURE_WALK_STRIDE * 1.15) / 4;
  actor.update(0, true, "walking", false, { cumulativeDistance: distance });
  await Promise.resolve();
  finish(source);
  await actor.ready;
  actor.update(500, true, "walking", false, { cumulativeDistance: distance });
  const body = actor.rig.getObjectByName("body")!;
  assert.ok(Math.abs(body.position.x - 0.25) < 1e-6);
  assert.equal(actor.rig.rotation.y, 1.23);
  actor.update(900, true, "walking", false, { cumulativeDistance: distance });
  assert.ok(Math.abs(body.position.x - 0.25) < 1e-6);
  actor.update(901, true, "walking", false, {
    cumulativeDistance: distance + (COMMUTE_WALK_STRIDES[look.id] * 1.15) / 4,
  });
  assert.ok(Math.abs(body.position.x - 0.5) < 1e-6);
  actor.dispose();
});

test("homepage missing walk and load failures keep distance-driven fallback visible", async () => {
  for (const failure of [false, true]) {
    const source = asset();
    source.animations = source.animations.filter((clip) => clip.name !== "walk");
    const actor = createGltfActor(
      "fallback",
      look,
      0,
      `fallback-${failure}`,
      async () => {
        if (failure) throw new Error("expected");
        return source;
      },
      { distanceWalk: true },
    );
    await actor.ready;
    actor.update(1, true, "walking", false, { cumulativeDistance: 0 });
    const visual = actor.rig.children[0];
    const leg = visual.children.find(
      (child) => Math.abs(child.position.x + 0.105) < 1e-6 && child.position.y === 0.89,
    )!;
    assert.ok(visual.visible);
    assert.equal(leg.rotation.x, 0);
    actor.update(2, true, "walking", false, { cumulativeDistance: MINIATURE_WALK_STRIDE / 4 });
    assert.ok(Math.abs(leg.rotation.x - 0.32) < 1e-9);
    actor.update(100, true, "walking", false, { cumulativeDistance: MINIATURE_WALK_STRIDE / 4 });
    assert.ok(Math.abs(leg.rotation.x - 0.32) < 1e-9);
    if (!failure) assert.equal(actor.rig.children[1].visible, false);
    actor.dispose();
  }
});

test("homepage retained fallback and a late model are released exactly once", async () => {
  let finish!: (value: GLTF) => void;
  const source = asset();
  let sourceDisposals = 0,
    fallbackDisposals = 0;
  (source.scene.children[0] as T.Mesh).geometry.addEventListener(
    "dispose",
    () => sourceDisposals++,
  );
  const actor = createGltfActor(
    "late",
    look,
    0,
    "late-opt-in",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { distanceWalk: true },
  );
  let geometry: T.BufferGeometry | undefined;
  actor.rig.traverse((node) => {
    if (node instanceof T.Mesh) geometry ??= node.geometry;
  });
  geometry!.addEventListener("dispose", () => fallbackDisposals++);
  await Promise.resolve();
  actor.dispose();
  actor.dispose();
  finish(source);
  assert.equal(await actor.ready, false);
  assert.equal(fallbackDisposals, 1);
  assert.equal(sourceDisposals, 1);
  assert.equal(actor.root.children.length, 0);
});
function asset() {
  const scene = new T.Group();
  const body = new T.Mesh(new T.BoxGeometry(0.4, 1.9, 0.3), new T.MeshStandardMaterial());
  body.name = "body";
  scene.add(body);
  const animations = [
    ["idle", 0],
    ["walk", 0.1],
    ["sit", -0.6],
  ].map(
    ([name, y]) =>
      new T.AnimationClip(String(name), 1, [
        new T.NumberKeyframeTrack("body.position[y]", [0, 1], [Number(y), Number(y)]),
      ]),
  );
  return { scene, animations } as GLTF;
}
test("cached actors own their meshes and animation state, and preserve seated root height", async () => {
  const source = asset();
  let calls = 0;
  const loader: ActorAssetLoader = async () => {
    calls++;
    return source;
  };
  const a = createGltfActor("a", look, 0, "model", loader);
  const b = createGltfActor("b", look, 1, "model", loader);
  assert.deepEqual(await Promise.all([a.ready, b.ready]), [true, true]);
  assert.equal(calls, 1);
  for (let i = 0; i < 10; i++) {
    a.update(i * 0.1, false, "idle", true);
    b.update(i * 0.1, true, "walking", false);
  }
  const am = a.rig.getObjectByName("body") as T.Mesh;
  const bm = b.rig.getObjectByName("body") as T.Mesh;
  assert.ok(Math.abs(am.position.y + 0.6) < 0.00001);
  assert.ok(Math.abs(bm.position.y - 0.1) < 0.00001);
  assert.equal(a.rig.position.y, 0);
  assert.notEqual(am.geometry, bm.geometry);
  assert.notEqual(am.material, bm.material);
  let disposed = 0;
  bm.geometry.addEventListener("dispose", () => disposed++);
  a.dispose();
  assert.equal(disposed, 0);
  b.update(1, true, "walking", false);
  assert.ok(Math.abs(bm.position.y - 0.1) < 0.00001);
  b.dispose();
  assert.equal(disposed, 1);
});
test("dispose while loading cannot attach a late model, and releases source resources", async () => {
  const source = asset();
  let finish!: (value: GLTF) => void;
  let disposed = 0;
  (source.scene.children[0] as T.Mesh).geometry.addEventListener("dispose", () => disposed++);
  const loader: ActorAssetLoader = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const actor = createGltfActor("a", look, 0, "model", loader);
  await Promise.resolve();
  actor.dispose();
  actor.dispose();
  finish(source);
  assert.equal(await actor.ready, false);
  assert.equal(actor.root.children.length, 0);
  assert.equal(disposed, 1);
});
test("load failure leaves a usable fallback and reports failure without throwing", async () => {
  const actor = createGltfActor("a", look, 0, "missing", async () => {
    throw new Error("missing");
  });
  assert.equal(await actor.ready, false);
  assert.equal(actor.root.userData.assetStatus, "error");
  actor.update(1, true, "walking", false);
  assert.ok(actor.rig.children.length > 0);
  actor.dispose();
});

test("scene disposal invokes pending actor cleanup and removes its hook", async () => {
  const { disposeTree } = await import("./office-renderer");
  let finish!: (value: GLTF) => void;
  const actor = createGltfActor(
    "a",
    look,
    0,
    "pending",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const scene = new T.Scene();
  scene.add(actor.root);
  await Promise.resolve();
  disposeTree(scene);
  assert.equal(actor.root.userData.assetStatus, "disposed");
  assert.equal(actor.root.userData.disposeActor, undefined);
  finish(asset());
  assert.equal(await actor.ready, false);
  assert.equal(scene.children.length, 0);
});

test("late model loading preserves meeting-seat facing assigned by its caller", async () => {
  for (const yaw of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    const actor = createGltfActor("seat", look, 0, `seat-${yaw}`, async () => asset());
    actor.rig.rotation.y = yaw;
    assert.equal(await actor.ready, true);
    assert.equal(actor.rig.rotation.y, yaw);
    actor.update(0, false, "idle", true);
    assert.equal(actor.rig.rotation.y, yaw);
    actor.dispose();
  }
});

test("both supplied skeletons retain gestures without accumulating or changing seated positions", async () => {
  for (const names of [
    ["Head", "LeftArm", "RightArm", "RightForeArm"],
    ["Head", "UpperArm.L", "UpperArm.R", "LowerArm.R"],
  ]) {
    const source = asset();
    const bones = names.map((name) => {
      const bone = new T.Bone();
      bone.name = name;
      bone.position.set(0.1, 0.9, 0.05);
      bone.rotation.set(0.1, 0.2, 0.3);
      source.scene.add(bone);
      return bone;
    });
    const rest = bones.map((bone) => bone.quaternion.clone());
    // Deliberately leave arm joints unanimated, and let the mixer control the head.
    const sampled = new T.Quaternion().setFromEuler(new T.Euler(0.15, -0.1, 0.04));
    for (const clip of source.animations)
      clip.tracks.push(
        new T.QuaternionKeyframeTrack(
          "Head.quaternion",
          [0, 1],
          [...sampled.toArray(), ...sampled.toArray()],
        ),
      );
    const actor = createGltfActor("gestures", look, 0, names[1], async () => source);
    assert.equal(await actor.ready, true);
    actor.root.position.set(2, 0.1, 4);
    actor.rig.rotation.y = Math.PI / 2;
    const loaded = names.map((name) => actor.rig.getObjectByName(name)!);
    actor.update(4, false, "thinking", true);
    const thinking = loaded.map((bone) => bone.quaternion.clone());
    assert.ok(thinking[0].angleTo(sampled) > 0.01);
    assert.ok(thinking[2].angleTo(rest[2]) > 0.1);
    for (let frame = 0; frame < 100; frame++) actor.update(4, false, "thinking", true);
    loaded.forEach((bone, index) => {
      assert.ok(bone.quaternion.angleTo(thinking[index]) < 0.000001, names[index]);
      assert.deepEqual(bone.position.toArray(), [0.1, 0.9, 0.05]);
    });
    actor.update(4, false, "streaming", true);
    assert.ok(loaded[3].quaternion.angleTo(thinking[3]) > 0.1);
    actor.update(4, true, "walking", false);
    assert.ok(loaded[0].quaternion.angleTo(sampled) < 0.000001);
    for (let index = 1; index < loaded.length; index++)
      assert.ok(loaded[index].quaternion.angleTo(rest[index]) < 0.000001, names[index]);
    assert.deepEqual(actor.root.position.toArray(), [2, 0.1, 4]);
    assert.equal(actor.rig.rotation.y, Math.PI / 2);
    actor.dispose();
  }
});

test("glTF runs even without a run clip — plays the walk clip faster to match the movement speed and leans forward", async () => {
  const actor = createGltfActor("run", look, 0, "run", async () => asset());
  await actor.ready;
  actor.update(0, true, "idle", false, undefined, { running: true, cadence: 2 });
  actor.update(0.1, true, "idle", false, undefined, { running: true, cadence: 2 });
  // Once the asset is loaded, the visible child of the rig is a single model.
  const model = actor.rig.children.find((c) => c.visible);
  assert.ok(model, "보이는 모델이 없습니다");
  assert.ok(model.rotation.x > 0.1, `기울기 ${model.rotation.x}`);
  // Stands straight when stopped.
  actor.update(0.2, false, "idle", false, undefined, { running: false, cadence: 1 });
  assert.equal(model.rotation.x, 0);
  assert.equal(actor.rig.position.y, 0, "멈췄는데 반동이 남았습니다");
});
