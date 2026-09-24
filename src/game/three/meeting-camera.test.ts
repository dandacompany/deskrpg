import assert from "node:assert/strict";
import { test } from "node:test";
import * as T from "three";
import { MeetingCamera } from "./meeting-camera";
import { OfficeRenderer } from "./office-renderer";
import { MeetingWallOcclusion } from "./meeting-wall-occlusion";
import { FurnitureHighlight } from "./furniture-highlight";
import { BoardArrival } from "./office-kanban";
import type { MeetingSpace } from "../meeting-space";
import type { ActorSnapshot, MapSnapshot } from "./bridge";

const space: MeetingSpace = {
  id: "room",
  version: 1,
  bounds: { x: 10, y: 5, width: 8, height: 6 },
  entry: { x: 10, y: 7 },
  seatIds: [],
  standingPositions: [],
  wallObjectIds: [],
  wallTileKeys: [],
};
const actors: ActorSnapshot[] = [
  {
    id: "socket",
    userId: "user",
    kind: "player",
    name: "Same",
    x: 12 * 32,
    y: 7 * 32,
    direction: "down",
    walking: false,
  },
  {
    id: "npc",
    kind: "npc",
    name: "Same",
    x: 16 * 32,
    y: 9 * 32,
    direction: "down",
    walking: false,
    phase: "streaming",
  },
];
function setup(reducedMotion = true) {
  const camera = new T.PerspectiveCamera(38, 2, 0.1, 250);
  camera.position.set(20, 20, 30);
  const controls = {
    target: new T.Vector3(),
    enablePan: true,
    enableZoom: true,
    enableDamping: true,
    minDistance: 8,
    maxDistance: 85,
    mouseButtons: { LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.PAN, RIGHT: T.MOUSE.ROTATE },
    touches: { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_ROTATE },
  };
  const meeting = new MeetingCamera(camera, controls, { reducedMotion });
  meeting.setViewport(1200, 600, 350);
  return { camera, controls, meeting };
}
test("meeting locks navigation, restores camera and controls, and can reenter", () => {
  const { camera, controls, meeting } = setup();
  const original = camera.position.clone();
  meeting.enter(space);
  meeting.update(1, actors);
  assert.equal(controls.enablePan, false);
  assert.equal(controls.enableZoom, false);
  assert.equal(controls.touches.ONE, T.TOUCH.ROTATE);
  assert.equal(controls.mouseButtons.LEFT, T.MOUSE.ROTATE);
  // The target point is the screen center of the participant framing, not the room center — it only needs to be inside the room.
  assert.ok(controls.target.x > 10 && controls.target.x < 18, `목표 x ${controls.target.x}`);
  meeting.exit();
  assert.equal(controls.enablePan, true);
  assert.equal(controls.enableZoom, true);
  assert.ok(camera.position.equals(original));
  assert.equal(camera.view?.enabled ?? false, false);
  meeting.enter(space);
  meeting.dispose();
  assert.equal(controls.enablePan, true);
});

function rebuildingRenderer() {
  const { camera, controls, meeting } = setup();
  const renderer = Object.create(OfficeRenderer.prototype) as OfficeRenderer;
  let assetVersion = 1;
  let map: MapSnapshot = {
    cols: 20,
    rows: 12,
    floor: [],
    walls: [],
    blocked: [],
    tiled: false,
    objects: [{ id: "meeting-wall", type: "room_wall_h", col: 11, row: 8 }],
    meetingSpace: { ...space, wallObjectIds: ["meeting-wall"] },
  };
  const world = new T.Group();
  const scene = new T.Scene();
  scene.add(world);
  const meetingWalls = new MeetingWallOcclusion();
  Object.assign(renderer, {
    camera,
    controls: { ...controls, update() {} },
    meetingCamera: meeting,
    meetingWalls,
    furnitureHighlight: new FurnitureHighlight(),
    boardArrival: new BoardArrival(),
    meetingWallObjects: [],
    // The camera asks the renderer for each actor's actual appearance.
    actors: new Map(),
    world,
    scene,
    theme: "office",
    sun: new T.DirectionalLight(),
    fill: new T.DirectionalLight(),
    sky: new T.HemisphereLight(),
    renderer: { setClearColor() {}, shadowMap: { type: T.PCFShadowMap } },
    following: true,
    overviewDimensions: { cols: 20, rows: 12 },
    host: { clientWidth: 1200, clientHeight: 600, dataset: {} },
    cursor: { visible: true },
    meetingRightInset: 0,
    bridge: { map: () => map, mapKey: () => `asset-${assetVersion}` },
    setHoveredSeat() {},
    setSelectedSeat() {},
    stopFollowing() {},
  });
  return {
    renderer,
    camera,
    controls,
    meeting,
    meetingWalls,
    world,
    refresh(next = map) {
      map = next;
      assetVersion++;
      // The real tick uses the same buildMap path. The entry method runs that path without WebGL.
      renderer.enterMeeting();
    },
    map: () => map,
    rebuild(next: MapSnapshot) {
      (renderer as unknown as { buildMap(map: MapSnapshot): void }).buildMap(next);
    },
  };
}

