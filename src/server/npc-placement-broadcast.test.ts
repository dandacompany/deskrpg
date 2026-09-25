import assert from "node:assert/strict";
import test from "node:test";

import { broadcastPlacedNpcs } from "./npc-placement-broadcast";

function fakeIo() {
  const sent: Array<{ room: string; event: string; payload: unknown }> = [];
  return {
    sent,
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => sent.push({ room, event, payload }),
    }),
  };
}

const npc = (id: string) => ({ id, channelId: "ch-1", active: true, positionX: 3, positionY: 4 });

test("each newly seated NPC reaches the channel room as npc:updated, after the caches are dropped", async () => {
  const io = fakeIo();
  const order: string[] = [];

  await broadcastPlacedNpcs(io, "ch-1", ["n1", "n2"], {
    selectNpcById: async (id) => npc(id),
    invalidate: (channelId) => order.push(`invalidate:${channelId}`),
  });

  assert.deepEqual(order, ["invalidate:ch-1"]);
  assert.deepEqual(
    io.sent.map((m) => [m.room, m.event, (m.payload as { npc: { id: string } }).npc.id]),
    [
      ["ch-1", "npc:updated", "n1"],
      ["ch-1", "npc:updated", "n2"],
    ],
  );
});

test("an NPC that vanished or moved to another channel is not announced", async () => {
  const io = fakeIo();

  await broadcastPlacedNpcs(io, "ch-1", ["gone", "moved"], {
    selectNpcById: async (id) => (id === "moved" ? { ...npc(id), channelId: "ch-2" } : null),
    invalidate: () => {},
  });

  assert.deepEqual(io.sent, []);
});
