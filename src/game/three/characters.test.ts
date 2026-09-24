import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";

import { createActor } from "./characters";

/** An old procedural character without appearance — the renderer gives direction via this rig's y rotation. */
function headPosition(yaw: number, running: boolean) {
  const actor = createActor("legacy", "#667788", 0);
  actor.rig.rotation.y = yaw; // what the renderer does
  actor.update(0.3, true, "idle", false, undefined, { running, cadence: running ? 2 : 1 });
  actor.root.updateMatrixWorld(true);
  let top = -Infinity;
  const at = new T.Vector3();
  actor.rig.traverse((node) => {
    const p = node.getWorldPosition(new T.Vector3());
    if (p.y > top) {
      top = p.y;
      at.copy(p);
    }
  });
  return at;
}

test("leans toward the facing side when running — facing down (+z) puts the head toward +z", () => {
  const run = headPosition(0, true);
  const walk = headPosition(0, false);
  assert.ok(run.z - walk.z > 0.1, `${walk.z.toFixed(3)} → ${run.z.toFixed(3)}`);
});

test("facing right (+x) leans right too — the lean is applied before the direction", () => {
  // With the default Euler order (XYZ) the lean applies to the world x axis, so when facing sideways the head goes to +z instead of sideways.
  const run = headPosition(Math.PI / 2, true);
  const walk = headPosition(Math.PI / 2, false);
  assert.ok(
    run.x - walk.x > 0.1,
    `오른쪽으로 기울지 않았습니다: x ${walk.x.toFixed(3)} → ${run.x.toFixed(3)}`,
  );
  assert.ok(
    Math.abs(run.z - walk.z) < 0.05,
    `엉뚱하게 z 로 기울었습니다: ${(run.z - walk.z).toFixed(3)}`,
  );
});