test("only walls whose ID, coordinates and type match the extension marker are omitted or drawn as vertical boundaries", () => {
  const fixture = rebuildingRenderer();
  const objects = [
    { id: "hidden", type: "room_wall_h", col: 2, row: 2 },
    { id: "vertical", type: "room_wall_h", col: 4, row: 2 },
    { id: "moved", type: "room_wall_h", col: 6, row: 2 },
    { id: "user", type: "room_wall_h", col: 8, row: 2 },
    { id: "corner", type: "room_wall_h", col: 10, row: 2 },
  ];
  const markers: NonNullable<MeetingSpace["generatedAnnexWalls"]> = [
    { id: "hidden", type: "room_wall_h", col: 2, row: 2, display: "hidden" },
    { id: "vertical", type: "room_wall_h", col: 4, row: 2, display: "vertical" },
    { id: "moved", type: "room_wall_h", col: 5, row: 2, display: "hidden" },
    { id: "user", type: "room_wall_v" as "room_wall_h", col: 8, row: 2, display: "hidden" },
    { id: "corner", type: "room_wall_h", col: 10, row: 2, display: "corner" },
  ];
  const map = {
    ...fixture.map(),
    objects,
    meetingSpace: { ...space, generatedAnnexWalls: markers },
  };
  const before = structuredClone(map);
  fixture.rebuild(map);
  const candidates = (fixture.renderer as unknown as { meetingWallObjects: T.Object3D[] })
    .meetingWallObjects;
  assert.equal(candidates.length, 4);
  const sizes = candidates.map((candidate) =>
    new T.Box3().setFromObject(candidate).getSize(new T.Vector3()),
  );
  assert.ok(sizes[0].z > sizes[0].x);
  assert.ok(sizes[1].x > sizes[1].z);
  assert.ok(sizes[2].x > sizes[2].z);
  assert.ok(sizes[3].x >= 1 && sizes[3].z >= 1);
  assert.deepEqual(map, before);
  fixture.rebuild({ ...map, meetingSpace: space });
  assert.equal(
    (fixture.renderer as unknown as { meetingWallObjects: T.Object3D[] }).meetingWallObjects.length,
    5,
  );
});

for (const environment of ["executive", "tech", undefined]) {
  test(`renderer registers all indoor walls, including ${environment ?? "legacy"} shell occluders`, () => {
    const fixture = rebuildingRenderer();
    const map: MapSnapshot = {
      ...fixture.map(),
      environment,
      floor: [[0, 0, 0, 0, 0, 2, 7]],
      walls: [],
      objects: [
        { id: "distant-wall", type: "room_wall_h", col: 3, row: 3 },
        { id: "distant-cubicle", type: "cubicle_wall", col: 8, row: 3 },
        { id: "floor-rug", type: "rug", col: 5, row: 5 },
      ],
      meetingSpace: { ...space, wallObjectIds: [], wallTileKeys: [] },
    };
    fixture.rebuild(map);
    const candidates = (fixture.renderer as unknown as { meetingWallObjects: T.Object3D[] })
      .meetingWallObjects;
    const meshes = new Set<T.Mesh>();
    for (const candidate of candidates)
      candidate.traverse((child) => {
        if (child instanceof T.Mesh) meshes.add(child);
      });
    const points = [
      [new T.Vector3(5.5, 0.75, -2), new T.Vector3(5.5, 0.75, 2)],
      [new T.Vector3(3.5, 1, 2), new T.Vector3(3.5, 1, 5)],
    ];
    if (environment) points.push([new T.Vector3(-2, 0.6, 6), new T.Vector3(4, 0.6, 6)]);
    fixture.world.updateMatrixWorld(true);
    const originals = new Map([...meshes].map((mesh) => [mesh, mesh.material]));
    for (const [camera, target] of points) {
      const ray = new T.Raycaster(
        camera,
        target.clone().sub(camera).normalize(),
        0,
        camera.distanceTo(target),
      );
      const hits = ray
        .intersectObject(fixture.world, true)
        .filter((hit) => hit.object instanceof T.Mesh);
      assert.ok(hits.length > 0);
      for (const hit of hits)
        assert.ok(meshes.has(hit.object as T.Mesh), `unregistered wall at ${hit.point.toArray()}`);
      fixture.meetingWalls.enter(candidates);
      fixture.meetingWalls.update(camera, [target]);
      const blocking = new Set(hits.map((hit) => hit.object));
      let disposed = 0;
      let clones = 0;
      for (const mesh of meshes) {
        if (!blocking.has(mesh)) {
          assert.equal(mesh.material, originals.get(mesh));
          continue;
        }
        assert.notEqual(mesh.material, originals.get(mesh));
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          assert.ok(material.opacity <= 0.12);
          clones++;
          material.addEventListener("dispose", () => disposed++);
        }
      }
      fixture.meetingWalls.dispose();
      assert.equal(disposed, clones);
      for (const mesh of meshes) assert.equal(mesh.material, originals.get(mesh));
    }
    assert.ok(
      [...meshes].every((mesh) => !(mesh instanceof T.InstancedMesh)),
      "candidate geometry survives batching",
    );
    const floorRay = new T.Raycaster(new T.Vector3(5.5, 2, 5.5), new T.Vector3(0, -1, 0));
    const floorHits = floorRay.intersectObject(fixture.world, true);
    assert.ok(floorHits.length > 0);
    assert.ok(
      floorHits.every((hit) => !meshes.has(hit.object as T.Mesh)),
      "floor and rugs are not wall candidates",
    );
  });
}

