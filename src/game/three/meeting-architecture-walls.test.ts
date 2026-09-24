import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { addCreativeStudioArchitecture } from "./creative-studio-architecture";
import { addCreativeStudioScene, finalizeStudioScene } from "./creative-studio-renderer";
import { buildOfficeEnvironment } from "./office-environments";
import { tiledSnapshot } from "./tiled-preview";
import { furnitureSeats, seatAt } from "./seating";
import { OfficeRenderer } from "./office-renderer";
import { batchCoplanarGlass, batchStaticFurniture } from "./static-batching";
import { MeetingWallOcclusion } from "./meeting-wall-occlusion";
import { addPublishingArchitecture } from "./publishing-scene";
import { addTradingArchitecture } from "./trading-scene";
import type { MapSnapshot } from "./bridge";

test("after loading the full real studio GLTF, walls hiding seated characters from a low eye line become transparent", async () => {
  const root = new T.Group();
  const map = tiledSnapshot(buildOfficeEnvironment("agency"));
  const scene = addCreativeStudioScene(root, map, {
    load: async (url) => {
      const bytes = await readFile(`public${url}`);
      const loader = new GLTFLoader();
      loader.register(() => ({
        name: "EXT_texture_webp",
        loadTexture: async () => new T.Texture(),
      }));
      return (
        await loader.parseAsync(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          "",
        )
      ).scene;
    },
    loadTexture: async () => new T.Texture(),
  })!;
  await scene.userData.assetReady;
  scene.updateMatrixWorld(true);
  const occlusion = new MeetingWallOcclusion();
  occlusion.enter(scene.userData.meetingWalls);
  for (const camera of [new T.Vector3(37, 1.3, 20), new T.Vector3(50, 1.3, 5)]) {
    const target = new T.Vector3(37, 1.2, 5);
    const ray = new T.Raycaster(
      camera,
      target.clone().sub(camera).normalize(),
      0,
      camera.distanceTo(target),
    );
    const wallHits = ray.intersectObjects(scene.userData.meetingWalls, true);
    assert.ok(wallHits.length > 0, `회의실 경계 관통: ${camera.toArray()}`);
    occlusion.update(camera, [target]);
    for (const hit of wallHits) {
      assert.ok(hit.object instanceof T.Mesh);
      for (const material of Array.isArray(hit.object.material)
        ? hit.object.material
        : [hit.object.material]) {
        assert.ok(
          material.transparent && material.opacity <= 0.12,
          `벽이 불투명: ${hit.object.parent?.name}`,
        );
      }
    }
  }
  // The collision coordinates checked in the browser differ from the actual seated model position by about 0.85m.
  const actor = { x: 1135.530705, y: 111.77254, walking: false };
  const seats = furnitureSeats(map.objects);
  const pose = seatAt(seats, actor.x / 32, actor.y / 32, false)!;
  assert.equal(pose.x, 36 + 1 / 3);
  const renderer = Object.assign(Object.create(OfficeRenderer.prototype), {
    lastActors: [actor],
    seats,
    meetingSpace: { bounds: { x: 32, y: 0, width: 10, height: 11 } },
  }) as { meetingOcclusionTargets(): T.Vector3[] };
  const targets = renderer.meetingOcclusionTargets();
  const camera = new T.Vector3(61.5932573, 5.0902789, -11.3680473);
  occlusion.update(camera, targets);
  const actualTarget = new T.Vector3(pose.x, (pose.elevation ?? 0) + 1.2, pose.z);
  const ray = new T.Raycaster(
    camera,
    actualTarget.clone().sub(camera).normalize(),
    0,
    camera.distanceTo(actualTarget),
  );
  const eastWall = scene.getObjectByName("meeting-wall-plane:x:41.8800")!;
  const eastHits = ray.intersectObject(eastWall, true);
  assert.ok(eastHits.length > 0, "실제 착석 캐릭터 시선은 흰 동벽을 관통한다");
  for (const hit of eastHits) {
    assert.ok(hit.object instanceof T.Mesh);
    for (const material of Array.isArray(hit.object.material)
      ? hit.object.material
      : [hit.object.material])
      assert.ok(
        material.transparent && material.opacity <= 0.12,
        "착석 시각 앵커 앞 동벽도 투명화해야 한다",
      );
  }
  occlusion.dispose();
});

test("meeting walls can still be occluded and restored individually after readiness and static batching", () => {
  const root = new T.Group();
  const material = new T.MeshStandardMaterial();
  const walls = [0, 8].map((x) => {
    const host = new T.Group();
    host.userData.meetingWall = true;
    host.userData.dynamicAsset = true;
    const mesh = new T.Mesh(new T.BoxGeometry(3, 3, 0.2), material);
    mesh.position.set(x, 1, 3);
    host.add(mesh);
    root.add(host);
    return mesh;
  });
  finalizeStudioScene(root);
  batchStaticFurniture(root, true);
  assert.ok(walls.every((wall) => wall.parent?.parent === root));
  const occlusion = new MeetingWallOcclusion();
  occlusion.enter(walls);
  occlusion.update(new T.Vector3(0, 1, 7), [new T.Vector3(0, 1, 0)]);
  assert.equal(walls[0].material.opacity, 0.12);
  assert.equal(walls[1].material, material);
  occlusion.dispose();
  assert.equal(walls[0].material, material);
});

test("meeting glass walls in the same plane are kept so they restore separately on rotation too", () => {
  const root = new T.Group();
  const material = new T.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
  const walls = [0, 8].map((x) => {
    const mesh = new T.Mesh(new T.BoxGeometry(3, 3, 0.1), material);
    mesh.position.x = x;
    mesh.userData.meetingWall = true;
    mesh.userData.staticGlass = true;
    root.add(mesh);
    return mesh;
  });
  batchCoplanarGlass(root);
  assert.ok(walls.every((wall) => wall.parent === root));
});

