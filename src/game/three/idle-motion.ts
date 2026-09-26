import type { ActorPhase } from "./characters";
/**
 * Fixed pose offsets for the D08 states, shared by every actor kind. Constant, not animated: the pose says the
 * state without motion, so it holds under reduced motion and never reads as activity.
 *
 * - `raiseArm`: forward rotation (radians, negative = up) for one arm — waiting on a person.
 * - `headDown`: extra head pitch (positive = down) — stopped after repeated failures.
 */
export function statePose(phase: ActorPhase): { raiseArm: number; headDown: number } {
  if (phase === "awaiting") return { raiseArm: -2.6, headDown: 0 };
  if (phase === "failing") return { raiseArm: 0, headDown: 0.32 };
  return { raiseArm: 0, headDown: 0 };
}

/** A held pose — no breathing bob or head wobble either, so the body reads as stopped, not as quietly busy. */
export function isHeldPose(phase: ActorPhase): boolean {
  return phase === "still" || phase === "failing";
}

/** Smooth, staggered gestures with quiet intervals; deterministic across frame rates. */
export function idleMotion(t: number, seed: number, walking: boolean, phase: ActorPhase) {
  const clock = t + seed * 2.731;
  const pulse = (period: number, offset: number, duration: number) => {
    const local = (((clock + offset) % period) + period) % period;
    return local < duration ? Math.sin((Math.PI * local) / duration) ** 2 : 0;
  };
  // A still or stopped employee does not fidget — idle gestures would read as "fine, just idle".
  if (walking || phase === "still" || phase === "failing")
    return { yaw: 0, nod: 0, hand: 0, sway: 0 };
  const speaking = phase === "streaming";
  return {
    yaw:
      phase === "thinking"
        ? Math.sin(clock * 0.6) * 0.09
        : 0.38 * pulse(13, 0, 3.4) - 0.32 * pulse(13, 6.4, 3.2),
    nod: speaking ? Math.sin(clock * 3) * 0.055 : pulse(17, 7, 2) * 0.085,
    hand: phase === "idle" || phase === "done" ? pulse(19, 4, 3.2) : 0,
    sway: Math.sin(clock * 0.75) * 0.013,
  };
}
