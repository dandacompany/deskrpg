import assert from "node:assert/strict";
import test from "node:test";

import { OFFICE_ENVIRONMENTS, buildOfficeEnvironment } from "@/game/three/office-environments";
import { deriveChannelMotionLayout } from "./channel-motion-layout";
import { planPlacements, seatNumberAt, seatingMapFor } from "./seat-assignment";

const executive = () => seatingMapFor({ mapData: buildOfficeEnvironment("executive") })!;

test("numbers run consecutively from 1 and are the same on a second computation", () => {
  for (const env of OFFICE_ENVIRONMENTS) {
    const a = seatingMapFor({ mapData: buildOfficeEnvironment(env.id) })!;
    const b = seatingMapFor({ mapData: buildOfficeEnvironment(env.id) })!;
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.seats.map((s) => s.number),
      a.seats.map((_, i) => i + 1),
    );
  }
});

test("returns null for a map that can't be projected", () => {
  assert.equal(seatingMapFor({ mapData: null }), null);
  assert.equal(seatingMapFor({ mapData: { hello: 1 } }), null);
});

test("seatNumberAt: returns a number for a desk seat, otherwise null", () => {
  const { seats, standing } = executive();
  assert.equal(seatNumberAt(seats, seats[2].col, seats[2].row), 3);
  assert.equal(seatNumberAt(seats, standing[0].col, standing[0].row), null);
  assert.equal(seatNumberAt(seats, null, null), null);
});

test("standing tiles are walkable, aren't a seat or entrance, and have all 8 neighbors open", () => {
  const mapData = buildOfficeEnvironment("executive");
  const layout = deriveChannelMotionLayout({ mapData }, [])!;
  const { standing } = executive();
  assert.ok(standing.length > 0);
  const seatTiles = new Set(
    layout.seats.map((s) => `${Math.floor(s.x / 32)},${Math.floor(s.y / 32)}`),
  );
  for (const t of standing) {
    assert.ok(!seatTiles.has(`${t.col},${t.row}`));
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) assert.ok(layout.isWalkable(t.col + dx, t.row + dy));
  }
});

test("fills empty seats in number order, and stands people once seats are full", () => {
  const map = executive(); // 3 desk seats (the executive seat is excluded)
  const npcs = ["f", "a", "c", "b", "e", "d"].map((id) => ({ id }));
  const plan = planPlacements(npcs, map, []);
  assert.equal(plan.length, 6);
  assert.deepEqual(
    plan.slice(0, 3).map((p) => [p.npcId, p.seated, seatNumberAt(map.seats, p.col, p.row)]),
    [
      ["a", true, 1],
      ["b", true, 2],
      ["c", true, 3],
    ],
  );
  assert.ok(
    plan.slice(3).every((p) => !p.seated && seatNumberAt(map.seats, p.col, p.row) === null),
  );
  assert.ok(
    plan.every((p) => map.reserved.every((tile) => tile.col !== p.col || tile.row !== p.row)),
    "아무도 대표석에 두지 않는다",
  );
  assert.equal(new Set(plan.map((p) => `${p.col},${p.row}`)).size, 6, "같은 칸에 둘을 두지 않는다");
  assert.deepEqual(planPlacements(npcs, map, []), plan, "결정적이다");
});

test("skips seats already occupied (including dormant NPCs)", () => {
  const map = executive();
  const occupied = [{ positionX: map.seats[0].col, positionY: map.seats[0].row }];
  const [first] = planPlacements([{ id: "x" }], map, occupied);
  assert.equal(seatNumberAt(map.seats, first.col, first.row), 2);
});

test("with no seats and no standing tiles, it's excluded from the plan", () => {
  assert.deepEqual(
    planPlacements([{ id: "x" }], { seats: [], standing: [], reserved: [] }, []),
    [],
  );
});

test("the executive seat isn't an employee's assigned seat — the chair behind executive_desk is excluded from the seat list and reported as reserved", () => {
  // For every map with an executive desk, the chair right behind the desk (facing the same direction as the desk) is the executive seat.
  const expected = { executive: { col: 4, row: 5 }, agency: { col: 3, row: 12 } } as const;
  for (const [id, boss] of Object.entries(expected)) {
    const map = seatingMapFor({ mapData: buildOfficeEnvironment(id as keyof typeof expected) })!;
    assert.deepEqual(map.reserved, [boss], `${id}: 대표석을 reserved 로 알린다`);
    assert.equal(seatNumberAt(map.seats, boss.col, boss.row), null, `${id}: 대표석에 번호가 없다`);
    assert.ok(
      map.standing.every((tile) => tile.col !== boss.col || tile.row !== boss.row),
      `${id}: 대표석은 서는 칸도 아니다`,
    );
  }
  // The guest chairs (in front of the desk) remain regular seats — only the executive seat is excluded.
  const executiveMap = seatingMapFor({ mapData: buildOfficeEnvironment("executive") })!;
  assert.ok(seatNumberAt(executiveMap.seats, 3, 8) !== null);
  assert.ok(seatNumberAt(executiveMap.seats, 6, 8) !== null);
});

test("a map with no executive desk has an empty reserved list and an unchanged seat count", () => {
  for (const [id, count] of [
    ["trading", 28],
    ["tech", 16],
    ["publishing", 13],
  ] as const) {
    const map = seatingMapFor({ mapData: buildOfficeEnvironment(id) })!;
    assert.deepEqual(map.reserved, []);
    assert.equal(map.seats.length, count);
  }
});
