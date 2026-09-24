/**
 * A requestAnimationFrame-based tick loop. While the tab is hidden it continues with a timer.
 *
 * In a hidden tab the browser **stops** rAF (it is not throttling). This loop drives NPC walking, so
 * hiding the tab used to stop employees walking and calls and meeting gatherings froze at "moving". While hidden,
 * ticks continue with `setInterval` — even if the browser reduces hidden-tab timers to 1-second intervals, walking
 * progresses and arrival notifications go out. The server also settles stalled walks after a deadline (`STALLED_MOTION_MS`),
 * but walking here reduces teleporting when the tab comes back.
 *
 * dt uses the real elapsed time but caps a single step: tens of seconds arriving at once would make path following and
 * wait timers jump all together. Hidden ticks split a long elapsed time into several cap-sized steps —
 * otherwise only 200ms would be applied per 1-second timer and walking would run at 1/5 of its real speed.
 */
export const MAX_FRAME_DELTA_MS = 200;
/** Tick interval while hidden (the browser may stretch it to 1 second). */
export const HIDDEN_TICK_MS = 250;
/** The maximum elapsed time one hidden tick catches up. Even when a tab wakes from a long sleep, it walks only this much in one go. */
export const HIDDEN_MAX_CATCH_UP_MS = 2_000;

/** 0 for the first frame (no previous time), after that the real elapsed time clipped to the cap. Negatives become 0. */
export function clampFrameDelta(
  now: number,
  previous: number | null,
  max: number = MAX_FRAME_DELTA_MS,
): number {
  if (previous === null) return 0;
  return Math.max(0, Math.min(now - previous, max));
}

/** The steps of one hidden tick. Splits the elapsed time (at most `catchUp`) into pieces of at most `max`. */
export function hiddenStepDeltas(
  now: number,
  previous: number | null,
  max: number = MAX_FRAME_DELTA_MS,
  catchUp: number = HIDDEN_MAX_CATCH_UP_MS,
): number[] {
  if (previous === null) return [];
  let remaining = Math.max(0, Math.min(now - previous, catchUp));
  const steps: number[] = [];
  while (remaining > 0) {
    const step = Math.min(remaining, max);
    steps.push(step);
    remaining -= step;
  }
  return steps;
}

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export class TickLoop {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private previous: number | null = null;
  private running = false;

  constructor(
    private readonly step: (now: number, delta: number) => void,
    private readonly maxDelta: number = MAX_FRAME_DELTA_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previous = null;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.onVisibility);
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.onVisibility);
    cancelAnimationFrame(this.frame);
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.previous = null;
  }

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    if (isHidden()) this.interval = setInterval(this.hiddenTick, HIDDEN_TICK_MS);
    else this.frame = requestAnimationFrame(this.tick);
  }

  private onVisibility = () => {
    if (!this.running) return;
    // rAF and performance.now share the same clock. Dropping the previous time on switching makes the first tick 0,
    // so the gap between the two clocks does not come in all at once.
    this.previous = null;
    this.schedule();
  };

  private hiddenTick = () => {
    if (!this.running) return;
    const now = performance.now();
    let at = this.previous ?? now;
    for (const delta of hiddenStepDeltas(now, this.previous, this.maxDelta)) {
      at += delta;
      this.step(at, delta);
    }
    this.previous = now;
  };

  private tick = (now: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    const delta = clampFrameDelta(now, this.previous, this.maxDelta);
    this.previous = now;
    this.step(now, delta);
  };
}
