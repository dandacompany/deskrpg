import assert from "node:assert/strict";
import test from "node:test";
import { pixelToWorld, worldToPixel, matchesNpcTarget } from "./bridge";
import { tiledSnapshot } from "./tiled-preview";
import type { TiledMap } from "../../lib/tiled-map";

test("saved and multiplayer pixel positions round-trip without tile quantization", () => {
  for (const [x, y] of [
    [16, 16],
    [642.75, 317.25],
    [1279, 959],
    [-12.5, 3000],
  ]) {
    const world = pixelToWorld(x, y);
    assert.deepEqual(worldToPixel(world.x, world.z), { x, y });
  }
  assert.deepEqual(pixelToWorld(16, 48), { x: 0.5, z: 1.5 });
});
test("a raycast/name target selects B even when A was inserted first within the hit radius", () => {
  const npcs = [
    { id: "a", x: 16, y: 16 },
    { id: "b", x: 48, y: 16 },
  ];
  assert.equal(npcs.find((npc) => matchesNpcTarget(npc, { x: 48, y: 16, actorId: "b" }))?.id, "b");
  assert.equal(
    npcs.find((npc) => matchesNpcTarget(npc, { x: 48, y: 16, actorId: "remote-user" })),
    undefined,
  );
  assert.equal(npcs.find((npc) => matchesNpcTarget(npc, { x: 10, y: 16 }))?.id, "a");
});
const map = {
  width: 4,
  height: 3,
  tilewidth: 16,
  tileheight: 16,
  layers: [
    { id: 1, name: "Floor", type: "tilelayer", data: Array(12).fill(100) },
    { id: 2, name: "Walls", type: "tilelayer", data: Array(12).fill(200) },
    { id: 3, name: "Collision", type: "tilelayer", data: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    {
      id: 4,
      name: "Objects",
      type: "objectgroup",
      objects: [
        { id: 1, name: "spawn", type: "spawn", x: 32, y: 32 },
        { id: 2, name: "desk", type: "desk", x: 64, y: 32 },
        { id: 3, name: "chair", type: "chair", x: 32, y: 32 },
        { id: 4, name: "table", type: "meeting_table", x: 64, y: 64 },
      ],
    },
    {
      id: 5,
      name: "Collision",
      type: "objectgroup",
      objects: [{ id: 5, x: 32, y: 0, width: 16, height: 32 }],
    },
  ],
  tilesets: [],
} as unknown as TiledMap;
test("editor preview uses the same 32px channel contract, keeps furniture and explicit collisions", () => {
  const before = JSON.stringify(map),
    snapshot = tiledSnapshot(map);
  assert.equal(snapshot.objects.find((o) => o.type === "desk")?.col, 2);
  assert.equal(snapshot.objects.length, 3);
  assert.equal(snapshot.cols, 4);
  assert.equal(snapshot.rows, 3);
  assert.ok(snapshot.blocked.includes("0,0"));
  assert.ok(snapshot.blocked.includes("1,0"));
  assert.ok(snapshot.blocked.includes("2,1"));
  assert.ok(snapshot.blocked.includes("3,2"));
  assert.ok(!snapshot.blocked.includes("1,1")); // chair stays walkable
  assert.ok(!snapshot.blocked.includes("0,1")); // decorative Walls GID is not collision
  assert.equal(JSON.stringify(map), before); // viewing cannot dirty/convert saved map data
});

import { actorIndicator, indicatorCountLabel, overviewDistance } from "./bridge";
import { createEventScope } from "./event-scope";
import { EventBus } from "../EventBus";
test("map overview fits large and portrait maps without a fixed 85-unit ceiling", () => {
  assert.ok(overviewDistance(200, 150, 1) > 85);
  assert.ok(overviewDistance(40, 30, 0.5) > overviewDistance(40, 30, 2));
  assert.equal(overviewDistance(80, 60, 1), overviewDistance(40, 30, 1) * 2);
});
test("destroying an old simulation never removes page or replacement renderer listeners", () => {
  const old = createEventScope(),
    replacement = createEventScope();
  let pageCount = 0,
    oldCount = 0,
    newCount = 0;
  const page = () => pageCount++;
  EventBus.on("ui2:ownership-test", page);
  old.on("ui2:ownership-test", () => oldCount++);
  replacement.on("ui2:ownership-test", () => newCount++);
  old.dispose();
  old.dispose();
  EventBus.emit("ui2:ownership-test");
  assert.deepEqual([pageCount, oldCount, newCount], [1, 0, 1]);
  replacement.dispose();
  EventBus.off("ui2:ownership-test", page);
});

test("room sender user ID resolves to socket actor without name matching", async () => {
  const { speechActorId } = await import("./bridge");
  const actors = [{ id: "socket-1", userId: "user-1" }, { id: "npc-1" }];
  assert.equal(speechActorId(actors, "user-1"), "socket-1");
  assert.equal(speechActorId(actors, "npc-1"), "npc-1");
  assert.equal(speechActorId(actors, "unknown"), "unknown");
});

test("indicatorCountLabel — a number is attached only for 2 or more", () => {
  assert.equal(indicatorCountLabel("working", { workingCount: 3 }), "3");
  assert.equal(indicatorCountLabel("working", { workingCount: 2 }), "2");
  assert.equal(
    indicatorCountLabel("working", { workingCount: 1 }),
    "",
    "1건은 배지가 이미 말한다 — 숫자를 붙이면 잡음만 는다",
  );
  assert.equal(indicatorCountLabel("working", {}), "");
});

test("indicatorCountLabel — no number on indicators other than working", () => {
  assert.equal(indicatorCountLabel("thinking", { workingCount: 5 }), "");
  assert.equal(indicatorCountLabel(null, { workingCount: 5 }), "");
});

test("for an employee running several cards, the response indicator wins while responding — the count is hidden", () => {
  const actor = { phase: "thinking" as const, active: false, working: true, workingCount: 4 };
  const kind = actorIndicator(actor);
  assert.equal(kind, "thinking");
  assert.equal(indicatorCountLabel(kind, actor), "");
});
