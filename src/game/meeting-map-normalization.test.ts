import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MeetingMapError,
  normalizeMeetingMap,
  projectMeetingMap,
  serializeMeetingMap,
  prepareMeetingMapSave,
} from "./meeting-map-normalization";
import { buildOfficeEnvironment, OFFICE_ENVIRONMENTS } from "./three/office-environments";
import { deriveChannelMotionLayout } from "../server/channel-motion-layout";
import { clearSegment, findPath } from "./navigation";
import { type TiledGeometryMap } from "../lib/tiled-geometry";

const legacy = () => ({
  layers: {
    floor: Array.from({ length: 12 }, () => Array(14).fill(1)),
    walls: Array.from({ length: 12 }, () => Array(14).fill(0)),
  },
  objects: [{ id: "kept-desk", type: "desk", col: 3, row: 3 }],
});
for (const tiled of [false, true]) {
  test(`생성 증축벽만 렌더링 경계로 투영하고 충돌·저장을 보존한다: ${tiled ? "Tiled" : "legacy"}`, () => {
    const input = tiled
      ? {
          tiledversion: "1.10.2",
          width: 14,
          height: 12,
          tilewidth: 32,
          tileheight: 32,
          tilesets: [],
          layers: [
            { id: 1, name: "Floor", type: "tilelayer", data: Array(168).fill(0) },
            {
              id: 2,
              name: "Objects",
              type: "objectgroup",
              objects: [{ id: 1, type: "room_wall_h", x: 96, y: 96 }],
            },
          ],
        }
      : { ...legacy(), objects: [{ id: "user-wall", type: "room_wall_h", col: 3, row: 3 }] };
    const result = normalizeMeetingMap(input);
    const metadata = result.meetingSpace.generatedAnnexWalls;
    assert.ok(metadata?.length);
    const geometry = projectMeetingMap(result.mapData);
    assert.ok(metadata.some((wall) => wall.display === "hidden"));
    assert.ok(metadata.some((wall) => wall.display === "horizontal"));
    assert.ok(metadata.some((wall) => wall.display === "vertical"));
    assert.ok(metadata.some((wall) => wall.display === "corner"));
    const bounds = result.meetingSpace.bounds;
    assert.ok(
      metadata.some(
        (wall) =>
          wall.col === bounds.x + bounds.width &&
          wall.row === bounds.y + bounds.height &&
          wall.display === "corner",
      ),
    );
    assert.ok(!metadata.some((wall) => wall.id === (tiled ? "2:1" : "user-wall")));
    for (const marker of metadata) {
      assert.ok(
        geometry.objects.some(
          (o) =>
            o.id === marker.id &&
            o.col === marker.col &&
            o.row === marker.row &&
            o.type === marker.type,
        ),
      );
      assert.ok(geometry.blocked.includes(`${marker.col},${marker.row}`));
    }
    const entry = result.meetingSpace.entry;
    assert.ok(
      !metadata.some(
        (wall) => wall.col === Math.floor(entry.x) && wall.row === Math.floor(entry.y),
      ),
    );
    assert.deepEqual(normalizeMeetingMap(result.mapData), result);
    const saved = serializeMeetingMap(result.mapData, {
      layers: { floor: geometry.floor, walls: geometry.walls },
      objects: geometry.objects,
    });
    assert.deepEqual(normalizeMeetingMap(saved).meetingSpace, result.meetingSpace);
    assert.deepEqual(projectMeetingMap(saved).blocked, geometry.blocked);
    const stale = structuredClone(result.mapData);
    const staleRoom = stale.meetingSpace as Record<string, unknown>;
    staleRoom.generatedAnnexWalls = [
      { ...metadata[0], id: "missing" },
      { ...metadata[0], col: metadata[0].col + 1 },
      { ...metadata[0], type: "chair" },
      { ...metadata[0], display: "invalid" },
    ];
    assert.deepEqual(normalizeMeetingMap(stale).meetingSpace.generatedAnnexWalls, []);
    const without = structuredClone(result.mapData);
    delete (without.meetingSpace as Record<string, unknown>).generatedAnnexWalls;
    assert.equal(
      (normalizeMeetingMap(without).meetingSpace as unknown as Record<string, unknown>)
        .generatedAnnexWalls,
      undefined,
    );
  });
}
for (const side of ["right", "bottom"]) {
  test(`증축 ${side} 연결 통로에 표시벽이나 충돌을 만들지 않는다`, () => {
    const input = legacy();
    input.layers.floor = Array.from({ length: 30 }, () => Array(40).fill(1));
    input.layers.walls = Array.from({ length: 30 }, () => Array(40).fill(0));
    if (side === "bottom") for (const row of input.layers.walls) row[38] = 2;
    const result = normalizeMeetingMap(input);
    const geometry = projectMeetingMap(result.mapData);
    const markers = result.meetingSpace.generatedAnnexWalls!;
    const corridor =
      side === "right"
        ? [
            [39, 1],
            [40, 1],
            [41, 1],
            [42, 1],
          ]
        : [
            [1, 29],
            [1, 30],
            [1, 31],
            [1, 32],
          ];
    for (const [x, y] of corridor) {
      assert.ok(!geometry.blocked.includes(`${x},${y}`));
      assert.ok(!markers.some((wall) => wall.col === x && wall.row === y));
    }
    const [x, y] = corridor[1];
    assert.ok(
      markers.some((wall) =>
        side === "right"
          ? wall.col === x && wall.row === y - 1 && wall.display === "horizontal"
          : wall.col === x - 1 && wall.row === y && wall.display === "vertical",
      ),
    );
    assert.deepEqual(normalizeMeetingMap(result.mapData), result);
  });
}
for (const { name, gid, tilesets } of [
  { name: "빈 타일셋", gid: 0, tilesets: [] },
  { name: "100부터 시작하는 타일셋", gid: 100, tilesets: [{ firstgid: 100, tilecount: 1 }] },
  {
    name: "뒤집힌 타일",
    gid: 0x80000064,
    tilesets: [{ firstgid: 100, tilecount: 1 }],
  },
]) {
  test(`Tiled 증축 바닥은 정의된 기존 GID를 보존한다: ${name}`, () => {
    const input = {
      tiledversion: "1.10.2",
      width: 14,
      height: 12,
      tilewidth: 32,
      tileheight: 32,
      tilesets,
      layers: [
        { id: 1, name: "Floor", type: "tilelayer", data: Array(14 * 12).fill(gid) },
        { id: 2, name: "Walls", type: "tilelayer", data: Array(14 * 12).fill(0) },
        { id: 3, name: "Objects", type: "objectgroup", objects: [] },
      ],
    };
    const before = structuredClone(input);
    const result = normalizeMeetingMap(input);
    const after = result.mapData as unknown as TiledGeometryMap;
    const floor = after.layers.find((layer) => layer.name === "Floor")!.data!;
    assert.equal(floor[input.width], gid, "새 바닥에 미정의 GID를 생성하지 않는다");
    assert.ok(floor.every((value) => value === gid));
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width; x++)
        assert.equal(floor[y * after.width + x], before.layers[0].data![y * input.width + x]);
    assert.deepEqual(result.mapData.tilesets, tilesets);
    assert.deepEqual(input, before);
    assert.deepEqual(normalizeMeetingMap(result.mapData), result);
  });
}
test("an extension keeps original coordinates and objects and does not accumulate when rerun", () => {
  const input = legacy();
  const before = structuredClone(input);
  const result = normalizeMeetingMap(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    projectMeetingMap(result.mapData).objects.find((o) => o.id === "kept-desk"),
    before.objects[0],
  );
  assert.deepEqual(normalizeMeetingMap(result.mapData), result);
  assert.ok(result.meetingSpace.seatIds.length >= 4);
  assert.ok(result.meetingSpace.standingPositions.length > 0);
  const server = deriveChannelMotionLayout({ mapData: input }, []);
  assert.ok(server);
  for (const id of result.meetingSpace.seatIds) assert.ok(server.seats.some((s) => s.id === id));
});
test("the official map's meeting room uses the existing space instead of the lounge", () => {
  for (const env of OFFICE_ENVIRONMENTS) {
    const input = buildOfficeEnvironment(env.id);
    const result = normalizeMeetingMap(input);
    const snapshot = projectMeetingMap(result.mapData);
    assert.equal(snapshot.cols, input.width, env.id);
    assert.equal(snapshot.rows, input.height, env.id);
    assert.ok(result.meetingSpace.seatIds.length >= 4, env.id);
    assert.deepEqual(normalizeMeetingMap(result.mapData), result);
  }
});
test("an invalid map is not replaced with a separate space", () => {
  assert.throws(
    () => normalizeMeetingMap({ nonsense: true }),
    (e: unknown) => e instanceof MeetingMapError && e.reason === "unsupported_map_data",
  );
});

