import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSegment, type NavigationPoint } from "./navigation";
import { findTrafficPath, TrafficCoordinator, clearActors } from "./traffic";
import { readAmbientZones } from "./ambient-zones";
import { buildOfficeEnvironment } from "./three/office-environments";
import { tiledSnapshot } from "./three/tiled-preview";
import { NpcController } from "./simulation/npc-controller";
import { OfficeSimulation } from "./simulation/office-simulation";

// Run the real controller as is — it has no screen, so it imports directly in node.
function actor(state: NpcController["moveState"]) {
  const npc = new NpcController({
    id: "npc",
    name: "NPC",
    positionX: 7,
    positionY: 2,
    direction: "down",
  });
  Object.assign(npc, {
    pixelX: 48,
    pixelY: 80,
    currentPath: [
      { x: 3, y: 2 },
      { x: 7, y: 2 },
    ],
    pathIndex: 0,
    moveState: state,
    actuallyWalking: true,
  });
  return npc;
}
const walkable = (x: number, y: number) => x >= 0 && x <= 8 && y >= 0 && y <= 4;
for (const state of ["strolling", "returning", "moving-to-player"] as const) {
  test(`${state}: stationary obstruction replans to the same goal and stops walking while waiting`, () => {
    const npc = actor(state);
    let replans = 0;
    const plan = (sx: number, sy: number, ex: number, ey: number, valid: typeof walkable) => {
      replans++;
      assert.deepEqual([ex, ey], [7, 2]);
      return findTrafficPath(sx, sy, ex, ey, valid, [{ x: 3, y: 2 }]);
    };
    for (let i = 0; i < 15; i++) {
      npc.updateMovement(100, 1000, 1000, plan, walkable, (p: NavigationPoint) => p);
      assert.equal(npc.actuallyWalking, false);
    }
    assert.equal(replans, 1);
    assert.equal(npc.moveState, state);
    assert.deepEqual(JSON.parse(JSON.stringify(npc.currentPath!.at(-1))), { x: 7, y: 2 });
    assert.ok(
      npc.currentPath!.some((p: NavigationPoint) => p.y !== 2),
      "detour leaves the blocked row",
    );
  });
}
test("unreachable stroll retains its seat goal and retries at a bounded interval", () => {
  const npc = actor("strolling");
  let replans = 0;
  for (let i = 0; i < 45; i++)
    npc.updateMovement(
      100,
      1000,
      1000,
      () => {
        replans++;
        return null;
      },
      walkable,
      (p: NavigationPoint) => p,
    );
  assert.equal(replans, 3);
  assert.equal(npc.actuallyWalking, false);
  assert.equal(npc.currentPath!.at(-1)!.x, 7);
  assert.equal(npc.moveState, "strolling");
});

test("stroll really passes a stationary player and reaches the original destination", () => {
  const npc = actor("strolling");
  const traffic = new TrafficCoordinator();
  const human = { id: "player", x: 3, y: 2, player: true };
  const plan = (sx: number, sy: number, ex: number, ey: number, valid: typeof walkable) =>
    findTrafficPath(sx, sy, ex, ey, valid, [human]);
  let detoured = false;
  for (let now = 0; now < 60000 && npc.moveState !== "idle"; now += 50) {
    const before = { x: npc.pixelX / 32 - 0.5, y: npc.pixelY / 32 - 0.5 };
    npc.updateMovement(
      50,
      1000,
      1000,
      plan,
      walkable,
      (p: NavigationPoint, goal: NavigationPoint, amount: number) =>
        traffic.step("npc", p, goal, amount, now, walkable, [human, { id: "npc", ...p }]),
    );
    const after = { x: npc.pixelX / 32 - 0.5, y: npc.pixelY / 32 - 0.5 };
    assert.ok(clearActors(before, after, [human]), "never pass through the player");
    detoured ||= Math.abs(after.y - 2) > 0.4;
  }
  assert.equal(npc.moveState, "idle");
  assert.ok(detoured);
  assert.ok(Math.hypot(npc.pixelX / 32 - 0.5 - 7, npc.pixelY / 32 - 0.5 - 2) < 0.1);
});