test("a late texture refresh of the same map keeps the meeting, manual direction, speaking and restore values", () => {
  const fixture = rebuildingRenderer();
  const { renderer, camera, controls, meeting } = fixture;
  const original = camera.position.clone();
  renderer.enterMeeting();
  renderer.setMeetingSpeaker({ kind: "npc", id: "npc", utteranceId: "turn-1" });
  meeting.update(1, actors);
  const speakerTarget = controls.target.clone();
  renderer.rotateCamera(1);
  const manualPosition = camera.position.clone();
  const states: boolean[] = [];
  renderer.onMeetingCameraChange = (state) => states.push(state.active);
  fixture.refresh();
  assert.equal(renderer.meetingCameraState().active, true);
  assert.equal(renderer.meetingCameraState().automatic, false);
  assert.ok(camera.position.equals(manualPosition), "수동 방향이 재진입으로 초기화되면 안 된다");
  assert.deepEqual(states, [], "자산 재생성이 회의 종료 사건을 내보내면 안 된다");
  renderer.resumeMeetingAuto();
  meeting.update(1, actors);
  assert.ok(controls.target.equals(speakerTarget), "현재 발언을 유지해야 한다");
  renderer.exitMeeting();
  assert.ok(camera.position.equals(original));
  assert.equal((renderer as unknown as { following: boolean }).following, true);
  assert.deepEqual((renderer as unknown as { overviewDimensions: unknown }).overviewDimensions, {
    cols: 20,
    rows: 12,
  });
});

test("an asset refresh restores and releases the previous wall materials, then wires occlusion only to the new meeting walls", () => {
  const fixture = rebuildingRenderer();
  fixture.renderer.enterMeeting();
  const firstWall = () => {
    let mesh: T.Mesh | undefined;
    (
      fixture.renderer as unknown as { meetingWallObjects: T.Object3D[] }
    ).meetingWallObjects[0].traverse((object) => {
      if (!mesh && object instanceof T.Mesh) mesh = object;
    });
    assert.ok(mesh);
    return mesh;
  };
  const obscure = (mesh: T.Mesh) => {
    const center = mesh.getWorldPosition(new T.Vector3());
    fixture.meetingWalls.update(center.clone().add(new T.Vector3(0, 0, 5)), [
      center.clone().add(new T.Vector3(0, 0, -5)),
    ]);
  };
  const oldWall = firstWall();
  const original = oldWall.material;
  obscure(oldWall);
  assert.notEqual(oldWall.material, original);
  const faded = Array.isArray(oldWall.material) ? oldWall.material : [oldWall.material];
  let disposed = 0;
  faded.forEach((material) => material.addEventListener("dispose", () => disposed++));
  fixture.refresh();
  assert.equal(oldWall.material, original);
  assert.equal(disposed, faded.length);
  const nextWall = firstWall();
  assert.notEqual(nextWall, oldWall);
  const nextOriginal = nextWall.material;
  obscure(nextWall);
  assert.notEqual(nextWall.material, nextOriginal, "새 벽도 가림 대상이어야 한다");
  fixture.renderer.exitMeeting();
  assert.equal(nextWall.material, nextOriginal);
});

for (const environment of ["tech", "trading", "publishing"]) {
  test(`${environment} v3 비동기 마감과 같은 맵 재생성 뒤에도 회의벽 차폐를 유지한다`, async (t) => {
    t.mock.method(
      T.TextureLoader.prototype,
      "load",
      (_url: string, onLoad?: (texture: T.Texture) => void) => {
        const texture = new T.Texture();
        onLoad?.(texture);
        return texture;
      },
    );
    const fixture = rebuildingRenderer();
    fixture.refresh({ ...fixture.map(), environment, environmentVersion: 3 });
    const finish = async () => {
      const marker = fixture.world.getObjectByName(`${environment}-scene-ready`)!;
      assert.ok(marker);
      await marker.userData.assetReady;
      assert.equal(fixture.meeting.active, true);
      const wall = fixture.world.getObjectByName("generic-object:meeting-wall")!;
      const meshes: T.Mesh[] = [];
      wall.traverse((object) => {
        if (object instanceof T.Mesh) meshes.push(object);
      });
      const originals = meshes.map((mesh) => mesh.material);
      fixture.meetingWalls.update(new T.Vector3(11.5, 1, 6), [new T.Vector3(11.5, 1, 10)]);
      assert.ok(meshes.some((mesh, index) => mesh.material !== originals[index]));
    };
    await finish();
    fixture.refresh();
    await finish();
    fixture.renderer.exitMeeting();
  });
}

