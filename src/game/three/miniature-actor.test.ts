import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import { createMiniatureActor } from "./miniature-actor";
import { OFFICE_LOOKS } from "./office-looks";
import { MINIATURE_WALK_STRIDE } from "./commute-walk";
test("distance fallback planted sole travel matches cycle stride within 10%", () => {
  const actor = createMiniatureActor("contact", OFFICE_LOOKS[0], 0);
  const leg = actor.rig.children.find(
    (child) => child.position.y === 0.89 && child.position.x < 0,
  )!;
  const knee = leg.children.find((child) => child instanceof T.Group)!;
  const sole = knee.children[knee.children.length - 1];
  const sample = (phase: number) => {
    actor.update(0, true, "walking", false, phase);
    actor.root.updateMatrixWorld(true);
    return sole.getWorldPosition(new T.Vector3()).z;
  };
  const start = sample(-Math.PI / 4),
    end = sample(Math.PI / 4);
  assert.ok(Math.abs((start - end) * 4 - MINIATURE_WALK_STRIDE) / MINIATURE_WALK_STRIDE < 0.1);
});
test("miniature rig preserves finite walking and seated geometry within office scale", () => {
  const look = OFFICE_LOOKS.find((l) => l.id === "office-eun")!;
  const actor = createMiniatureActor("pilot", look, 0);
  for (const [walking, seated] of [
    [false, false],
    [true, false],
    [false, true],
    [true, false],
  ]) {
    actor.update(1.4, walking, "idle", seated);
    actor.root.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(actor.root);
    assert.ok(Number.isFinite(box.min.y) && Number.isFinite(box.max.y));
    assert.ok(box.max.y < 2.1 && box.min.y > -0.12);
    assert.equal(actor.root.userData.actorId, "pilot");
  }
});

// ---------------------------------------------------------------------------
// Running — the asset has no run clip, so it is made procedurally

test("when running the whole body leans toward the facing side — the head goes forward too", () => {
  const actor = createMiniatureActor("runner", OFFICE_LOOKS[0], 0);
  const headZ = (running: boolean) => {
    actor.update(0.3, true, "idle", false, undefined, { running, cadence: running ? 2 : 1 });
    actor.root.updateMatrixWorld(true);
    // The highest part is the head.
    let top = -Infinity;
    let z = 0;
    actor.rig.traverse((node) => {
      const p = node.getWorldPosition(new T.Vector3());
      if (p.y > top) {
        top = p.y;
        z = p.z;
      }
    });
    return z;
  };
  const walkZ = headZ(false);
  const runZ = headZ(true);
  // The facing side is +z. Leaning only the torso leaves the head in place, making this difference 0.
  assert.ok(
    runZ - walkZ > 0.1,
    `머리가 앞으로 가지 않았습니다: ${walkZ.toFixed(3)} → ${runZ.toFixed(3)}`,
  );
});

test("stopping after walking removes the lean", () => {
  const actor = createMiniatureActor("stop", OFFICE_LOOKS[0], 0);
  actor.update(0.3, true, "idle", false, undefined, { running: true, cadence: 2 });
  assert.ok(actor.rig.rotation.x > 0);
  actor.update(0.4, false, "idle", false, undefined, { running: false, cadence: 1 });
  assert.equal(actor.rig.rotation.x, 0);
});

test("the step cycle speeds up when running — the legs cycle more in the same time", () => {
  const legAngles = (running: boolean) => {
    const actor = createMiniatureActor("cadence", OFFICE_LOOKS[0], 0);
    const leg = actor.rig.children.find((c) => c.position.y === 0.89 && c.position.x < 0)!;
    const angles: number[] = [];
    // One second is one or two cycles, so the number of sign changes is coarse. Count over 3 seconds.
    for (let i = 0; i < 180; i++) {
      actor.update(i / 60, true, "idle", false, undefined, { running, cadence: running ? 2 : 1 });
      angles.push(leg.rotation.x);
    }
    let crossings = 0;
    for (let i = 1; i < angles.length; i++)
      if (Math.sign(angles[i]) !== Math.sign(angles[i - 1])) crossings++;
    return crossings;
  };
  assert.ok(legAngles(true) >= legAngles(false) * 1.8, `${legAngles(false)} → ${legAngles(true)}`);
});
