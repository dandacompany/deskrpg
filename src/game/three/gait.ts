import { RUN_SPEED_THRESHOLD } from "../../lib/npc-motion-config";

/** The gait. `cadence` is how many times faster to run the walking motion (greater than 1 only when running). */
export type ActorGait = { running: boolean; cadence: number };

export const WALKING_GAIT: ActorGait = { running: false, cadence: 1 };

/**
 * The movement speed (cells/second) at which the walking motion does not make the feet slide. The walk clip and the procedural step
 * are tuned to the NPC's old default speed (150px/s).
 */
export const WALK_CLIP_TILES_PER_SECOND = 150 / 32;
const RUN_ENTER = RUN_SPEED_THRESHOLD / 32;
// Exit below the entry threshold — so when the speed jitters near the threshold it does not flicker between running and walking.
const RUN_EXIT = RUN_ENTER * 0.8;
const SMOOTHING_SECONDS = 0.15;
// Moving more than this in one frame is not walking but a teleport (relocation, sync).
const TELEPORT_TILES = 2;

/**
 * Decide whether it is running from the movement speed visible on screen. Decided by **observed speed, not the move kind**, so it
 * looks the same on everyone's screen without changing the socket contract — the browser driving the NPC and the browser following
 * broadcast positions see the same speed. And when the owner lowers the call to the usual speed, it naturally goes back to a walking
 * look (no running look at a slow speed).
 */
export function createGaitTracker() {
  let speed = 0;
  let running = false;
  return {
    update(dxTiles: number, dzTiles: number, dtSeconds: number, walking: boolean): ActorGait {
      const moved = Math.hypot(dxTiles, dzTiles);
      if (dtSeconds > 0 && moved < TELEPORT_TILES) {
        const sample = walking ? moved / dtSeconds : 0;
        const alpha = 1 - Math.exp(-dtSeconds / SMOOTHING_SECONDS);
        speed += (sample - speed) * alpha;
      }
      running = walking && (running ? speed >= RUN_EXIT : speed >= RUN_ENTER);
      if (!running) return WALKING_GAIT;
      const cadence = Math.min(2.6, Math.max(1.2, speed / WALK_CLIP_TILES_PER_SECOND));
      return { running: true, cadence };
    },
    get speed() {
      return speed;
    },
  };
}
