import * as T from "three";
import type { ActorPhase } from "./characters";
import { idleMotion, statePose } from "./idle-motion";

type Joint = { bone: T.Object3D; base: T.Quaternion };

/** Model-space axes accommodate both supplied skeletons without changing their rest poses. */
export function createGltfGestures(model: T.Object3D, seed: number) {
  const joint = (...names: string[]): Joint | undefined => {
    const bone = names.map((name) => model.getObjectByName(name)).find(Boolean);
    return bone ? { bone, base: bone.quaternion.clone() } : undefined;
  };
  const head = joint("Head");
  const left = joint("LeftArm", "UpperArm.L");
  const right = joint("RightArm", "UpperArm.R");
  const forearm = joint("RightForeArm", "LowerArm.R");
  const leftForearm = joint("LeftForeArm", "LowerArm.L");
  const joints = [head, left, right, forearm, leftForearm].filter((item): item is Joint => !!item);
  const axis = new T.Vector3();
  const parentRotation = new T.Quaternion();
  const modelRotation = new T.Quaternion();
  const offset = new T.Quaternion();
  const rotate = (item: Joint | undefined, x: number, y: number, angle: number) => {
    if (!item || !angle) return;
    const parent = item.bone.parent;
    if (parent) parent.getWorldQuaternion(parentRotation).invert();
    else parentRotation.identity();
    axis.set(x, y, 0).applyQuaternion(modelRotation).applyQuaternion(parentRotation);
    offset.setFromAxisAngle(axis.normalize(), angle);
    item.bone.quaternion.premultiply(offset).normalize();
  };
  return {
    /** Restore before mixer sampling, including joints without animation tracks. */
    restore() {
      for (const { bone, base } of joints) bone.quaternion.copy(base);
    },
    apply(time: number, walking: boolean, phase: ActorPhase, running = false) {
      for (const item of joints) item.base.copy(item.bone.quaternion);
      if (walking && !running) return;
      model.updateWorldMatrix(true, true);
      model.getWorldQuaternion(modelRotation);
      if (running) {
        // Running arms: bend the elbows and raise the arms slightly forward. Keep the swing phase from the walk clip as is —
        // adding a sine wave would put it out of beat with the clip and make the arms jitter. The bend is constant, so it does not fight.
        rotate(forearm, 1, 0, -1.0);
        rotate(leftForearm, 1, 0, -1.0);
        rotate(right, 1, 0, -0.2);
        rotate(left, 1, 0, -0.2);
        return;
      }
      const motion = idleMotion(time, seed, false, phase);
      const pose = statePose(phase);
      rotate(head, 0, 1, motion.yaw * 0.7);
      rotate(head, 1, 0, motion.nod * 0.7 + (phase === "thinking" ? 0.06 : 0) + pose.headDown);
      if (pose.raiseArm) {
        // Hand up: the upper arm forward and up, the forearm straightened a little so the hand is above the head.
        rotate(right, 1, 0, pose.raiseArm);
        rotate(forearm, 1, 0, -0.3);
      } else if (phase === "thinking") {
        rotate(right, 1, 0, -0.2);
        rotate(forearm, 1, 0, -0.25);
      } else if (phase === "streaming") {
        rotate(right, 1, 0, -0.16 + Math.sin(time * 3 + seed) * 0.07);
        rotate(left, 1, 0, -0.08 + Math.sin(time * 3 + seed + 1) * 0.04);
        rotate(forearm, 1, 0, -0.12);
      } else {
        rotate(right, 1, 0, -motion.hand * 0.16);
      }
    },
  };
}
