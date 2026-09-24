import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "socket.io-client";
import { copyMotionContinuation } from "./runtime-hydration";
import { EventBus, setPendingChannelData } from "./EventBus";
import type { MotionNpc } from "./motion-snapshot";
import { OfficeSimulation } from "./simulation/office-simulation";
import { NpcController } from "./simulation/npc-controller";
import { RemotePlayer } from "./simulation/remote-player";

/**
 * Inject state into a real simulation instance and run the "real handler". The constructor does not touch the DOM,
 * so it can be created in node as is, and private members are checked with bracket access.
 */
type Runtime = OfficeSimulation & Record<string, unknown>;
function simulation(overrides: Record<string, unknown> = {}): Runtime {
  return Object.assign(new OfficeSimulation() as Runtime, overrides);
}
function fakeSocket(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const emitted: unknown[][] = [];
  const socket = {
    id: "socket-old",
    connected: true,
    handlers,
    emitted,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler);
      return socket;
    },
    off() {
      return socket;
    },
    emit(...args: unknown[]) {
      emitted.push(args);
      return socket;
    },
    timeout() {
      return socket;
    },
    ...overrides,
  };
  return socket;
}

test("async actor hydration stops after the simulation is disposed", async () => {
  const emitted: string[] = [];
  const spawned = () => emitted.push("player-spawned");
  EventBus.on("player-spawned", spawned);
  const originalFetch = globalThis.fetch;
  let resolveFetch: (value: Response) => void = () => {};
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;
  try {
    setPendingChannelData({
      channelId: "channel",
      mapData: { layers: { floor: [[1, 1]], walls: [[0, 0]] }, objects: [] },
    });
    const sim = simulation();
    sim["boot"](setPendingChannelDataPeek());
    sim.dispose();
    resolveFetch(
      new Response(JSON.stringify({ npcs: [{ id: "n", name: "N", positionX: 0, positionY: 0 }] })),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(emitted, [], "a disposed simulation must not spawn actors");
    assert.equal(sim["playerReady"], false);
    assert.equal((sim["npcs"] as unknown[]).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    EventBus.off("player-spawned", spawned);
    setPendingChannelData(null);
  }
});
/** boot receives data before it is consumed — in the test, pass the value just set as is. */
function setPendingChannelDataPeek() {
  return {
    channelId: "channel",
    mapData: { layers: { floor: [[1, 1]], walls: [[0, 0]] }, objects: [] },
  };
}

test("actual bridge local actor learns its user identity from meeting state and refreshes after reconnect", () => {
  const socket = fakeSocket();
  const sim = simulation({
    socket,
    playerReady: true,
    player: { x: 80, y: 80 },
    characterName: "Local",
    characterId: "character-is-not-user",
  });
  sim["setupSocketListeners"]();
  const meetingState = socket.handlers.get("meeting:state");
  assert.ok(meetingState, "the simulation must consume the authoritative meeting:state listener");
  const actor = () => sim.officeBridge.actors().find((entry) => entry.kind === "player")!;
  assert.equal(actor().userId, undefined);
  meetingState({
    participants: [
      { id: "peer", userId: "peer-user" },
      { id: socket.id, userId: "user-old" },
    ],
  });
  assert.equal(actor().id, "socket-old");
  assert.equal(actor().userId, "user-old");
  socket.connected = false;
  sim["handleSocketDisconnect"]();
  assert.equal(actor().userId, undefined);
  meetingState({ participants: [{ id: socket.id, userId: "stale-user" }] });
  assert.equal(actor().userId, undefined, "disconnected snapshots cannot restore identity");
  socket.id = "socket-new";
  socket.connected = true;
  meetingState({ participants: [{ id: "socket-old", userId: "stale-user" }] });
  assert.equal(actor().userId, undefined, "old socket roster cannot identify reconnected actor");
  meetingState({ participants: [{ id: socket.id, userId: "user-new" }] });
  assert.equal(actor().userId, "user-new");
  socket.id = "socket-newer";
  assert.equal(actor().userId, undefined, "identity never carries across an unhydrated socket id");
  sim.dispose();
});

function scene() {
  return simulation({
    socket: { id: "self", connected: true },
    peerSnapshotReady: true,
    motionSnapshot: { current: { seats: [] } },
    motionGeneration: 1,
    reserveSeat: (_id: string, _x: number, _y: number, done: (ok: boolean) => void) => done(true),
    releaseSeat() {},
    player: { x: 48, y: 48 },
    spawnRequest: { x: 48, y: 48 },
    spawnInputStarted: false,
    currentDirection: 0,
    playerActuallyWalking: false,
    traffic: { clear() {} },
    currentPath: null,
    playerSeatGoal: null,
    playerSpawnReady: false,
    lastSentMotion: "",
    findPlayerPath: (_sx: number, _sy: number, ex: number, ey: number) => [
      { x: 3, y: 4 },
      { x: ex, y: ey },
    ],
  });
}
const player = (sim: Runtime) => sim["player"] as { x: number; y: number };
test("real spawn handler restores facing, seat intent and click route instead of configured spawn", () => {
  const runtime = scene();
  runtime["handlePlayerSpawn"]({
    x: 112,
    y: 144,
    direction: "left",
    animation: "walk",
    restored: true,
    motion: { targetX: 240, targetY: 272, seatId: "240:272" },
  });
  assert.deepEqual(
    [player(runtime).x, player(runtime).y, runtime["currentDirection"]],
    [112, 144, 1],
  );
  assert.equal(runtime["playerSeatGoal"], "240:272");
  assert.deepEqual(JSON.parse(JSON.stringify(runtime["currentPath"])), [
    { x: 3, y: 4 },
    { x: 7, y: 8 },
  ]);
  assert.equal(runtime["playerSpawnReady"], true);
});
test("real spawn handler does not undo newer input, and keyboard walk does not resume itself", () => {
  const runtime = scene();
  runtime["spawnInputStarted"] = true;
  player(runtime).x = 80;
  runtime["handlePlayerSpawn"]({ x: 112, y: 144, direction: "left", restored: true });
  assert.equal(player(runtime).x, 80);
  const fresh = scene();
  fresh["handlePlayerSpawn"]({
    x: 112,
    y: 144,
    direction: "up",
    animation: "walk",
    restored: true,
  });
  assert.equal(fresh["currentPath"], null);
  assert.equal(fresh["playerActuallyWalking"], false);
  assert.equal(fresh["currentDirection"], 0);
});
test("real movement sender waits for both snapshots and transmits changed goals at unchanged coordinates", () => {
  const calls: unknown[] = [];
  const runtime = simulation({
    socket: { connected: true, emit: (...args: unknown[]) => calls.push(args) },
    playerSpawnReady: false,
    peerSnapshotReady: true,
    lastMoveSent: 0,
    lastSentX: 112,
    lastSentY: 144,
    lastSentDir: "left",
    lastSentAnim: "idle",
    lastSentMotion: "null",
    currentPath: [{ x: 7, y: 8 }],
    playerSeatGoal: null,
  });
  runtime["sendPosition"](112, 144, "left", "idle");
  assert.equal(calls.length, 0);
  runtime["playerSpawnReady"] = true;
  runtime["peerSnapshotReady"] = false;
  runtime["sendPosition"](112, 144, "left", "idle");
  assert.equal(calls.length, 0);
  runtime["peerSnapshotReady"] = true;
  runtime["sendPosition"](112, 144, "left", "idle");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      "player:move",
      {
        x: 112,
        y: 144,
        direction: "left",
        animation: "idle",
        motion: { targetX: 240, targetY: 272 },
      },
    ],
  ]);
});
test("ambient continuation preserves rest clock and deep copies paths and seat targets", () => {
  const original = {
    ambientSchedule: {
      phase: "roam" as const,
      elapsed: 15000,
      duration: 30000,
      pause: 2000,
      seatRest: 7000,
      seatTarget: { x: 4, y: 5 },
    },
    ambientSeat: { x: 2, y: 3 },
    ambientTimer: 1500,
    path: [{ x: 5, y: 6 }],
  };
  const copy = copyMotionContinuation(original);
  assert.equal(copy.ambientSchedule.seatRest, 7000);
  assert.equal(copy.ambientSchedule.elapsed, 15000);
  copy.path![0].x = 99;
  copy.ambientSchedule.seatTarget!.x = 99;
  assert.equal(original.path[0].x, 5);
  assert.equal(original.ambientSchedule.seatTarget.x, 4);
});