test("local movement keeps the presented position in step with the collision position", () => {
  const npc = actor("strolling");
  const before = npc.pixelX;
  npc.updateMovement(
    50,
    1000,
    1000,
    (sx, sy, ex, ey, valid) => findTrafficPath(sx, sy, ex, ey, valid, []),
    walkable,
  );
  assert.notEqual(npc.pixelX, before, "the stroll advances");
  assert.deepEqual([npc.viewX, npc.viewY], [npc.pixelX, npc.pixelY]);
});

test("tagged retry starts at the current tile and keeps the fixed purpose destination", () => {
  const map = buildOfficeEnvironment("agency");
  const snapshot = tiledSnapshot(map);
  const zones = readAmbientZones(map as unknown as Record<string, unknown>);
  const blocked = new Set(snapshot.blocked);
  const walkable = (x: number, y: number) =>
    x >= 1 && x < snapshot.cols - 1 && y >= 1 && y < snapshot.rows && !blocked.has(`${x},${y}`);
  // Use the real simulation's path planner bound to a partial runtime (no traffic actors).
  const runtime = Object.assign(Object.create(OfficeSimulation.prototype), {
    ambientZones: zones,
    trafficActors: () => [],
  }) as OfficeSimulation;
  const npc = actor("moving-to-player");
  Object.assign(npc, {
    pixelX: (11 + 0.5) * 32,
    pixelY: (15 + 0.5) * 32,
    currentPath: null,
    pathRecalcTimer: 900,
    destinationTag: "photo",
    destinationTarget: { x: 5, y: 8 },
    purposeAccessOrigin: { x: 23, y: 23 },
  });
  const plan = runtime["npcPathfinder"](npc);

  npc.updateMovement(100, 1000, 1000, plan, walkable);
  assert.deepEqual(JSON.parse(JSON.stringify(npc.currentPath?.[0])), { x: 11, y: 15 });
  assert.notDeepEqual(JSON.parse(JSON.stringify(npc.currentPath?.[0])), { x: 23, y: 23 });
  assert.deepEqual(JSON.parse(JSON.stringify(npc.currentPath?.at(-1))), { x: 5, y: 8 });
  assert.deepEqual(JSON.parse(JSON.stringify(npc.destinationTarget)), { x: 5, y: 8 });
  assert.equal(npc.destinationTag, "photo");

  for (let frame = 0; frame < 300 && npc.moveState !== "waiting"; frame++) {
    const before = { x: npc.pixelX / 32 - 0.5, y: npc.pixelY / 32 - 0.5 };
    npc.updateMovement(50, 1000, 1000, plan, walkable);
    const after = { x: npc.pixelX / 32 - 0.5, y: npc.pixelY / 32 - 0.5 };
    assert.ok(clearSegment(before, after, walkable), `body-clear retry frame ${frame}`);
  }
  assert.equal(npc.moveState, "waiting");
  assert.ok(Math.hypot(npc.pixelX / 32 - 0.5 - 5, npc.pixelY / 32 - 0.5 - 8) < 0.1);
});

// ---------------------------------------------------------------------------
// Walking speed — each move has its own speed (`npc-motion-config`)

function walker() {
  return new NpcController({ id: "n", name: "n", positionX: 2, positionY: 2, direction: "down" });
}

test("a move given a speed, like a call, walks at that speed; returning walks at the normal move speed", () => {
  const npc = walker();
  npc.moveSpeed = 150;
  const path = (_c: number, _r: number, tc: number, tr: number) => [{ x: tc, y: tr }];
  assert.ok(npc.moveTo(8, 2, path, () => true, { speed: 300 }));
  assert.equal(npc.currentSpeed(), 300);
  npc.moveTo(8, 2, path, () => true);
  assert.equal(
    npc.currentSpeed(),
    150,
    "속도를 안 주면 평소 걸음이다 — 앞 이동의 속도가 남지 않는다",
  );
});

test("strolling uses the stroll speed; a stroll path given a speed (meeting gathering) uses that speed", () => {
  const npc = walker();
  npc.strollSpeed = 55;
  npc.startStroll([{ x: 5, y: 2 }]);
  assert.equal(npc.currentSpeed(), 55);
  npc.startStroll([{ x: 5, y: 2 }], 300);
  assert.equal(npc.currentSpeed(), 300, "회의 호출이 산책 속도로 걸으면 안 된다");
  npc.startStroll([{ x: 5, y: 2 }]);
  assert.equal(npc.currentSpeed(), 55, "다음 산책에 회의 속도가 남으면 안 된다");
});