test("even with the same bounds, real furniture, seat, map or meeting space changes end meeting mode", () => {
  const fixture = rebuildingRenderer();
  for (const change of [
    (map: MapSnapshot) => ({
      ...map,
      objects: [...map.objects, { id: "chair", type: "chair", col: 12, row: 9 }],
    }),
    (map: MapSnapshot) => ({ ...map, floor: [[1]] }),
    (map: MapSnapshot) => ({ ...map, blocked: ["12,9"] }),
    (map: MapSnapshot) => ({
      ...map,
      meetingSpace: { ...map.meetingSpace!, bounds: { ...space.bounds, x: 11 } },
    }),
    (map: MapSnapshot) => ({ ...map, meetingSpace: undefined }),
  ]) {
    fixture.renderer.enterMeeting();
    fixture.rebuild(change(fixture.map()));
    assert.equal(fixture.renderer.meetingCameraState().active, false);
  }
  fixture.renderer.enterMeeting();
  fixture.map().objects[0].col += 1;
  fixture.rebuild(fixture.map());
  assert.equal(
    fixture.renderer.meetingCameraState().active,
    false,
    "같은 객체를 제자리 수정해도 변경으로 판정한다",
  );
});
/** Position within the usable screen (full width − meeting panel). Visible if 0–1. */
function usableSpot(camera: T.PerspectiveCamera, point: T.Vector3, width: number, right: number) {
  camera.updateMatrixWorld(true);
  const p = point.clone().project(camera);
  return { x: (((p.x + 1) / 2) * width) / (width - right), y: (1 - p.y) / 2 };
}
function assertVisible(
  camera: T.PerspectiveCamera,
  point: T.Vector3,
  width: number,
  right: number,
  label: string,
) {
  const spot = usableSpot(camera, point, width, right);
  assert.ok(spot.x >= 0 && spot.x <= 1, `${label}: 가로 ${spot.x.toFixed(3)} 가 사용 가능 폭 밖`);
  assert.ok(spot.y >= 0 && spot.y <= 1, `${label}: 세로 ${spot.y.toFixed(3)} 가 화면 밖`);
}
/** The corners of the box enclosing two participants' bodies — what the meeting framing must always contain. */
function participantCorners() {
  const corners: T.Vector3[] = [];
  for (const actor of actors)
    for (const dx of [-0.6, 0.6])
      for (const dz of [-0.6, 0.6])
        for (const y of [0, 2.2])
          corners.push(new T.Vector3(actor.x / 32 + dx, y, actor.y / 32 + dz));
  return corners;
}
test("the default framing contains the participants, not the room, and fills the screen", () => {
  // The old framing set distance from a bounding sphere over the room's four corners and viewed an 8×6 cell room from 23 cells away (measured).
  // Now the subject is the people — everyone must be visible while taking up a large share of the screen.
  const { camera, meeting } = setup();
  meeting.enter(space);
  meeting.update(1, actors);
  assert.equal(meeting.shot, "table");
  for (const corner of participantCorners()) assertVisible(camera, corner, 1200, 350, "참가자");
  // A tight framing means "the limiting axis is nearly full" — the box is seen at an angle, so whether width or height
  // fills first depends on the room shape. At first 60% width was asserted, which was wrong for this fixture
  // where height fills first.
  const spots = participantCorners().map((c) => usableSpot(camera, c, 1200, 350));
  const spreadX = Math.max(...spots.map((p) => p.x)) - Math.min(...spots.map((p) => p.x));
  const spreadY = Math.max(...spots.map((p) => p.y)) - Math.min(...spots.map((p) => p.y));
  assert.ok(
    Math.max(spreadX, spreadY) >= 0.75,
    `구도가 헐겁습니다 — 가로 ${(spreadX * 100).toFixed(0)}%, 세로 ${(spreadY * 100).toFixed(0)}%`,
  );
});

test("the speaker framing pulls in to the upper body from straight in front of the facing side", () => {
  const { camera, controls, meeting } = setup();
  meeting.enter(space);
  meeting.update(1, actors);
  const tableDistance = camera.position.distanceTo(controls.target);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, actors);
  assert.equal(meeting.shot, "speaker:npc:npc");
  const speaker = new T.Vector3(16, 0, 9);
  // The npc faces down (+z) → the camera must be on the +z side of the speaker at almost the same x to be head-on.
  const toCamera = camera.position.clone().sub(speaker).setY(0).normalize();
  assert.ok(toCamera.z > 0.9, `정면이 아닙니다 — 카메라 방향 ${toCamera.toArray()}`);
  const distance = camera.position.distanceTo(controls.target);
  assert.ok(
    distance >= 2.2 && distance < tableDistance * 0.6,
    `발언자 거리 ${distance.toFixed(2)}`,
  );
  assertVisible(camera, new T.Vector3(16, 2.9, 9), 1200, 350, "머리");
  const head = usableSpot(camera, new T.Vector3(16, 2.2, 9), 1200, 350);
  assert.ok(Math.abs(head.x - 0.5) < 0.2, `머리가 화면 가운데에서 벗어났습니다: ${head.x}`);
});