function npcController(overrides: Record<string, unknown>) {
  const npc = new NpcController({
    id: "npc",
    name: "NPC",
    positionX: 0,
    positionY: 0,
    direction: "down",
  });
  return Object.assign(npc, overrides);
}

for (const reason of ["home", "forced-hydration"] as const) {
  test(`실제 공간 이동은 ${reason} 권위 재설정 뒤 같은 세대의 경로를 다시 시작한다`, () => {
    const starts: unknown[] = [];
    const runtime = simulation({
      socket: { id: "driver", emit() {} },
      motionSnapshot: { current: { ambientLeaderId: "driver", seats: [] } },
      npcOwnership: { owner: () => "driver", clear() {}, startReturn() {} },
      takeNpcOwnership() {},
      traffic: { clear() {} },
      now: 0,
      npcPathfinder: () => () => [
        { x: 0, y: 0 },
        { x: 4, y: 4 },
      ],
      createNpcWalkValidator: () => () => true,
    });
    const npc = npcController({
      pixelX: 16,
      pixelY: 16,
      motionLocallyDriven: true,
      startStroll(path: unknown) {
        (npc as unknown as { currentPath: unknown }).currentPath = path;
        starts.push(path);
      },
    });
    const state: MotionNpc = {
      npcId: "npc",
      x: 16,
      y: 16,
      homeX: 16,
      homeY: 16,
      direction: "down",
      ownerSocketId: "driver",
      phase: "called",
      moving: true,
      revision: 1,
      spatialTarget: { generation: 1, x: 144, y: 144, returning: false, seatId: null },
    };
    runtime["applyMotionNpc"](npc, state);
    assert.equal(starts.length, 1);
    runtime["applyMotionNpc"](npc, state);
    assert.equal(starts.length, 1, "동일 상태 에코는 경로를 다시 시작하지 않는다");
    runtime["applyMotionNpc"](
      npc,
      { ...state, homeX: reason === "home" ? 80 : 16 },
      reason === "forced-hydration",
    );
    assert.equal(starts.length, 2);
    assert.ok(npc.currentPath, "재설정으로 취소된 경로가 비어 있으면 이동이 멎는다");
    assert.equal(npc.homeCol, reason === "home" ? 2 : 0);
  });
}