test("late batching during an active meeting does not merge the temporary occlusion materials", () => {
  const root = new T.Group();
  root.userData.meetingWall = true;
  const material = new T.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
  const walls = [0, 3].map((x) => {
    const mesh = new T.Mesh(new T.BoxGeometry(3, 3, 0.1), material);
    mesh.position.set(x, 1, 3);
    mesh.userData.staticGlass = true;
    root.add(mesh);
    return mesh;
  });
  const occlusion = new MeetingWallOcclusion();
  occlusion.enter([root]);
  occlusion.update(new T.Vector3(0, 1, 7), [new T.Vector3(0, 1, 0), new T.Vector3(3, 1, 0)]);
  assert.ok(walls.every((wall) => wall.material !== material));
  batchCoplanarGlass(root);
  occlusion.enter([root]);
  assert.ok(walls.every((wall) => wall.parent === root && wall.material === material));
  occlusion.dispose();
});

test("after the studio's async architecture load, the wall list remains and floors and plinths are excluded", async () => {
  const root = new T.Group();
  const shell = addCreativeStudioArchitecture(root, 42, 26, {
    load: async () => {
      throw Error("offline fixture");
    },
    loadTexture: async () => {
      throw Error("offline fixture");
    },
  });
  const walls = shell.userData.meetingWalls as T.Object3D[];
  assert.ok(walls?.length > 0);
  assert.ok(!walls.includes(shell.getObjectByName("continuous-pale-oak-floor")!));
  assert.ok(walls.every((wall) => !wall.name.includes("plinth")));
  await shell.userData.assetReady;
  finalizeStudioScene(root);
  assert.ok(walls.every((wall) => wall.parent === shell && wall.children.length > 0));
  assert.ok(walls.some((wall) => wall.getObjectByName("meeting-open-door")));
});

test("meeting-capable studios also keep within the architecture draw call budget with per-wall-plane batching", async (t) => {
  const root = new T.Group();
  const shell = addCreativeStudioArchitecture(root, 42, 26, {
    load: async (url) => {
      const bytes = await readFile(`public${url}`);
      const loader = new GLTFLoader();
      loader.register(() => ({
        name: "EXT_texture_webp",
        loadTexture: async () => new T.Texture(),
      }));
      return (
        await loader.parseAsync(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          "",
        )
      ).scene;
    },
    loadTexture: async () => new T.Texture(),
  });
  const occlusion = new MeetingWallOcclusion();
  occlusion.enter(shell.userData.meetingWalls);
  await shell.userData.assetReady;
  finalizeStudioScene(root);
  let calls = 0;
  shell.traverse((object) => {
    if (object instanceof T.Mesh)
      calls += Array.isArray(object.material) ? object.material.length : 1;
  });
  assert.ok(calls < 35, `회의 건축 draw calls: ${calls}`);
  t.diagnostic(`회의 건축 draw calls: ${calls}`);
  const walls = shell.userData.meetingWalls as T.Object3D[];
  assert.ok(walls.every((wall) => wall.parent === shell && wall.children.length > 0));
  // Meshes replaced by loading and internal batching must be re-registered to apply to an active meeting too.
  occlusion.enter(walls);
  const originals = new Map<T.Mesh, T.Material | T.Material[]>();
  shell.traverse((object) => {
    if (object instanceof T.Mesh) originals.set(object, object.material);
  });
  occlusion.update(new T.Vector3(37, 1.5, 15), [new T.Vector3(37, 1.5, 5)]);
  assert.ok([...originals].some(([mesh, material]) => mesh.material !== material));
  const floor = shell.getObjectByName("continuous-pale-oak-floor") as T.Mesh;
  assert.equal(floor.material, originals.get(floor));
  occlusion.update(new T.Vector3(37, 1.5, 6), [new T.Vector3(37, 1.5, 5)]);
  assert.ok([...originals].every(([mesh, material]) => mesh.material === material));
  occlusion.dispose();
});

test("publisher and trading candidates include only dedicated walls and preserve rugs and slabs", (t) => {
  t.mock.method(
    T.TextureLoader.prototype,
    "load",
    (_url: string, onLoad?: (texture: T.Texture) => void) => {
      const texture = new T.Texture();
      onLoad?.(texture);
      return texture;
    },
  );
  const map: MapSnapshot = {
    cols: 30,
    rows: 22,
    floor: Array.from({ length: 22 }, () => Array(30).fill(1)),
    walls: [],
    blocked: [],
    tiled: false,
    objects: [{ id: "lounge", type: "studio_sofa", col: 10, row: 10 }],
  };
  for (const build of [addPublishingArchitecture, addTradingArchitecture]) {
    const root = new T.Group();
    const scene = build(root, map);
    const walls = scene.userData.meetingWalls as T.Object3D[];
    assert.ok(walls.length > 0);
    assert.ok(!walls.includes(scene));
    const wallMeshes = new Set<T.Object3D>();
    for (const wall of walls) wall.traverse((mesh) => wallMeshes.add(mesh));
    let floors = 0;
    scene.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      const bounds = new T.Box3().setFromObject(object);
      if (bounds.max.y < 0.05) {
        floors++;
        assert.ok(!wallMeshes.has(object));
      }
    });
    assert.ok(floors > 0);
    finalizeStudioScene(root);
    assert.ok(walls.every((wall) => wall.parent === scene));
  }
});