test("a speaker facing up is framed from the opposite side (−z)", () => {
  const { camera, meeting } = setup();
  const facingUp = actors.map((a) => (a.kind === "npc" ? { ...a, direction: "up" } : a));
  meeting.enter(space);
  meeting.update(1, facingUp);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, facingUp);
  assert.ok(camera.position.z < 9, `카메라 z ${camera.position.z} — 얼굴 쪽이 아닙니다`);
});

test("speaker zoom levels: close to the face < upper body < full body < whole table", () => {
  const distances: number[] = [];
  for (const speakerFraming of ["face", "upperBody", "fullBody", "table"] as const) {
    const { camera, controls, meeting } = setup();
    meeting.configure({ speakerFraming });
    meeting.enter(space);
    meeting.update(1, actors);
    meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
    meeting.update(1, actors);
    distances.push(camera.position.distanceTo(controls.target));
  }
  assert.ok(
    distances[0] < distances[1] && distances[1] < distances[2] && distances[2] < distances[3],
    distances.join(" < "),
  );
});

function speakerDistance(
  list: ActorSnapshot[],
  speakerFraming: "face" | "upperBody" = "upperBody",
) {
  const { camera, controls, meeting } = setup();
  meeting.configure({ speakerFraming });
  meeting.enter(space);
  meeting.update(1, list);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, list);
  return { camera, distance: camera.position.distanceTo(controls.target) };
}

test("if the neighbor enters the upper-body framing, pull in to above the chest; with the side empty, keep the upper body", () => {
  // Staging measurement: in adjacent seats the speaker and the neighbor were framed as a two-shot.
  const neighbor: ActorSnapshot = {
    id: "neighbor",
    kind: "npc",
    name: "Next",
    x: 17 * 32,
    y: 9 * 32,
    direction: "down",
    walking: false,
  };
  const alone = speakerDistance(actors).distance;
  const beside = speakerDistance([...actors, neighbor]);
  const bust = speakerDistance(actors, "face").distance;
  assert.ok(beside.distance < alone - 0.1, `옆자리 ${beside.distance} vs 단독 ${alone}`);
  assert.ok(Math.abs(beside.distance - bust) < 1e-6, "옆자리가 있으면 가슴 위 구도와 같다");
  assertVisible(beside.camera, new T.Vector3(16, 2.9, 9), 1200, 350, "발언자 머리");
  // Someone outside the room (beyond the glass wall) is not a neighbor.
  const outside = { ...neighbor, x: 40 * 32 };
  assert.ok(Math.abs(speakerDistance([...actors, outside]).distance - alone) < 1e-6);
});

test("with the 'whole table' setting during speech, it turns toward the speaker while keeping all participants", () => {
  const { camera, meeting } = setup();
  meeting.configure({ speakerFraming: "table" });
  meeting.enter(space);
  meeting.update(1, actors);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, actors);
  for (const corner of participantCorners()) assertVisible(camera, corner, 1200, 350, "참가자");
});

test("even short speech stays for the minimum dwell, lingers briefly after ending, then returns to the table", () => {
  const { meeting } = setup();
  meeting.configure({ minSpeakerDwellSeconds: 1.5, holdAfterSpeechSeconds: 1.2 });
  meeting.enter(space);
  meeting.update(0.1, actors);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "short" });
  meeting.update(0.1, actors); // t=0.2 speech starts — immediately to the speaker
  assert.equal(meeting.shot, "speaker:npc:npc", "발언 시작에는 늦지 않고 반응해야 합니다");
  meeting.setSpeaker(null);
  const at = (t: number) => {
    while (clock < t) {
      meeting.update(0.05, actors);
      clock += 0.05;
    }
    return meeting.shot;
  };
  let clock = 0.2;
  assert.equal(at(1.0), "speaker:npc:npc", "최소 체류(1.5초) 전에 떠났습니다");
  assert.equal(at(1.6), "speaker:npc:npc", "발언이 끝난 뒤 1.2초를 머물지 않았습니다");
  assert.equal(at(2.2), "table");
});

test("when the next speaker follows, it moves directly without going through the table (direct by default)", () => {
  const { meeting } = setup();
  meeting.configure({ minSpeakerDwellSeconds: 0.5, holdAfterSpeechSeconds: 1.2 });
  meeting.enter(space);
  meeting.update(0.1, actors);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "a" });
  const shots: string[] = [];
  for (let i = 0; i < 10; i++) {
    meeting.update(0.1, actors);
    shots.push(meeting.shot);
  }
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "b" });
  for (let i = 0; i < 10; i++) {
    meeting.update(0.1, actors);
    shots.push(meeting.shot);
  }
  const afterFirst = shots.slice(shots.indexOf("speaker:npc:npc"));
  assert.ok(!afterFirst.includes("table"), `테이블을 거쳤습니다: ${afterFirst.join(",")}`);
  assert.equal(shots.at(-1), "speaker:user:user");
});

