import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnTimeout } from "./turn-timeout";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createTurnTimeout", () => {
  test("활동이 없으면 idle로 만료된다", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // idleMs(40) 대비 넉넉히 3배(120ms) 기다려 스케줄러 지터로도 미발화할 여지를 없앤다.
    const t = createTurnTimeout({ idleMs: 40, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(120);
    t.clear();
    assert.deepEqual(fired, ["idle"]);
  });

  test("touch가 idle 타이머를 미룬다", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // idleMs(150)의 1/3(50ms) 간격으로 touch — 매 구간이 idleMs를 한참 밑돌아 안전하다.
    const t = createTurnTimeout({ idleMs: 150, maxMs: 5000 }, (kind) => fired.push(kind));
    await tick(50); t.touch();
    await tick(50); t.touch();
    await tick(50);
    t.clear();
    assert.deepEqual(fired, [], "계속 활동하면 idle로 죽지 않는다");
  });

  test("touch를 반복해도 절대 상한은 지켜진다", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    // maxMs(80)를 훌쩍 넘는 idleMs(2000)로 idle이 절대 끼어들지 못하게 하고,
    // touch를 40ms 간격으로 5회(총 200ms > maxMs) 반복해도 max가 먼저 끊는지 본다.
    const t = createTurnTimeout({ idleMs: 2000, maxMs: 80 }, (kind) => fired.push(kind));
    for (let i = 0; i < 5; i++) { await tick(40); t.touch(); }
    t.clear();
    assert.deepEqual(fired, ["max"], "활동이 있어도 max에서는 잘린다");
  });

  test("clear 이후에는 아무것도 발화하지 않는다", { timeout: 5000 }, async () => {
    const fired: string[] = [];
    const t = createTurnTimeout({ idleMs: 20, maxMs: 20 }, (kind) => fired.push(kind));
    t.clear();
    await tick(80);
    assert.deepEqual(fired, []);
  });
});
