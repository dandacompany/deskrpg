import test from "node:test";
import assert from "node:assert/strict";
import smallOffice from "./fixtures/small-office-map.json";
import { buildOfficeEnvironment, OFFICE_ENVIRONMENTS } from "../game/three/office-environments";
import { tiledSnapshot } from "../game/three/tiled-preview";
import { furnitureSeats } from "../game/three/seating";
import { deriveChannelMotionLayout, closestValidUnoccupiedSpawn } from "./channel-motion-layout";
import { normalizeMeetingMap, projectMeetingMap } from "../game/meeting-map-normalization";

for (const environment of OFFICE_ENVIRONMENTS) {
  test(`persisted ${environment.id} agrees with UI2 seats, occupancy, and dimensions`, () => {
    const map = buildOfficeEnvironment(environment.id);
    const normalized = normalizeMeetingMap(map);
    const snapshot = projectMeetingMap(normalized.mapData);
    const layout = deriveChannelMotionLayout({ mapData: JSON.stringify(map) }, [
      { id: "npc", positionX: 15, positionY: 19 },
    ])!;
    assert.deepEqual(
      layout.bounds,
      environment.id === "agency"
        ? { width: 1344, height: 832 }
        : environment.id === "executive"
          ? { width: 576, height: 576 }
          : environment.id === "tech"
            ? { width: 1408, height: 640 }
            : environment.id === "trading"
              ? { width: 1408, height: 960 }
              : { width: 960, height: 832 },
    );
    assert.deepEqual(layout.meetingSpace, normalized.meetingSpace);
    assert.deepEqual(layout.npcs, [{ id: "npc", x: 496, y: 624 }]);
    const projectedSeats = furnitureSeats(snapshot.objects).map((seat) => ({
      x: (seat.anchorX ?? seat.x) * 32,
      y: (seat.anchorZ ?? seat.z) * 32,
    }));
    assert.ok(
      projectedSeats.every(layout.canStandAt),
      "every UI2 seat anchor has server-side actor-body clearance",
    );
    assert.deepEqual(
      layout.seats.map(({ id }) => id),
      [...new Set(projectedSeats.map(({ x, y }) => `${x}:${y}`))],
    );
    const blocked = new Set(snapshot.blocked);
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++) {
        assert.equal(layout.isWalkable(x, y), !blocked.has(`${x},${y}`));
      }
    const spawn = closestValidUnoccupiedSpawn(layout, { x: 496, y: 624 })!;
    assert.ok(layout.canStandAt(spawn));
    assert.notDeepEqual(spawn, layout.npcs[0]);
    assert.ok(Math.hypot(spawn.x - 496, spawn.y - 624) >= 14.08);
    assert.deepEqual(spawn, closestValidUnoccupiedSpawn(layout, { x: 496, y: 624 }));
  });
}

test("real saved Small Office JSON retains geometry and does not become a generated environment", () => {
  const map = smallOffice.tiledJson;
  const layout = deriveChannelMotionLayout(
    { mapData: map, mapConfig: JSON.stringify({ cols: 99, rows: 99 }) },
    [],
  )!;
  const effective = projectMeetingMap(normalizeMeetingMap(map).mapData);
  assert.deepEqual(layout.bounds, { width: effective.cols * 32, height: effective.rows * 32 });
  for (const seat of furnitureSeats(tiledSnapshot(map as never).objects))
    assert.ok(
      layout.seats.some(
        (s) => s.id === `${(seat.anchorX ?? seat.x) * 32}:${(seat.anchorZ ?? seat.z) * 32}`,
      ),
    );
  const spawn = closestValidUnoccupiedSpawn(layout, {
    x: (smallOffice.spawnCol + 0.5) * 32,
    y: (smallOffice.spawnRow + 0.5) * 32,
  })!;
  assert.ok(layout.canStandAt(spawn));
});

test("body rejects wall corners and out of bounds; nearest free spawn avoids players and NPCs", () => {
  const map = buildOfficeEnvironment("tech");
  map.width = 3;
  map.height = 3;
  map.layers = [
    {
      id: 1,
      name: "Collision",
      type: "tilelayer",
      width: 3,
      height: 3,
      data: [1, 0, 0, 0, 0, 0, 0, 0, 0],
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
    },
  ];
  const layout = deriveChannelMotionLayout({ mapData: map }, [
    { id: "npc", positionX: 1, positionY: 1 },
  ])!;
  assert.equal(layout.canStandAt({ x: 34, y: 34 }), false);
  assert.equal(layout.canStandAt({ x: 1, y: 48 }), false);
  assert.equal(layout.canStandAt({ x: Infinity, y: 48 }), false);
  assert.deepEqual(closestValidUnoccupiedSpawn(layout, { x: 48, y: 48 }, [{ x: 48, y: 16 }]), {
    x: 16,
    y: 48,
  });
  assert.deepEqual(closestValidUnoccupiedSpawn(layout, { x: 50, y: 70 }), { x: 50, y: 70 });
  const cols = layout.bounds.width / 32,
    rows = layout.bounds.height / 32;
  const all = Array.from({ length: cols * rows }, (_, i) => ({
    x: ((i % cols) + 0.5) * 32,
    y: (Math.floor(i / cols) + 0.5) * 32,
  }));
  assert.equal(closestValidUnoccupiedSpawn(layout, { x: 48, y: 48 }, all), null);
});