test("with direct turned off, it goes through the table framing to the next speaker", () => {
  const { meeting } = setup();
  meeting.configure({ minSpeakerDwellSeconds: 0.5, directHandoff: false });
  meeting.enter(space);
  meeting.update(0.1, actors);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "a" });
  for (let i = 0; i < 10; i++) meeting.update(0.1, actors);
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "b" });
  const shots: string[] = [];
  for (let i = 0; i < 30; i++) {
    meeting.update(0.1, actors);
    shots.push(meeting.shot);
  }
  const table = shots.indexOf("table");
  const next = shots.indexOf("speaker:user:user");
  assert.ok(table >= 0 && next > table, `순서가 틀렸습니다: ${shots.join(",")}`);
});

test("even when speakers change quickly, the minimum dwell holds the camera — it does not shake", () => {
  // The old assertion was "direction within ±1.2 rad". In a head-on framing the direction is the speaker's gaze, so
  // that assertion is meaningless. What shaking really is: the framing changing too often.
  const first = setup();
  const second = setup();
  first.meeting.enter(space);
  second.meeting.enter(space);
  let changes = 0;
  let last = "";
  for (let i = 0; i < 30; i++) {
    first.meeting.setSpeaker({
      kind: i % 2 ? "npc" : "user",
      id: i % 2 ? "npc" : "user",
      utteranceId: String(i),
    });
    first.meeting.update(0.1, actors);
    if (first.meeting.shot !== last) changes += 1;
    last = first.meeting.shot;
  }
  // With a 1.5-second dwell over 3 seconds, the speaker framing changes at most three times (including the first entry).
  assert.ok(changes <= 3, `3초에 구도가 ${changes}번 바뀌었습니다`);
  first.meeting.manualRotate();
  assert.equal(second.meeting.automatic, true);
});

test("when not speaking (thinking) or a speaker only matches by name, it is the table framing — identification is by typed ID", () => {
  const { meeting } = setup();
  meeting.configure({ minSpeakerDwellSeconds: 0, holdAfterSpeechSeconds: 0 });
  meeting.enter(space);
  meeting.update(1, actors);
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "one" });
  meeting.update(1, actors);
  assert.equal(meeting.shot, "speaker:user:user");
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "thought", phase: "thinking" });
  meeting.update(1, actors);
  assert.equal(meeting.shot, "table", "생각 중은 발언이 아닙니다");
  // Both participants are named "Same" — looking up by name grabs the wrong person.
  meeting.setSpeaker({ kind: "user", id: "Same", utteranceId: "three" });
  meeting.update(1, actors);
  assert.equal(meeting.shot, "table");
});

test("stream updates of the same speech do not restart the transition, and manual rotation stops the automatic one", () => {
  const { camera, controls, meeting } = setup(false);
  meeting.enter(space);
  meeting.update(2, actors);
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "one" });
  meeting.update(0.3, actors);
  const halfway = controls.target.clone();
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "one" });
  meeting.update(0.3, actors);
  assert.ok(!controls.target.equals(halfway), "전환이 멈췄습니다");
  meeting.update(2, actors);
  const settled = controls.target.clone();
  meeting.setSpeaker({ kind: "user", id: "user", utteranceId: "one" });
  meeting.update(0.3, actors);
  assert.ok(controls.target.equals(settled), "같은 발언 갱신이 전환을 다시 시작했습니다");
  meeting.manualRotate();
  const position = camera.position.clone();
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "two" });
  meeting.update(3, actors);
  assert.ok(camera.position.equals(position));
  assert.equal(meeting.automatic, false);
  meeting.resumeAuto();
  meeting.update(3, actors);
  assert.equal(meeting.automatic, true);
  assert.equal(meeting.shot, "speaker:npc:npc");
});

test("the speaker never leaves the screen in any frame of a transition", () => {
  const { camera, meeting } = setup(false);
  meeting.enter(space);
  meeting.update(2, actors);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  for (let i = 0; i < 30; i++) {
    meeting.update(1 / 30, actors);
    assertVisible(camera, new T.Vector3(16, 1.5, 9), 1200, 350, `프레임 ${i}`);
  }
});

test("even when narrowed, all participants are visible immediately — without waiting for the next frame", () => {
  const { camera, meeting } = setup(false);
  meeting.enter(space);
  meeting.update(2, actors);
  meeting.setViewport(600, 900, 240);
  for (const corner of participantCorners()) assertVisible(camera, corner, 600, 240, "줄인 직후");
});

