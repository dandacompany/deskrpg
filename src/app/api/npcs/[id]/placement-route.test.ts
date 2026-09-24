import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { authHeaders, seedChannelWithProfiles, setupThrowawaySqlite } from "@/test-setup/npc-seed";
import { buildOfficeEnvironment } from "@/game/three/office-environments";
import { seatingMapFor } from "@/lib/seat-assignment";

/**
 * The contract of the placement route. Seats must be unique within a channel
 * (`npcs_channel_position_unique`), and that conflict must go out as **409** —
 * the client sees 409, keeps placement mode and waits for the next cell. With 500
 * a "배치 실패" toast shows and placement mode ends.
 */
setupThrowawaySqlite("npc-placement-route-test");

async function put(npcId: string, userId: string, body: Record<string, unknown>) {
  const { PUT } = await import("./route");
  return PUT(
    new NextRequest(`http://localhost/api/npcs/${npcId}`, {
      method: "PUT",
      headers: authHeaders(userId),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: npcId }) },
  );
}

test("moving onto a cell someone already stands on is 409 tile_already_occupied", async () => {
  // The two placed NPCs stand at (0,0) and (1,0).
  const { npcIds, userId } = await seedChannelWithProfiles({ placedActive: 2 });

  const res = await put(npcIds[1], userId, { positionX: 0, positionY: 0 });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { errorCode: string };
  assert.equal(body.errorCode, "tile_already_occupied");
});

test("moving onto an empty cell works", async () => {
  const { npcIds, userId } = await seedChannelWithProfiles({ placedActive: 2 });

  const res = await put(npcIds[1], userId, { positionX: 5, positionY: 7 });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { npc: { positionX: number; positionY: number } };
  assert.equal(body.npc.positionX, 5);
  assert.equal(body.npc.positionY, 7);
});

test("gives a seat to an NPC without one — fills only the seat without creating anything", async () => {
  const { npcIds, userId } = await seedChannelWithProfiles({ placedActive: 1, unplaced: 1 });

  const res = await put(npcIds[1], userId, { positionX: 3, positionY: 4 });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { npc: { id: string; positionX: number } };
  assert.equal(body.npc.id, npcIds[1], "새 행을 만들지 않는다");
  assert.equal(body.npc.positionX, 3);
});

test("a cell that is not a desk seat is 400 not_a_desk_seat", async () => {
  const mapData = buildOfficeEnvironment("executive");
  const { npcIds, userId } = await seedChannelWithProfiles({ unplaced: 1, mapData });
  const { standing, seats } = seatingMapFor({ mapData })!;

  const bad = await put(npcIds[0], userId, {
    positionX: standing[0].col,
    positionY: standing[0].row,
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).errorCode, "not_a_desk_seat");

  const ok = await put(npcIds[0], userId, { positionX: seats[1].col, positionY: seats[1].row });
  assert.equal(ok.status, 200);

  const directionOnly = await put(npcIds[0], userId, { direction: "left" });
  assert.equal(directionOnly.status, 200, "방향만 바꾸는 요청은 검사하지 않는다");
});
