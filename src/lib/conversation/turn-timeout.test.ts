import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnTimeout } from "./turn-timeout";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createTurnTimeout", () => {
  test("expires with idle if there's no activity", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // Waits a generous 3x (120ms) vs idleMs (40) so scheduler jitter can't leave it unfired.
    const t = createTurnTimeout({ idleMs: 40, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(120);
    t.clear();
    assert.deepEqual(fired, ["idle"]);
  });

  test("touch pushes back the idle timer", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // touch at 1/3 (50ms) intervals of idleMs (150) — each interval stays well under idleMs, so it's safe.
    const t = createTurnTimeout({ idleMs: 150, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(50);
    t.touch();
    await tick(50);
    t.touch();
    await tick(50);
    t.clear();
    assert.deepEqual(fired, [], "계속 활동하면 idle로 죽지 않는다");
  });

  test("the absolute cap holds even with repeated touch", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // Uses idleMs (2000) far above maxMs (80) so idle can never step in, and checks that
    // max fires first even with touch repeated 5 times at 40ms intervals (200ms total > maxMs).
    const t = createTurnTimeout({ idleMs: 2000, maxMs: 80 }, (kind) => fired.push(kind));
    for (let i = 0; i < 5; i++) {
      await tick(40);
      t.touch();
    }
    t.clear();
    assert.deepEqual(fired, ["max"], "활동이 있어도 max에서는 잘린다");
  });

  test("nothing fires after clear", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 20, maxMs: 20 }, (kind) => fired.push(kind));
    t.clear();
    await tick(80);
    assert.deepEqual(fired, []);
  });
});