test("real NPC removal clears the spatial move generation cache even without a controller", () => {
  const runtime = simulation();
  (runtime["spatialNpcRoutes"] as Map<string, unknown>).set("npc", {
    generation: 1,
    done: false,
  });
  runtime["removeNpcById"]("npc");
  assert.equal((runtime["spatialNpcRoutes"] as Map<string, unknown>).has("npc"), false);
});
test("real NPC hydration resumes ambient destination without resetting its break clock", () => {
  const runtime = simulation({
    socket: { id: "new" },
    motionSnapshot: { current: { ambientLeaderId: "new", seats: [] } },
    traffic: { clear() {} },
    now: 0,
    ambientZones: [],
  });
  const npc = npcController({ homeCol: 2, homeRow: 3, pixelX: 48, pixelY: 48 });
  runtime["applyMotionNpc"](
    npc,
    {
      npcId: "npc",
      x: 144,
      y: 176,
      direction: "up",
      homeX: 80,
      homeY: 112,
      ownerSocketId: null,
      phase: "ambient",
      moving: true,
      revision: 1,
      continuation: {
        ambientSchedule: { phase: "roam", elapsed: 9000, duration: 30000, pause: 2000 },
        ambientSeat: { x: 2, y: 3 },
        ambientTimer: 800,
        path: [{ x: 6, y: 7 }],
      },
    },
    true,
  );
  assert.deepEqual([npc.pixelX, npc.pixelY, npc.ambientTimer], [144, 176, 800]);
  assert.deepEqual([npc.viewX, npc.viewY], [144, 176], "a reset snaps the presented position too");
  assert.equal(npc.ambientSchedule.elapsed, 9000);
  assert.deepEqual(JSON.parse(JSON.stringify(npc.currentPath)), [{ x: 6, y: 7 }]);
  assert.equal(npc.moveState, "strolling");
});
test("remembered seat waits for a fresh claim and rejected claims never resume movement", () => {
  const runtime = scene();
  let answer: ((ok: boolean) => void) | undefined;
  runtime["reserveSeat"] = (_id: string, _x: number, _y: number, done: (ok: boolean) => void) => {
    answer = done;
  };
  runtime["handlePlayerSpawn"]({
    x: 112,
    y: 144,
    direction: "left",
    restored: true,
    motion: { targetX: 240, targetY: 272, seatId: "240:272" },
  });
  assert.equal(runtime["currentPath"], null, "cache entry is not a seat lease");
  assert.equal(runtime["playerSeatGoal"], null);
  assert.ok(answer);
  answer(false);
  assert.equal(runtime["currentPath"], null);
  assert.equal(runtime["playerSeatGoal"], null);
});
test("goal waits for all authoritative snapshots before a seat can be reclaimed", () => {
  const runtime = scene();
  runtime["peerSnapshotReady"] = false;
  runtime["handlePlayerSpawn"]({
    x: 112,
    y: 144,
    restored: true,
    motion: { targetX: 240, targetY: 272, seatId: "240:272" },
  });
  assert.equal(runtime["currentPath"], null);
  runtime["peerSnapshotReady"] = true;
  (runtime["motionSnapshot"] as { current: unknown }).current = null;
  runtime["resumePlayerGoal"]();
  assert.equal(runtime["currentPath"], null);
  (runtime["motionSnapshot"] as { current: unknown }).current = { seats: [] };
  runtime["resumePlayerGoal"]();
  assert.ok(runtime["currentPath"]);
});
test("real update freezes local input before hydration while remote players keep updating", () => {
  const runtime = scene();
  runtime["booted"] = true;
  runtime["playerSpawnReady"] = false;
  runtime["spawnInputStarted"] = false;
  const peer = new RemotePlayer({
    id: "peer",
    characterName: "Peer",
    appearance: null,
    x: 0,
    y: 0,
    direction: "down",
    animation: "walk",
  });
  peer.updatePosition(100, 0, "right", "walk");
  (runtime["remotePlayers"] as Map<string, RemotePlayer>).set("peer", peer);
  (runtime["keysDown"] as Set<string>).add("ArrowRight");
  runtime["update"]();
  assert.ok(peer.x > 0, "remote interpolation continues before hydration");
  assert.equal(runtime["spawnInputStarted"], false);
  assert.equal(player(runtime).x, 48);
  runtime["handlePlayerSpawn"]({ x: 112, y: 144, direction: "up", restored: true });
  assert.equal(player(runtime).x, 112, "early keyboard state cannot defeat authoritative spawn");
});

