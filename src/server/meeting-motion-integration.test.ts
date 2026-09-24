import test from "node:test";
import assert from "node:assert/strict";
import type { Server, Socket } from "socket.io";
import { createNpcCoordination } from "./npc-coordination";
import { createMeetingSpatialCoordinator } from "./meeting-spatial-coordinator";

test("existing ownership/seat source of truth validates meeting gathering and client arrival claims are not approved", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: Array<{ room: string; event: string; payload: unknown }> = [];
  const socket = {
    id: "s1",
    connected: true,
    rooms: new Set(["s1", "a"]),
    on: (e: string, h: (...args: unknown[]) => unknown) => handlers.set(e, h),
    emit: () => {},
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => events.push({ room, event, payload }),
    }),
  } as unknown as Socket;
  const io = {
    sockets: {
      adapter: { rooms: new Map([["a", new Set(["s1"])]]) },
      sockets: new Map([["s1", socket]]),
    },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => events.push({ room, event, payload }),
    }),
  } as unknown as Server;
  let time = 0;
  const motion = createNpcCoordination(io, {
    now: () => time,
    getPlayer: () => ({ mapId: "a", x: 16, y: 176, userId: "u1", characterId: "c1" }),
    loadChannel: async () => ({
      npcs: [{ id: "n1", x: 16, y: 16 }],
      seats: [{ id: "80:80", x: 80, y: 80 }],
      bounds: { width: 256, height: 256 },
      isWalkable: () => true,
      canStandAt: () => true,
      meetingSpace: {
        id: "meeting",
        version: 1,
        bounds: { x: 1, y: 1, width: 4, height: 4 },
        entry: { x: 1.5, y: 1.5 },
        seatIds: ["80:80"],
        standingPositions: [{ x: 112, y: 80, direction: "up" }],
        wallObjectIds: [],
        wallTileKeys: [],
      },
    }),
    onSpatialArrival: (c, a, g) => spatial.arrived(c, a, g),
  });
  const spatial: ReturnType<typeof createMeetingSpatialCoordinator> =
    createMeetingSpatialCoordinator({
      ...motion.spatial,
      publish: (s) =>
        events.push({ room: `meeting-${s.channelId}`, event: "meeting:spatial-state", payload: s }),
    });
  motion.register(socket);
  await motion.joined(socket, "a");
  await motion.moved(socket, 80, 80);
  assert.equal(
    await motion.spatial.isInside("a", "s1"),
    false,
    "순간이동 주장은 입장 근거가 아니다",
  );
  await motion.moved(socket, 16, 176);
  const trigger = async (event: string, payload: Record<string, unknown>) => {
    let result: unknown;
    await handlers.get(event)!({ channelId: "a", ...payload }, (value: unknown) => {
      result = value;
    });
    return result;
  };
  const generation = await spatial.start("a", "u1", ["n1"]);
  assert.deepEqual(await trigger("npc:arrived", { npcId: "n1", generation }), {
    ok: false,
    error: "not_at_target",
  });
  assert.deepEqual(
    await trigger("npc:position-update", { npcId: "n1", x: 80, y: 80, direction: "down" }),
    { ok: false, error: "invalid_motion" },
  );
  assert.deepEqual(await trigger("npc:return-home", { npcId: "n1" }), {
    ok: false,
    error: "meeting_reserved",
  });
  time = 1000;
  assert.equal(
    (
      (await trigger("npc:position-update", { npcId: "n1", x: 80, y: 80, direction: "down" })) as {
        ok: boolean;
      }
    ).ok,
    true,
  );
  assert.deepEqual(await trigger("npc:arrived", { npcId: "n1", generation: 0 }), {
    ok: false,
    error: "stale_generation",
  });
  assert.equal(
    ((await trigger("npc:arrived", { npcId: "n1", generation })) as { ok: boolean }).ok,
    true,
  );
  assert.equal(await spatial.ready("a", generation!), true);
  assert.equal(
    events.filter((e) => e.event === "meeting:spatial-state").every((e) => e.room === "meeting-a"),
    true,
  );
  await motion.moved(socket, 16, 16);
  await spatial.cancel("a");
  const state = events.filter((e) => e.event === "npc:motion-state").at(-1)!.payload as {
    npcs: Array<{
      homeX: number;
      homeY: number;
      spatialTarget: { x: number; y: number; returning: boolean };
    }>;
  };
  assert.equal(state.npcs[0].spatialTarget.returning, true);
  assert.deepEqual(
    [
      state.npcs[0].homeX,
      state.npcs[0].homeY,
      state.npcs[0].spatialTarget.x,
      state.npcs[0].spatialTarget.y,
    ],
    [16, 16, 48, 16],
  );
});
