import assert from "node:assert/strict";
import test from "node:test";

import { actorIndicator } from "@/game/three/bridge";

import {
  EMPTY_NPC_WORKING,
  parseNpcWorkingPayload,
  reduceNpcWorking,
  workingNpcCounts,
  workingNpcIds,
} from "./npc-working-state";

// R27: the map's "working" state is built by folding only the server's `npc:working`. Pin here the order of on, update, off and snapshot,
// and the priority relative to the conversation response display.

const on = (npcId: string, runningCards = 1, cronRuns = 0) => ({
  npcId,
  working: true,
  sources: { runningCards, cronRuns },
});
const off = (npcId: string) => ({
  npcId,
  working: false,
  sources: { runningCards: 0, cronRuns: 0 },
});

test("npc:working — working:true adds an entry, working:false removes it", () => {
  let map = reduceNpcWorking(EMPTY_NPC_WORKING, on("a"));
  assert.deepEqual(workingNpcIds(map), ["a"]);
  map = reduceNpcWorking(map, on("b", 0, 1));
  assert.deepEqual(workingNpcIds(map).sort(), ["a", "b"]);
  map = reduceNpcWorking(map, off("a"));
  assert.deepEqual(workingNpcIds(map), ["b"]);
  assert.equal(map.a, undefined, "꺼진 NPC 는 맵에서 빠진다 — 기본값이 working:false 다");
});

test("npc:working — the same value returns the same object, and false for an unknown NPC is harmless", () => {
  const map = reduceNpcWorking(EMPTY_NPC_WORKING, on("a", 2, 1));
  assert.equal(reduceNpcWorking(map, on("a", 2, 1)), map, "동일 페이로드는 렌더를 만들지 않는다");
  assert.equal(reduceNpcWorking(map, off("zzz")), map);
  const changed = reduceNpcWorking(map, on("a", 1, 1));
  assert.notEqual(changed, map);
  assert.deepEqual(changed.a.sources, { runningCards: 1, cronRuns: 1 });
  // The input is not touched.
  assert.deepEqual(map.a.sources, { runningCards: 2, cronRuns: 1 });
});

test("npc:working — non-payload shapes are discarded, and missing sources are filled with 0", () => {
  assert.equal(parseNpcWorkingPayload(null), null);
  assert.equal(parseNpcWorkingPayload({ npcId: "a" }), null);
  assert.equal(parseNpcWorkingPayload({ npcId: "", working: true }), null);
  assert.deepEqual(parseNpcWorkingPayload({ npcId: "a", working: true }), {
    npcId: "a",
    working: true,
    sources: { runningCards: 0, cronRuns: 0 },
  });
  assert.deepEqual(
    parseNpcWorkingPayload({
      npcId: "a",
      working: true,
      sources: { runningCards: 3, cronRuns: 1 },
    }),
    on("a", 3, 1),
  );
});

test("map display priority — the conversation response (queued/thinking/streaming) comes before working (R27)", () => {
  assert.equal(actorIndicator({ working: true }), "working");
  assert.equal(actorIndicator({ working: false }), null);
  assert.equal(actorIndicator({}), null);
  for (const phase of ["queued", "thinking", "streaming"] as const)
    assert.equal(actorIndicator({ phase, working: true }), phase, `${phase} 가 작업 중을 가린다`);
  // A phase of idle/done/attention means there is no conversation display — working shows.
  assert.equal(actorIndicator({ phase: "idle", working: true }), "working");
  assert.equal(actorIndicator({ phase: "done", working: true }), "working");
  assert.equal(actorIndicator({ phase: "attention", working: true }), "working");
  // The activity bubble (active) is drawn as thinking, so it takes priority.
  assert.equal(actorIndicator({ active: true, working: true }), "thinking");
});

test("workingNpcCounts — gives per-NPC counts combining cards and cron", () => {
  const map = {
    a: { npcId: "a", working: true, sources: { runningCards: 2, cronRuns: 1 } },
    b: { npcId: "b", working: true, sources: { runningCards: 1, cronRuns: 0 } },
    c: { npcId: "c", working: false, sources: { runningCards: 0, cronRuns: 0 } },
  };
  assert.deepEqual(workingNpcCounts(map), { a: 3, b: 1 });
});

test("workingNpcCounts — NPCs not working are dropped", () => {
  assert.deepEqual(
    workingNpcCounts({
      x: { npcId: "x", working: false, sources: { runningCards: 0, cronRuns: 0 } },
    }),
    {},
  );
});