test("legacy persisted objects retain direction, wall collisions and fixed scene bounds", () => {
  const map = {
    layers: {
      floor: [
        [1, 1, 1],
        [1, 1, 1],
      ],
      walls: [
        [2, 0, 0],
        [0, 0, 0],
      ],
    },
    objects: [{ id: "chair", type: "chair", col: 1, row: 1, direction: "left" }],
  };
  const layout = deriveChannelMotionLayout({ mapData: JSON.stringify(map) }, [])!;
  assert.ok(layout.bounds.width >= 1280 && layout.bounds.height >= 960);
  assert.equal(layout.isWalkable(0, 0), false);
  assert.deepEqual(
    layout.seats.find((s) => s.id === "48:48"),
    { id: "48:48", x: 48, y: 48 },
  );
});

test("missing or malformed snapshots fail closed", () => {
  for (const mapData of [
    null,
    "{",
    {},
    { tiledversion: "1", width: -1, height: 20, layers: [] },
    { layers: {}, objects: [] },
  ]) {
    assert.equal(deriveChannelMotionLayout({ mapData }, []), null);
  }
});

test("edited themed maps keep edits and the renderer's no-Collision legacy wall fallback", () => {
  const map = buildOfficeEnvironment("agency");
  const walls = map.layers.find((layer) => layer.name === "Walls")!;
  map.layers = map.layers.filter((layer) => layer.name.toLowerCase() !== "collision");
  walls.data![19 * map.width + 15] = 2;
  const layout = deriveChannelMotionLayout({ mapData: JSON.stringify(map) }, [])!;
  assert.equal(layout.isWalkable(15, 19), false);
  assert.notDeepEqual(closestValidUnoccupiedSpawn(layout, { x: 496, y: 624 }), { x: 496, y: 624 });
});

test("v3 runtime repairs invalid and colliding NPC homes without editing persisted assignments", () => {
  const map = buildOfficeEnvironment("agency");
  const rows = [
    { id: "a", positionX: 999, positionY: 999 },
    { id: "b", positionX: 0, positionY: 0 },
    { id: "c", positionX: 0, positionY: 0 },
  ];
  const before = structuredClone(rows);
  const layout = deriveChannelMotionLayout({ mapData: map }, rows)!;
  assert.equal(layout.npcs.length, 3);
  assert.equal(new Set(layout.npcs.map((n) => `${n.x}:${n.y}`)).size, 3);
  for (const npc of layout.npcs) {
    assert.ok(layout.canStandAt(npc));
    assert.ok(layout.seats.some((s) => s.x === npc.x && s.y === npc.y));
  }
  assert.deepEqual(rows, before);
});

test("shared lib projection ignores stale configured spawns and preserves both v3 meeting rooms and home corrections", async () => {
  const shared = await import("../lib/channel-motion-layout");
  assert.equal(shared.deriveChannelMotionLayout, deriveChannelMotionLayout);
  const map = buildOfficeEnvironment("agency");
  const layout = shared.deriveChannelMotionLayout(
    { mapData: map, mapConfig: { spawnCol: 0, spawnRow: 0 } },
    [{ id: "invalid", positionX: NaN, positionY: NaN }],
  )!;
  assert.ok(layout.meetingSpace);
  assert.equal(layout.sanitizedHomes, true);
  assert.ok(layout.canStandAt(layout.npcs[0]));
  assert.deepEqual(
    layout.meetingSpace,
    deriveChannelMotionLayout({ mapData: map }, [])!.meetingSpace,
  );
});

test("v3 repairs malformed placed coordinates without dropping actors and keeps valid homes reserved", () => {
  const map = buildOfficeEnvironment("agency");
  const base = deriveChannelMotionLayout({ mapData: map }, [])!;
  const seat = [...base.seats].sort(
    (a, b) => Math.hypot(a.x - 32000, a.y - 32000) - Math.hypot(b.x - 32000, b.y - 32000),
  )[0];
  const rows = [
    { id: "a", positionX: 999, positionY: 999 },
    { id: "b", positionX: NaN, positionY: 2 },
    { id: "z", positionX: Math.floor(seat.x / 32), positionY: Math.floor(seat.y / 32) },
  ];
  const layout = deriveChannelMotionLayout({ mapData: map }, rows)!;
  assert.equal(layout.npcs.length, 3);
  assert.deepEqual(
    layout.npcs.find((n) => n.id === "z"),
    { id: "z", x: seat.x, y: seat.y },
  );
  for (const npc of layout.npcs) assert.ok(layout.canStandAt(npc));
});

test("v3 fractional saved NPC homes become tile-centered runtime seats for client/server parity", () => {
  const map = buildOfficeEnvironment("agency");
  const layout = deriveChannelMotionLayout({ mapData: map }, [
    { id: "fractional", positionX: 23.1, positionY: 23 },
  ])!;
  const npc = layout.npcs[0];
  assert.equal(npc.x % 32, 16);
  assert.equal(npc.y % 32, 16);
  assert.ok(layout.seats.some((s) => s.x === npc.x && s.y === npc.y));
});
