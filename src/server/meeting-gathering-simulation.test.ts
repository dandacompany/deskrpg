/**
 * The meeting gathering end to end without a browser: the real office simulation drives the walks, the real motion
 * authority and meeting coordinator judge them, and a fake socket carries the events between the two.
 *
 * Unit tests pin each rule; this pins what they add up to on the official maps — a crowded meeting room fills and
 * the meeting starts. Before the fixes, one to three of twelve NPCs stayed "walking" until the gathering timed out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server, Socket } from "socket.io";
import { EventBus, pendingChannelData, setPendingChannelData } from "../game/EventBus";
import { OfficeSimulation } from "../game/simulation/office-simulation";
import { deriveChannelMotionLayout } from "../lib/channel-motion-layout";
import type { MeetingSpatialState } from "../lib/meeting-discussion-state";
import { createMeetingSpatialCoordinator } from "./meeting-spatial-coordinator";
import { createNpcCoordination } from "./npc-coordination";

const CHANNEL = "ch";
const SOCKET = "sock1";
const FRAME_MS = 16;

type Handler = (...args: unknown[]) => unknown;

async function gather(
  fixture: string,
  npcCount: number,
  options: { walkOutAndBack?: boolean } = {},
) {
  const mapData = JSON.parse(
    readFileSync(new URL(`../lib/fixtures/${fixture}.json`, import.meta.url), "utf8"),
  );
  // NPC homes and the player's spawn: free tiles outside the meeting room, nearest the entry first.
  const probe = deriveChannelMotionLayout({ mapData }, [])!;
  const room = probe.meetingSpace!.bounds;
  const entry = probe.meetingSpace!.entry;
  const outside: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < probe.bounds.height / 32 - 1; y += 2)
    for (let x = 1; x < probe.bounds.width / 32 - 1; x += 2)
      if (
        probe.canStandAt({ x: (x + 0.5) * 32, y: (y + 0.5) * 32 }) &&
        !(
          x >= room.x - 1 &&
          x <= room.x + room.width &&
          y >= room.y - 1 &&
          y <= room.y + room.height
        )
      )
        outside.push({ x, y });
  outside.sort(
    (a, b) => Math.hypot(a.x - entry.x, a.y - entry.y) - Math.hypot(b.x - entry.x, b.y - entry.y),
  );
  const spawn = outside.shift()!;
  const homes = outside
    .slice(0, npcCount)
    .map((tile, i) => ({ id: `n${i}`, positionX: tile.x, positionY: tile.y }));
  const layout = deriveChannelMotionLayout({ mapData }, homes)!;

  // Delivery in order, one hop later — like a socket.
  const queue: Array<() => unknown> = [];
  const flush = async () => {
    for (let i = 0; i < 50 && queue.length; i++) {
      for (const deliver of queue.splice(0)) await deliver();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const clientListeners = new Map<string, Set<Handler>>();
  const toClient = (event: string, payload: unknown) =>
    queue.push(() => {
      for (const listener of clientListeners.get(event) ?? []) listener(payload);
    });
  const serverHandlers = new Map<string, Handler>();
  const serverSocket = {
    id: SOCKET,
    connected: true,
    rooms: new Set([SOCKET, CHANNEL]),
    on: (event: string, handler: Handler) => serverHandlers.set(event, handler),
    emit: toClient,
    to: () => ({ emit: () => {} }),
  } as unknown as Socket;
  const io = {
    sockets: {
      adapter: { rooms: new Map([[CHANNEL, new Set([SOCKET])]]) },
      sockets: new Map([[SOCKET, serverSocket]]),
    },
    to: () => ({ emit: toClient }),
  } as unknown as Server;

  let time = 1_000;
  const players = new Map<
    string,
    { mapId: string; x: number; y: number; userId: string; characterId: string }
  >();
  const motion = createNpcCoordination(io, {
    now: () => time,
    getPlayer: (id) => players.get(id),
    loadChannel: async () => layout,
    onSpatialArrival: (c, a, g) => spatial.arrived(c, a, g),
    onSpatialBlocked: (c, a, r, g) => spatial.block(c, a, r, g),
    onSpatialPlayerArrival: (c, u, s) => spatial.playerArrived(c, u, s),
    onSpatialPlayerBlocked: (c, u) => spatial.block(c, u, "participant_left"),
  });
  let latest: MeetingSpatialState | null = null;
  const spatial = createMeetingSpatialCoordinator({
    ...motion.spatial,
    timeoutMs: 120_000,
    publish: (state) => {
      latest = state;
    },
  });
  motion.register(serverSocket);

  const clientSocket = {
    id: SOCKET,
    connected: true,
    on: (event: string, listener: Handler) => {
      if (!clientListeners.has(event)) clientListeners.set(event, new Set());
      clientListeners.get(event)!.add(listener);
    },
    off: (event: string, listener: Handler) => clientListeners.get(event)?.delete(listener),
    emit: (event: string, payload: Record<string, unknown>, ack?: Handler) =>
      queue.push(async () => {
        if (event === "player:join") {
          players.set(SOCKET, {
            mapId: CHANNEL,
            x: payload.x as number,
            y: payload.y as number,
            userId: "host",
            characterId: "c1",
          });
          toClient("player:spawn", {
            x: payload.x,
            y: payload.y,
            direction: "down",
            animation: "idle",
          });
          await motion.joined(serverSocket, CHANNEL);
          toClient("players:state", { players: [] });
          return;
        }
        if (event === "player:move") {
          await motion.moved(serverSocket, payload.x as number, payload.y as number);
          Object.assign(players.get(SOCKET)!, { x: payload.x, y: payload.y });
          return;
        }
        await serverHandlers.get(event)?.(payload, ack);
      }),
    timeout: () => ({
      emit: (event: string, payload: Record<string, unknown>, ack?: Handler) =>
        clientSocket.emit(event, payload, ack && ((result: unknown) => ack(null, result))),
    }),
  };

  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => 1_700_000_000_000 + clock;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        npcs: homes.map((home) => ({
          ...home,
          name: home.id,
          direction: "down",
          appearance: null,
        })),
      }),
    )) as typeof fetch;
  const sim = new OfficeSimulation() as unknown as {
    boot(data: unknown): void;
    step(now: number, delta: number): void;
    dispose(): void;
    handlePointerDown(x: number, y: number, button: number, sx: number, sy: number): void;
    player: { x: number; y: number };
  };
  const run = async (ms: number, until?: () => boolean) => {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) {
      clock += FRAME_MS;
      time += FRAME_MS;
      sim.step(clock, FRAME_MS);
      if (elapsed % 64 === 0) await flush();
      if (elapsed % 1024 === 0) await motion.sweepStalled();
      if (until?.()) return true;
    }
    await flush();
    return until?.() ?? false;
  };
  try {
    setPendingChannelData({
      channelId: CHANNEL,
      mapData,
      mapConfig: { spawnCol: spawn.x, spawnRow: spawn.y },
    });
    sim.boot(pendingChannelData!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    EventBus.emit("socket-ready", {
      socket: clientSocket,
      characterId: "c1",
      characterName: "Host",
      appearance: null,
    });
    await run(500);

    // Walk into the meeting room with the "meeting room" button, join, sit down.
    const enterAndSit = async () => {
      let entryState = "";
      const onEntry = (state: { status: string }) => {
        entryState = state.status;
      };
      EventBus.on("meeting:entry-state", onEntry);
      EventBus.emit("meeting:request-entry");
      await run(30_000, () => entryState === "arrived");
      EventBus.off("meeting:entry-state", onEntry);
      assert.equal(entryState, "arrived", "the host never reached the meeting room");
      await spatial.joinPlayer(CHANNEL, "host", SOCKET);
      await flush();
      EventBus.emit("meeting:mode", { active: true });
      const seated = () =>
        latest?.participants.find((p) => p.actorId === "host")?.state === "seated";
      assert.equal(await run(30_000, seated), true, "the host never sat down");
    };
    const settled = () => latest?.phase !== "assembling";
    const npcIds = homes.map((home) => home.id);
    await enterAndSit();
    let generation = await spatial.start(CHANNEL, "host", npcIds);

    if (options.walkOutAndBack) {
      // The meeting ends; the host goes back to the office, still on the meeting screen's participation, and walks
      // out of the room — then opens the next meeting with the button.
      await run(120_000, settled);
      await spatial.cancel(CHANNEL);
      await run(60_000, () => latest?.phase === "idle");
      EventBus.emit("meeting:mode", { active: false });
      await run(1_000);
      sim.handlePointerDown((spawn.x + 0.5) * 32, (spawn.y + 0.5) * 32, 0, 0, 0);
      const outside = () =>
        Math.hypot(sim.player.x - (spawn.x + 0.5) * 32, sim.player.y - (spawn.y + 0.5) * 32) < 2;
      assert.equal(await run(30_000, outside), true, "the host never walked out");
      await enterAndSit();
      generation = await spatial.start(CHANNEL, "host", npcIds);
    }

    const began = clock;
    await run(120_000, settled);
    return {
      state: latest as MeetingSpatialState | null,
      generation,
      seconds: (clock - began) / 1000,
    };
  } finally {
    sim.dispose();
    spatial.reset(CHANNEL);
    motion.reset(CHANNEL);
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

for (const fixture of ["official-agency-v2", "official-trading-v2"]) {
  test(`twelve NPCs fill the ${fixture} meeting room and the meeting becomes ready`, async () => {
    const { state, seconds } = await gather(fixture, 12);
    const stuck = state?.participants.filter((p) => p.state !== "seated" && p.state !== "standing");
    assert.deepEqual(stuck, [], "someone is still on the way");
    assert.equal(state?.phase, "ready");
    assert.equal(state?.participants.filter((p) => p.kind === "npc").length, 12);
    // A jammed walk is placed after STALLED_MOTION_MS without progress; nobody waits for the 120 s timeout.
    assert.ok(seconds < 60, `the gathering took ${seconds}s`);
  });
}

test("a host who walked out of the room after a meeting walks back to a seat for the next one", async () => {
  // Same layout as the staging office where the host stood still at "walking" until the gathering timed out.
  const { state } = await gather("official-publishing-v3-initial", 2, { walkOutAndBack: true });
  assert.equal(state?.participants.find((p) => p.actorId === "host")?.state, "seated");
  assert.equal(state?.phase, "ready");
});
