import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlacementRequest,
  keepsPlacementMode,
  placementBroadcastPlan,
} from "./npc-placement-request";

test("placement only gives a seat to an existing NPC with PUT", () => {
  const { url, init } = buildPlacementRequest("npc-1", 7, 3);
  assert.equal(url, "/api/npcs/npc-1");
  assert.equal(init.method, "PUT");
  // POST /api/npcs is gone — creating a new one would make an NPC without a profile.
  assert.notEqual(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body as string), { positionX: 7, positionY: 3 });
});

test("sends no fields other than the seat", () => {
  const { init } = buildPlacementRequest("npc-1", 0, 0);
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["positionX", "positionY"]);
});

test("a seat move removes and re-adds — sending only add leaves other screens on the old cell", () => {
  assert.deepEqual(placementBroadcastPlan(true), ["remove", "add"]);
});

test("the first placement has nothing to remove", () => {
  assert.deepEqual(placementBroadcastPlan(false), ["add"]);
});

test("keeps placement mode when the tile is occupied and 409 comes back", () => {
  assert.equal(keepsPlacementMode(409), true);
});

test("both success and failure end placement mode", () => {
  for (const status of [200, 400, 403, 404, 500]) {
    assert.equal(keepsPlacementMode(status), false, `${status} 는 배치 모드를 끝낸다`);
  }
});