test("even when narrowed in the speaker framing, the speaker is visible", () => {
  const { camera, meeting } = setup();
  meeting.enter(space);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  for (const [width, height, right] of [
    [1200, 600, 350],
    [600, 900, 240],
  ]) {
    meeting.setViewport(width, height, right);
    meeting.update(1, actors);
    // The upper body of a standing speaker (no seat) goes from the head at 2.9 to the chest at about 1.3.
    assertVisible(camera, new T.Vector3(16, 2.9, 9), width, right, `${width}×${height} 머리`);
    assertVisible(camera, new T.Vector3(16, 1.4, 9), width, right, `${width}×${height} 가슴`);
  }
});

test("even when the speaker's front is beyond a wall, it does not cut off the speaker nor go deep into the next room", () => {
  // When npc(16,9) faces down (+z), the head-on camera goes beyond the south wall (z=11). The first implementation pulled it
  // into the room and cut off the head. Walls are already faded, so just beyond the wall is fine, but not deep into the next room.
  const { camera, meeting } = setup();
  meeting.enter(space);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, actors);
  assert.ok(
    camera.position.z <= 11 + 1.5 + 1e-6,
    `카메라 z ${camera.position.z.toFixed(2)} — 옆방 깊이`,
  );
  assertVisible(camera, new T.Vector3(16, 2.9, 9), 1200, 350, "머리");
  assertVisible(camera, new T.Vector3(16, 1.4, 9), 1200, 350, "가슴");
});

test("a speaker seated on a seat is framed by the seat position and seated height", () => {
  const { camera, meeting } = setup();
  meeting.enter(space);
  meeting.setSeats([
    { x: 16.2, z: 9.1 },
    { x: 12, z: 7 },
  ]);
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, actors);
  // The seated head (about 2.0) must be within the upper half of the screen.
  const head = usableSpot(camera, new T.Vector3(16.2, 2.0, 9.1), 1200, 350);
  assert.ok(head.y > 0 && head.y < 0.5, `앉은 머리 세로 ${head.y.toFixed(2)}`);
});

test("legacy renderer camera controls cannot bypass the meeting lock", () => {
  const { camera, controls, meeting } = setup();
  meeting.enter(space);
  meeting.update(1, actors);
  const renderer = Object.create(OfficeRenderer.prototype) as OfficeRenderer;
  Object.assign(renderer, {
    camera,
    controls: { ...controls, update() {} },
    meetingCamera: meeting,
    following: false,
    stopFollowing() {},
    host: { clientWidth: 1200, clientHeight: 600 },
  });
  const position = camera.position.clone();
  renderer.zoom(0.2);
  renderer.focus();
  renderer.showRoom(200, 200);
  renderer.overview(200, 200);
  assert.ok(camera.position.equals(position));
  assert.equal((renderer as unknown as { following: boolean }).following, false);
});

test("renderer enter/rotate/resume/exit restores follow state and wall materials", () => {
  const { camera, controls, meeting } = setup();
  const renderer = Object.create(OfficeRenderer.prototype) as OfficeRenderer;
  const wall = new T.Mesh(new T.BoxGeometry(3, 3, 0.2), new T.MeshStandardMaterial());
  wall.position.set(0, 1, 3);
  const material = wall.material;
  const meetingWalls = new MeetingWallOcclusion();
  const host = { clientWidth: 1200, clientHeight: 600, dataset: {} as Record<string, string> };
  Object.assign(renderer, {
    camera,
    controls: { ...controls, update() {} },
    meetingCamera: meeting,
    following: true,
    meetingWalls,
    meetingWallObjects: [wall],
    // The camera now frames the room's seats, so enterMeeting reads them.
    seats: [],
    // …and asks the renderer what each actor actually looks like.
    actors: new Map(),
    furnitureHighlight: new FurnitureHighlight(),
    boardArrival: new BoardArrival(),
    host,
    cursor: { visible: true },
    meetingRightInset: 0,
    overviewDimensions: null,
    setHoveredSeat() {},
    stopFollowing() {},
  });
  const states: boolean[] = [];
  renderer.onMeetingCameraChange = (state) => states.push(state.automatic);
  assert.equal(renderer.enterMeeting(space), true);
  meeting.update(1, actors);
  assert.equal(host.dataset.meeting, "true");
  assert.equal(controls.enableZoom, false);
  renderer.rotateCamera(1);
  assert.equal(renderer.meetingCameraState().automatic, false);
  renderer.resumeMeetingAuto();
  assert.equal(renderer.meetingCameraState().automatic, true);
  const input = renderer as unknown as {
    meetingPointer: { x: number; y: number };
    point(event: PointerEvent, kind: "move"): void;
  };
  input.meetingPointer = { x: 0, y: 0 };
  input.point({ clientX: 20, clientY: 0, buttons: 1 } as PointerEvent, "move");
  assert.equal(renderer.meetingCameraState().automatic, false);
  renderer.resumeMeetingAuto();
  meetingWalls.update(new T.Vector3(0, 1, 7), [new T.Vector3(0, 1, 0)]);
  assert.notEqual(wall.material, material);
  renderer.exitMeeting();
  assert.equal(wall.material, material);
  assert.equal(controls.enableZoom, true);
  assert.equal(host.dataset.meeting, undefined);
  assert.equal((renderer as unknown as { following: boolean }).following, true);
  assert.deepEqual(states, [true, false, true, false, true, true]);
});