test("failed reclaim while already on the old chair recovers to free floor", () => {
  const runtime = scene();
  runtime["reserveSeat"] = (_id: string, _x: number, _y: number, done: (ok: boolean) => void) =>
    done(false);
  runtime["isWalkable"] = (x: number, y: number) => x === 6 && y === 7;
  runtime["isTileOccupied"] = () => false;
  runtime["mapObjects"] = [];
  runtime["handlePlayerSpawn"]({
    x: 240,
    y: 272,
    restored: true,
    motion: { targetX: 240, targetY: 272, seatId: "240:272" },
  });
  assert.deepEqual([player(runtime).x, player(runtime).y], [208, 240]);
  assert.equal(runtime["playerSeatGoal"], null);
  assert.equal(runtime["currentPath"], null);
});
test("pending seat ACK keeps the resume target in outgoing movement snapshots", () => {
  const calls: unknown[] = [];
  const goal = { targetX: 240, targetY: 272, seatId: "240:272" };
  const runtime = simulation({
    socket: { connected: true, emit: (...args: unknown[]) => calls.push(args) },
    playerSpawnReady: true,
    peerSnapshotReady: true,
    lastMoveSent: 0,
    lastSentMotion: "",
    currentPath: null,
    playerSeatGoal: null,
    resumingPlayerGoal: goal,
    spawnInputStarted: false,
  });
  runtime["sendPosition"](112, 144, "left", "idle");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["player:move", { x: 112, y: 144, direction: "left", animation: "idle", motion: goal }],
  ]);
});
test("ordinary remote motion snapshots do not cancel a stable remote actor on every packet", () => {
  let cancelled = 0;
  const runtime = simulation({
    socket: { id: "observer" },
    motionSnapshot: { current: { ambientLeaderId: "driver", seats: [] } },
    traffic: { clear() {} },
    now: 100,
    ambientZones: [],
  });
  const npc = npcController({
    homeCol: 2,
    homeRow: 3,
    pixelX: 48,
    pixelY: 48,
    viewX: 48,
    viewY: 48,
    motionLocallyDriven: false,
    cancelMovement() {
      cancelled++;
    },
  });
  runtime["applyMotionNpc"](
    npc,
    {
      npcId: "npc",
      x: 80,
      y: 48,
      direction: "right",
      homeX: 80,
      homeY: 112,
      ownerSocketId: null,
      phase: "ambient",
      moving: true,
      revision: 1,
    },
    false,
  );
  assert.equal(
    cancelled,
    0,
    "stable remote target updates must preserve the presentation timeline",
  );
  assert.deepEqual([npc.pixelX, npc.pixelY], [80, 48], "collision coordinates update immediately");
  assert.deepEqual([npc.viewX, npc.viewY], [48, 48], "presentation catches up per frame, not now");
});
test("stable local leader ignores echoed coordinates and preserves its active path", () => {
  const runtime = simulation({
    socket: { id: "driver" },
    motionSnapshot: { current: { ambientLeaderId: "driver", seats: [] } },
    traffic: { clear() {} },
    now: 100,
    ambientZones: [],
  });
  const path = [{ x: 6, y: 7 }];
  const npc = npcController({
    homeCol: 2,
    homeRow: 3,
    moveState: "strolling",
    pixelX: 90,
    pixelY: 48,
    motionLocallyDriven: true,
    currentPath: path,
    syncView() {
      throw new Error("must not snap driver echo");
    },
    cancelMovement() {
      throw new Error("must not cancel driver path");
    },
  });
  runtime["applyMotionNpc"](
    npc,
    {
      npcId: "npc",
      x: 80,
      y: 48,
      direction: "right",
      homeX: 80,
      homeY: 112,
      ownerSocketId: null,
      phase: "ambient",
      moving: true,
      revision: 1,
    },
    false,
  );
  assert.equal(npc.pixelX, 90);
  assert.equal(npc.currentPath, path);
});
test("legacy duplicate cannot snap a snapshot-driven NPC or clear its walking flag", () => {
  const npc = npcController({
    pixelX: 80,
    pixelY: 48,
    remoteWalkingUntil: 600,
    setPosition() {
      throw new Error("duplicate legacy update");
    },
  });
  const runtime = simulation({
    npcs: [npc],
    motionSnapshot: { current: { npcs: [{ npcId: "npc" }] } },
  });
  runtime["handleLegacyPositionSync"]({ npcId: "npc", x: 80, y: 48, direction: "right" });
  assert.equal(npc.remoteWalkingUntil, 600);
});
test("socket listeners register idempotently and rejoin once per socket id", () => {
  const socket = fakeSocket({ id: "s1" });
  const sim = simulation({
    socket,
    playerReady: true,
    player: { x: 16, y: 16 },
    characterId: "c",
    characterName: "C",
  });
  sim["setupSocketListeners"]();
  sim["setupSocketListeners"]();
  sim["joinMultiplayer"](16, 16);
  sim["joinMultiplayer"](16, 16);
  assert.equal(socket.emitted.filter(([event]) => event === "player:join").length, 1);
  sim["handleSocketRejoin"]();
  assert.equal(socket.emitted.filter(([event]) => event === "player:join").length, 1);
  socket.id = "s2";
  sim["handleSocketRejoin"]();
  assert.equal(socket.emitted.filter(([event]) => event === "player:join").length, 2);
  sim.dispose();
});
void ({} as Socket);
