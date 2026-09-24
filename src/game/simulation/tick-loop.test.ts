import test from "node:test";
import assert from "node:assert/strict";
import {
  clampFrameDelta,
  HIDDEN_MAX_CATCH_UP_MS,
  hiddenStepDeltas,
  MAX_FRAME_DELTA_MS,
  TickLoop,
} from "./tick-loop";

test("the first frame has zero elapsed, and after that the real elapsed time is used", () => {
  assert.equal(clampFrameDelta(1000, null), 0);
  assert.equal(clampFrameDelta(1016.7, 1000), 16.700000000000045);
});

test("a long gap after returning from a hidden tab is clipped to the cap", () => {
  assert.equal(clampFrameDelta(60_000, 1000), MAX_FRAME_DELTA_MS);
  assert.equal(clampFrameDelta(1300, 1000, 100), 100);
});

test("never produces negative elapsed time even if the clock goes backwards", () => {
  assert.equal(clampFrameDelta(900, 1000), 0);
});

test("hidden ticks split a long elapsed time into cap-sized steps and apply all of them", () => {
  assert.deepEqual(hiddenStepDeltas(2000, 1000), [200, 200, 200, 200, 200]);
  assert.deepEqual(hiddenStepDeltas(1250, 1000), [200, 50]);
  assert.deepEqual(hiddenStepDeltas(1000, null), [], "첫 틱은 경과가 없다");
});

test("even when a long-sleeping tab wakes up, catch-up elapsed time goes only up to the cap", () => {
  const steps = hiddenStepDeltas(600_000, 0);
  assert.equal(
    steps.reduce((sum, d) => sum + d, 0),
    HIDDEN_MAX_CATCH_UP_MS,
  );
});

test("when the tab is hidden, ticks continue with a timer instead of rAF", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    performance: g.performance,
  };
  let visibility = "visible";
  let listener: (() => void) | null = null;
  let frames = 0;
  const timer: { tick: (() => void) | null } = { tick: null };
  let clock = 0;
  g.document = {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_: string, fn: () => void) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  g.requestAnimationFrame = () => ++frames;
  g.cancelAnimationFrame = () => {};
  g.setInterval = (fn: () => void) => ((timer.tick = fn), 1);
  g.clearInterval = () => (timer.tick = null);
  Object.defineProperty(globalThis, "performance", {
    value: { now: () => clock },
    configurable: true,
  });
  try {
    const deltas: number[] = [];
    const loop = new TickLoop((_now, delta) => deltas.push(delta));
    loop.start();
    assert.equal(frames, 1, "보이는 동안은 rAF");
    visibility = "hidden";
    listener!();
    assert.ok(timer.tick, "가려지면 타이머로 넘어간다");
    clock = 1000;
    timer.tick!(); // First tick: only set the reference time
    clock = 2000; // The browser slowed it down to 1-second intervals
    timer.tick!();
    assert.equal(
      deltas.reduce((sum, d) => sum + d, 0),
      1000,
      "1초 간격이어도 1초를 모두 걷는다",
    );
    loop.stop();
    assert.equal(timer.tick, null);
    assert.equal(listener, null);
  } finally {
    Object.defineProperty(globalThis, "performance", {
      value: saved.performance,
      configurable: true,
    });
    for (const [k, v] of Object.entries(saved)) if (k !== "performance") g[k] = v;
  }
});