function enclosed() {
  const map = legacy();
  const add = (type: string, col: number, row: number) =>
    map.objects.push({ id: `${type}-${col}-${row}`, type, col, row });
  for (let x = 1; x <= 12; x++) {
    add("room_wall_h", x, 1);
    if (x !== 7) add("room_wall_h", x, 10);
  }
  for (let y = 2; y < 10; y++) {
    add("room_wall_v", 1, y);
    add("room_wall_v", 12, y);
  }
  add("conference_table", 5, 5);
  for (const x of [5, 8]) {
    add("chair", x, 4);
    add("chair", x, 7);
  }
  return map;
}
test("a clearly enclosed unmarked meeting room is reused", () => {
  const input = enclosed();
  const result = normalizeMeetingMap(input);
  assert.equal(result.meetingSpace.id, "meeting-conference_table-5-5");
  assert.deepEqual(result.meetingSpace.bounds, { x: 2, y: 2, width: 10, height: 8 });
  assert.deepEqual(projectMeetingMap(result.mapData).objects, input.objects);
});
test("a meeting_table reuses the existing room too when walls, chairs and entrance are clear", () => {
  const input = enclosed();
  input.objects.find((o) => o.type === "conference_table")!.type = "meeting_table";
  const result = normalizeMeetingMap(input);
  assert.notEqual(result.meetingSpace.id, "meeting-annex-v1");
  assert.deepEqual(result.meetingSpace.bounds, { x: 2, y: 2, width: 10, height: 8 });
});
test("lounges and multiple meeting candidates are preserved and a meeting room is added", () => {
  const input = legacy();
  input.objects.push({ id: "lounge", type: "meeting_table", col: 8, row: 5 });
  const result = normalizeMeetingMap(input);
  assert.equal(result.meetingSpace.id, "meeting-annex-v1");
  assert.deepEqual(
    projectMeetingMap(result.mapData).objects.find((o) => o.id === "lounge"),
    input.objects[1],
  );
  const tiled = buildOfficeEnvironment("tech");
  for (const layer of tiled.layers) layer.properties = [];
  const objects = tiled.layers.find((l) => l.type === "objectgroup")!;
  objects.objects!.push(
    {
      id: 9000,
      name: "A",
      type: "meeting_room",
      x: 32,
      y: 32,
      width: 320,
      height: 224,
      visible: true,
    },
    {
      id: 9001,
      name: "B",
      type: "meeting_room",
      x: 384,
      y: 32,
      width: 320,
      height: 224,
      visible: true,
    },
  );
  const ambiguous = normalizeMeetingMap(tiled);
  assert.equal(ambiguous.meetingSpace.id, "meeting-annex-v1");
  assert.deepEqual(normalizeMeetingMap(ambiguous.mapData), ambiguous);
});
test("a Tiled extension keeps existing object IDs, coordinates and tiles, and new IDs do not collide", () => {
  const input = buildOfficeEnvironment("executive");
  for (const layer of input.layers) layer.properties = [];
  const before = structuredClone(input);
  const { mapData } = normalizeMeetingMap(input);
  const after = mapData as unknown as TiledGeometryMap;
  assert.deepEqual(input, before);
  const ids = after.layers.flatMap((l) => (l.objects || []).map((o) => o.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const layer of before.layers) {
    const next = after.layers.find((l) => l.id === layer.id)!;
    if (layer.type === "tilelayer")
      for (let y = 0; y < before.height; y++)
        for (let x = 0; x < before.width; x++) {
          const prev = layer.data![y * before.width + x],
            actual = next.data![y * after.width + x];
          if (actual !== prev)
            assert.ok(
              (layer.name === "Walls" || layer.name === "Collision") &&
                (x === before.width - 1 || y === before.height - 1) &&
                actual === 0,
            );
        }
    for (const o of layer.objects || []) {
      const n = next.objects!.find((n) => n.id === o.id)!;
      assert.equal(n.x, o.x);
      assert.equal(n.y, o.y);
      if (n.type !== o.type) assert.ok(o.type.includes("wall") && n.type === "meeting_door");
    }
  }
  assert.deepEqual(normalizeMeetingMap(mapData).mapData, mapData);
});
test("meeting room seats and waiting spots are reachable from the entrance without the body overlapping walls", () => {
  for (const input of [legacy(), ...OFFICE_ENVIRONMENTS.map((e) => buildOfficeEnvironment(e.id))]) {
    const { mapData, meetingSpace: s } = normalizeMeetingMap(input);
    const layout = deriveChannelMotionLayout({ mapData }, [])!;
    const destinations = [
      ...s.seatIds.map((id) => {
        const [x, y] = id.split(":").map(Number);
        return { x, y };
      }),
      ...s.standingPositions,
    ];
    assert.equal(new Set(destinations.map((p) => `${p.x}:${p.y}`)).size, destinations.length);
    for (const p of destinations) {
      assert.ok(layout.canStandAt(p));
      const path = findPath(
        Math.floor(s.entry.x),
        Math.floor(s.entry.y),
        Math.floor(p.x / 32),
        Math.floor(p.y / 32),
        layout.isWalkable,
        (a, b) => clearSegment(a, b, layout.isWalkable),
      );
      assert.ok(path, `${s.id} → ${p.x}:${p.y}`);
    }
  }
});
test("unreachable maps and invalid explicit meeting rooms fail", () => {
  const map = legacy();
  map.layers.floor = Array.from({ length: 30 }, () => Array(40).fill(1));
  map.layers.walls = Array.from({ length: 30 }, () => Array(40).fill(2));
  map.layers.walls[3][3] = 0;
  map.objects = [];
  assert.throws(
    () => normalizeMeetingMap(map),
    (e: unknown) => e instanceof MeetingMapError && e.reason === "edge_corridor_unavailable",
  );
  assert.throws(
    () =>
      normalizeMeetingMap({
        ...legacy(),
        meetingSpace: { id: "bad", bounds: { x: 1, y: 1, width: 3, height: 3 } },
      }),
    (e: unknown) => e instanceof MeetingMapError && e.reason === "meeting_space_invalid",
  );
});
test("an invalid explicit Tiled meeting room property does not quietly extend", () => {
  const map = buildOfficeEnvironment("tech");
  for (const layer of map.layers) layer.properties = [];
  map.layers
    .find((l) => l.type === "objectgroup")!
    .objects!.push({
      id: 9999,
      name: "bad",
      type: "meeting_room",
      x: 32,
      y: 32,
      width: 96,
      height: 96,
      visible: true,
    });
  assert.throws(
    () => normalizeMeetingMap(map),
    (e: unknown) => e instanceof MeetingMapError && e.reason === "meeting_space_invalid",
  );
});
test("Tiled saves preserve collision objects, layers and existing object IDs", () => {
  const source = buildOfficeEnvironment("tech");
  source.layers.push({
    id: 200,
    name: "Collision",
    type: "objectgroup",
    objects: [
      { id: 9999, name: "blocked", type: "", x: 64, y: 64, width: 32, height: 32, visible: true },
    ],
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
  });
  const normalized = normalizeMeetingMap(source).mapData;
  const snapshot = projectMeetingMap(normalized);
  const saved = serializeMeetingMap(normalized, {
    layers: { floor: snapshot.floor, walls: snapshot.walls },
    objects: snapshot.objects,
  });
  assert.ok(projectMeetingMap(saved).blocked.includes("2,2"));
  assert.deepEqual(
    (saved.layers as TiledGeometryMap["layers"]).find((l) => l.id === 200),
    source.layers.find((l) => l.id === 200),
  );
  assert.deepEqual(normalizeMeetingMap(saved).mapData, saved);
  assert.deepEqual(projectMeetingMap(saved).objects, snapshot.objects);
});
test("across consecutive saves, deleting an earlier object does not change the saved IDs of the remaining objects", () => {
  const source = normalizeMeetingMap(buildOfficeEnvironment("tech")).mapData;
  const g = projectMeetingMap(source);
  const objects = [
    ...g.objects,
    { id: "new-A", type: "plant", col: 2, row: 12 },
    { id: "new-B", type: "plant", col: 3, row: 12 },
  ];
  const first = prepareMeetingMapSave(source, {
    layers: { floor: g.floor, walls: g.walls },
    objects,
  });
  const bId = first.objectIds["new-B"];
  assert.ok(bId);
  const current = objects
    .filter((o) => o.id !== "new-A")
    .map((o) => ({ ...o, id: first.objectIds[o.id] ?? o.id }));
  const second = prepareMeetingMapSave(first.mapData, {
    layers: { floor: g.floor, walls: g.walls },
    objects: current,
  });
  assert.ok(
    projectMeetingMap(second.mapData).objects.some(
      (o) => o.id === bId && o.col === 3 && o.row === 12,
    ),
  );
});

test("meeting map errors carry a code and an English message", () => {
  try {
    normalizeMeetingMap({ nonsense: true });
    assert.fail("expected a MeetingMapError");
  } catch (error) {
    assert.ok(error instanceof MeetingMapError);
    assert.equal(error.reason, "unsupported_map_data");
    assert.match(error.message, /^Invalid meeting map: /);
    assert.doesNotMatch(error.message, /[가-힣]/);
  }
});