// ---------------------------------------------------------------------------
// The actual appearance the renderer hands over — no guessing

/** A seated npc: sits on seat (16,9) facing +x (right). The seated body is 1.5 cells tall. */
function seatedPresenter(yaw = Math.PI / 2) {
  return (actor: ActorSnapshot) =>
    actor.id === "npc"
      ? { box: new T.Box3(new T.Vector3(15.7, 0, 8.7), new T.Vector3(16.3, 1.5, 9.3)), yaw }
      : null;
}

test("follows the real body direction — even if the snapshot says 'down', if the body faces right it frames from the right", () => {
  // A defect revealed in local measurement: a seated person faces the seat direction, but the snapshot direction is the last direction
  // while walking into the seat, so the camera framed from the side.
  const { camera, meeting } = setup();
  meeting.setPresenter(seatedPresenter());
  meeting.enter(space);
  meeting.update(1, actors); // the npc snapshot direction in actors is "down"
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
  meeting.update(1, actors);
  const toCamera = camera.position
    .clone()
    .sub(new T.Vector3(16, 0, 9))
    .setY(0)
    .normalize();
  assert.ok(
    toCamera.x > 0.9,
    `몸이 향한 쪽(+x)이 아닙니다: ${toCamera.toArray().map((v) => v.toFixed(2))}`,
  );
});

test("the upper body is framed by real height — the head is visible and the feet are cut; full body shows down to the feet", () => {
  for (const [speakerFraming, feetVisible] of [
    ["upperBody", false],
    ["fullBody", true],
  ] as const) {
    const { camera, meeting } = setup();
    meeting.configure({ speakerFraming });
    meeting.setPresenter(seatedPresenter());
    meeting.enter(space);
    meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
    meeting.update(1, actors);
    assertVisible(camera, new T.Vector3(16, 1.5, 9), 1200, 350, `${speakerFraming} 머리`);
    const feet = usableSpot(camera, new T.Vector3(16, 0, 9), 1200, 350);
    assert.equal(
      feet.y >= 0 && feet.y <= 1,
      feetVisible,
      `${speakerFraming} 발 세로 ${feet.y.toFixed(2)}`,
    );
    const head = usableSpot(camera, new T.Vector3(16, 1.3, 9), 1200, 350);
    assert.ok(
      Math.abs(head.x - 0.5) < 0.15,
      `${speakerFraming}: 발언자가 가운데에 있지 않습니다 ${head.x.toFixed(2)}`,
    );
  }
});

test("diagnostics say where the speaker could not be found", () => {
  const { meeting } = setup();
  meeting.configure({ minSpeakerDwellSeconds: 0, holdAfterSpeechSeconds: 0 });
  meeting.enter(space);
  meeting.update(1, actors);
  assert.equal(meeting.diagnostics.speaker, "none");
  meeting.setSpeaker({ kind: "npc", id: "ghost", utteranceId: "a" });
  meeting.update(1, actors);
  assert.equal(meeting.diagnostics.speaker, "no-actor");
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "b", phase: "thinking" });
  meeting.update(1, actors);
  assert.equal(meeting.diagnostics.speaker, "not-speaking");
  const outside = actors.map((a) => (a.kind === "npc" ? { ...a, x: 40 * 32 } : a));
  meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "c" });
  meeting.update(1, outside);
  assert.equal(meeting.diagnostics.speaker, "outside-room");
  meeting.update(1, actors);
  assert.deepEqual(meeting.diagnostics, { shot: "speaker:npc:npc", speaker: "found", error: null });
});

test("if computing the speaker framing throws, the shot does not change and it retries on the next frame", () => {
  // It used to change the shot name first and then compute, so on a throw the name was 'speaker' while the screen stayed on the table.
  const { meeting } = setup();
  let broken = false;
  meeting.setPresenter(() => {
    if (broken) throw new Error("rig not ready");
    return null;
  });
  meeting.configure({ minSpeakerDwellSeconds: 0, holdAfterSpeechSeconds: 0 });
  meeting.enter(space);
  meeting.update(1, actors);
  assert.equal(meeting.shot, "table");
  broken = true;
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    meeting.setSpeaker({ kind: "npc", id: "npc", utteranceId: "one" });
    meeting.update(1, actors);
    meeting.update(1, actors);
  } finally {
    console.error = original;
  }
  assert.equal(meeting.shot, "table", "계산이 실패한 샷으로 이름만 넘어가지 않는다");
  assert.equal(meeting.diagnostics.error, "rig not ready");
  assert.equal(errors.length, 1, "같은 오류를 매 프레임 찍지 않는다");
  broken = false;
  meeting.update(1, actors);
  assert.equal(meeting.shot, "speaker:npc:npc");
  assert.equal(meeting.diagnostics.error, null);
});
