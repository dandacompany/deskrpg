import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createMeetingSpatialCoordinator } from "./meeting-spatial-coordinator";

function harness() {
  const actors = new Map([
    ["n1", { x: 16, y: 16 }],
    ["n2", { x: 48, y: 16 }],
  ]);
  const occupied = new Set<string>();
  const moves: Array<{ actorId: string; generation: number; x: number; y: number }> = [];
  const coordinator = createMeetingSpatialCoordinator({
    layout: async () => ({
      spaceId: "meeting",
      targets: [
        { seatId: "80:80", x: 80, y: 80 },
        { seatId: null, x: 112, y: 80 },
      ],
    }),
    capture: async (_channel, actorId) =>
      actors.has(actorId) ? { ...actors.get(actorId)!, seatId: null } : null,
    reserve: async (_channel, actorId, target) => {
      const key = `${target.x}:${target.y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
      return true;
    },
    move: async (_channel, actorId, generation, target) => {
      moves.push({ actorId, generation, ...target });
      return true;
    },
    release: async () => {},
    returnTarget: async (_channel, _actorId, origin) => origin,
    publish: () => {},
  });
  return { coordinator, moves, occupied };
}

test("map reset discards preparation and participants and does not reuse the previous arrival generation", async () => {
  const { coordinator: c, occupied } = harness();
  await c.joinPlayer("a", "u1", "socket1");
  const old = await c.start("a", "u1", ["n1"]);
  const ready = c.ready("a", old!);
  c.reset("a");
  assert.equal(await ready, false);
  assert.equal(c.snapshot("a"), null);
  occupied.clear();
  assert.equal(await c.joinPlayer("a", "u1", "socket1"), true);
  assert.equal(occupied.size, 1);
  const fresh = await c.start("a", "u1", ["n1"]);
  assert.ok(fresh! > old!);
  assert.equal(c.arrived("a", "n1", old!), false);
});

test("map reset keeps a delayed join reservation and a pending start from reviving the session", async () => {
  let release!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const c = createMeetingSpatialCoordinator({
    layout: async () => {
      await pending;
      return { spaceId: "old", targets: [{ x: 80, y: 80, seatId: null }] };
    },
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async () => true,
    move: async () => true,
    release: async () => {},
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  const join = c.joinPlayer("a", "u1", "socket1");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const start = c.start("a", "u1", ["n1"]);
  c.reset("a");
  release();
  assert.equal(await join, false);
  assert.equal(await start, null);
  assert.equal(c.snapshot("a"), null);
});

test("a ready meeting also discards the previous ready state and return positions after reset", async () => {
  const { coordinator: c, occupied, moves } = harness();
  const generation = await c.start("a", "u1", ["n1"]);
  c.arrived("a", "n1", generation!);
  assert.equal(await c.ready("a", generation!), true);
  c.reset("a");
  assert.equal(await c.ready("a", generation!), false);
  await c.cancel("a");
  assert.equal(moves.length, 1);
  occupied.clear();
  assert.ok((await c.start("a", "u1", ["n1"]))! > generation!);
});

test("assembly becomes ready only once after everyone arrives on the server, and stale arrivals are ignored", async () => {
  const { coordinator: c, moves } = harness();
  const generation = await c.start("a", "u1", ["n1", "n2"]);
  assert.equal(c.snapshot("a")?.phase, "assembling");
  assert.equal(moves.length, 2);
  assert.equal(await c.start("a", "u1", ["n1"]), null);
  assert.equal(c.arrived("a", "n1", generation! - 1), false);
  c.arrived("a", "n1", generation!);
  assert.equal(c.snapshot("a")?.phase, "assembling");
  c.arrived("a", "n2", generation!);
  assert.equal(await c.ready("a", generation!), true);
  assert.equal(c.snapshot("a")?.phase, "ready");
  assert.equal(c.arrived("a", "n2", generation!), false);
});

test("a failed seat claim is reassigned to standing", async () => {
  const { coordinator: c, occupied, moves } = harness();
  occupied.add("80:80");
  await c.start("a", "u1", ["n1", "n2"]);
  assert.equal(moves[0].x, 112);
});

test("cancel walks back to the original actual position, and a duplicate cancel issues no duplicate commands", async () => {
  const { coordinator: c, moves } = harness();
  const generation = await c.start("a", "u1", ["n1"]);
  await c.cancel("a");
  await c.cancel("a");
  assert.equal(moves.length, 2);
  assert.deepEqual({ x: moves[1].x, y: moves[1].y }, { x: 16, y: 16 });
  assert.equal(c.arrived("a", "n1", generation!), false);
  c.arrived("a", "n1", moves[1].generation);
  assert.equal(c.snapshot("a")?.phase, "idle");
});

test("does not silently drop a selected NPC that doesn't exist", async () => {
  const { coordinator: c } = harness();
  await c.start("a", "u1", ["missing"]);
  assert.deepEqual(c.snapshot("a")?.failure, {
    actorId: "missing",
    reasonCode: "actor_unavailable",
  });
});

test("cancel during the reservation await does not start the old assembly, reclaims the reservation and returns", async () => {
  let finishReserve!: (value: boolean) => void;
  const reserved = new Promise<boolean>((resolve) => {
    finishReserve = resolve;
  });
  const actions: string[] = [];
  let calls = 0;
  const c = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async () => {
      actions.push("reserve");
      return ++calls === 1 ? reserved : true;
    },
    release: async () => {
      actions.push("release");
    },
    move: async (_c, _a, _g, _t, returning) => {
      actions.push(returning ? "return" : "assemble");
      return true;
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  const start = c.start("a", "u1", ["n1"]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(actions, ["reserve"]);
  const cancelled = c.cancel("a");
  finishReserve(true);
  await start;
  await cancelled;
  assert.deepEqual(actions, ["reserve", "release", "reserve", "return"]);
  assert.equal(c.snapshot("a")?.phase, "returning");
});

test("a new start during the return reservation await does not overwrite the return generation", async () => {
  let releaseReturn!: () => void;
  const waiting = new Promise<void>((r) => {
    releaseReturn = r;
  });
  const c = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async () => true,
    move: async () => true,
    release: async () => {
      await waiting;
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  await c.start("a", "u1", ["n1"]);
  const cancel = c.cancel("a");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const generation = c.snapshot("a")!.generation;
  const retry = c.start("a", "u1", ["n1"]);
  releaseReturn();
  await cancel;
  assert.equal(await retry, null);
  assert.equal(c.snapshot("a")!.generation, generation);
});

test("getting stuck while returning becomes a retryable timeout blocked, and old failures are ignored", async () => {
  const c = createMeetingSpatialCoordinator({
    timeoutMs: 5,
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async () => true,
    move: async () => true,
    release: async () => {},
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  await c.start("a", "u1", ["n1"]);
  await c.cancel("a");
  const oldGeneration = c.snapshot("a")!.generation;
  await delay(20);
  assert.deepEqual(c.snapshot("a")?.failure, { actorId: "n1", reasonCode: "return_timeout" });
  const retry = await c.start("a", "u1", ["n1"]);
  assert.ok(retry! > oldGeneration);
  c.block("a", "n1", "path_unavailable", oldGeneration);
  assert.equal(c.snapshot("a")?.phase, "assembling");
  c.arrived("a", "n1", retry!);
});

// Card "NPCs stay in meeting seats after the meeting ends" Acceptance (c).
//
// If the original seat is occupied, `returnTarget` offers the nearest standing spot. Pins that this demotion actually
// leads to **a move that leaves the meeting seat**, and that the session closes as idle.
// If it gets blocked here (`return_space_full`), the NPC stays in the meeting seat.
test("when the original seat is occupied, demotes to a standing spot and leaves the meeting seat", async () => {
  const moves: Array<{ actorId: string; x: number; y: number; seatId: string | null }> = [];
  const occupied = new Set<string>();
  const published: string[] = [];
  const standing = { seatId: null, x: 144, y: 16 };
  const coordinator = createMeetingSpatialCoordinator({
    layout: async () => ({
      spaceId: "meeting",
      targets: [{ seatId: "80:80", x: 80, y: 80 }],
    }),
    capture: async () => ({ x: 16, y: 16, seatId: "16:16" }),
    reserve: async (_channel, _actorId, target) => {
      const key = `${target.x}:${target.y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
      return true;
    },
    move: async (_channel, actorId, _generation, target) => {
      moves.push({ actorId, x: target.x, y: target.y, seatId: target.seatId });
      return true;
    },
    release: async (_channel, actorId) => {
      // Releases the meeting seat reservation — same behavior as the real seat source of truth.
      occupied.delete("80:80");
      void actorId;
    },
    // The original seat (16:16) was taken in the meantime -> demoted to the nearest standing spot.
    returnTarget: async () => standing,
    publish: (state) => published.push(state.phase),
  });
  const generation = await coordinator.start("a", "u1", ["n1"]);
  assert.ok(generation);
  coordinator.arrived("a", "n1", generation);
  assert.equal(coordinator.snapshot("a")?.phase, "ready");

  await coordinator.cancel("a");
  const returnMove = moves.at(-1)!;
  assert.deepEqual(
    [returnMove.x, returnMove.y],
    [standing.x, standing.y],
    "강등된 설 자리로 이동하지 않으면 회의석에 남는다",
  );
  assert.equal(returnMove.seatId, null, "좌석이 아니라 서 있기다");

  const participant = coordinator.snapshot("a")?.participants.find((p) => p.actorId === "n1");
  assert.equal(participant?.state, "returning");
  assert.equal(coordinator.snapshot("a")?.failure, null, "강등은 실패가 아니다");
  coordinator.arrived("a", "n1", coordinator.snapshot("a")!.generation);
  assert.equal(coordinator.snapshot("a")?.phase, "idle", "복귀가 끝나면 회의가 닫힌다");
  assert.ok(published.includes("returning"));
});

// ---------------------------------------------------------------------------
// Someone already sitting in the seat has arrived without moving.
//
// A person's arrival notice only comes from the player **move** handler. So if they were already sitting in that
// spot at the moment the seat was newly reserved and didn't move, the notice never came, and assembly stalled at
// `이동 중` then broke on timeout (observed on staging). Reconnect (new socket) and retry both reserve the seat
// again, so they fall into the same path.
// ---------------------------------------------------------------------------

/** Mimics a socket standing still on a seat. This harness does not call `playerArrived`. */
function seatedHarness(seatedSockets: Set<string>) {
  const occupied = new Map<string, string>();
  const coordinator = createMeetingSpatialCoordinator({
    layout: async () => ({
      spaceId: "meeting",
      targets: [
        { seatId: "80:80", x: 80, y: 80 },
        { seatId: "112:80", x: 112, y: 80 },
      ],
    }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async (_channel, actorId, target) => {
      const key = `${target.x}:${target.y}`;
      const holder = occupied.get(key);
      if (holder && holder !== actorId) return false;
      occupied.set(key, actorId);
      return true;
    },
    move: async () => true,
    release: async (_channel, actorId) => {
      for (const [key, holder] of occupied) if (holder === actorId) occupied.delete(key);
    },
    returnTarget: async (_channel, _actorId, origin) => origin,
    atReservation: async (_channel, socketId) => seatedSockets.has(socketId),
    publish: () => {},
  });
  return coordinator;
}

function playerState(c: ReturnType<typeof seatedHarness>, userId: string) {
  return c.snapshot("a")?.participants.find((p) => p.actorId === userId)?.state;
}

test("a host already sitting in the seat counts as seated without moving, and assembly becomes ready", async () => {
  const c = seatedHarness(new Set(["socket1"]));
  await c.joinPlayer("a", "u1", "socket1");
  assert.equal(playerState(c, "u1"), "seated", "예약 순간 이미 그 자리인데 이동 중으로 남는다");

  const generation = await c.start("a", "u1", ["n1"]);
  const ready = c.ready("a", generation!);
  assert.equal(c.arrived("a", "n1", generation!), true);
  assert.equal(await ready, true, "주재자가 착석인데 집결이 준비되지 않는다");
  assert.equal(c.snapshot("a")?.phase, "ready");
});

test("assembly becomes ready even when the same user rejoins with a new socket and stays still in the seat", async () => {
  // The first socket walked in and sat down.
  const seated = new Set<string>();
  const c = seatedHarness(seated);
  await c.joinPlayer("a", "u1", "socket1");
  seated.add("socket1");
  c.playerArrived("a", "u1", "socket1");
  assert.equal(playerState(c, "u1"), "seated");

  // Disconnected and came back with a new socket — still sitting in the seat on screen and not moving.
  seated.delete("socket1");
  seated.add("socket2");
  await c.joinPlayer("a", "u1", "socket2");
  assert.equal(playerState(c, "u1"), "seated", "재접속이 착석을 이동 중으로 되돌린다");

  const generation = await c.start("a", "u1", ["n1"]);
  const ready = c.ready("a", generation!);
  c.arrived("a", "n1", generation!);
  assert.equal(await ready, true);
});

test("someone not in a seat still has to walk over — immediate arrival handling doesn't create false seating", async () => {
  const c = seatedHarness(new Set());
  await c.joinPlayer("a", "u1", "socket1");
  assert.equal(playerState(c, "u1"), "walking");

  const generation = await c.start("a", "u1", ["n1"]);
  c.arrived("a", "n1", generation!);
  assert.equal(c.snapshot("a")?.phase, "assembling", "주재자가 오지 않았는데 준비됐다");
});

test("assembly passes the opener's socket to capture — so only staff that person called can be brought", async () => {
  const seen: Array<string | undefined> = [];
  const c = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ seatId: "80:80", x: 80, y: 80 }] }),
    capture: async (_channel, _actorId, takeFrom) => {
      seen.push(takeFrom);
      return { x: 16, y: 16, seatId: null };
    },
    reserve: async () => true,
    move: async () => true,
    release: async () => {},
    returnTarget: async (_c, _a, origin) => origin,
    publish: () => {},
  });
  await c.joinPlayer("a", "host", "host-socket");
  await c.joinPlayer("a", "guest", "guest-socket");
  await c.start("a", "host", ["n1"]);
  assert.deepEqual(seen, ["host-socket"], "여는 사람이 아닌 소켓을 넘긴다");
});

/** Seats shared by several sockets of one user: which socket is on which seat, and who holds which reservation. */
function multiSocketHarness(positions: Map<string, { x: number; y: number }>) {
  const holders = new Map<string, string>();
  const released: string[] = [];
  const reserved: Array<{ actorId: string; seatId: string | null }> = [];
  const coordinator = createMeetingSpatialCoordinator({
    layout: async () => ({
      spaceId: "meeting",
      targets: [
        { seatId: "80:80", x: 80, y: 80 },
        { seatId: "112:80", x: 112, y: 80 },
        { seatId: "144:80", x: 144, y: 80 },
      ],
    }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async (_channel, actorId, target) => {
      const key = `${target.x}:${target.y}`;
      const holder = holders.get(key);
      if (holder && holder !== actorId) return false;
      for (const [other, id] of holders) if (id === actorId) holders.delete(other);
      holders.set(key, actorId);
      reserved.push({ actorId, seatId: target.seatId });
      return true;
    },
    move: async () => true,
    release: async (_channel, actorId) => {
      released.push(actorId);
      for (const [key, holder] of holders) if (holder === actorId) holders.delete(key);
    },
    returnTarget: async (_channel, _actorId, origin) => origin,
    position: async (_channel, socketId) => positions.get(socketId) ?? null,
    atReservation: async (_channel, socketId) => {
      const at = positions.get(socketId);
      return (
        !!at &&
        [...holders].some(([key, holder]) => holder === socketId && key === `${at.x}:${at.y}`)
      );
    },
    publish: () => {},
  });
  return { coordinator, holders, released, reserved };
}

test("a player keeps the meeting seat they are already sitting on instead of taking the first free seat", async () => {
  const { coordinator: c, reserved } = multiSocketHarness(new Map([["s1", { x: 144, y: 80 }]]));
  await c.joinPlayer("a", "u1", "s1");
  assert.deepEqual(reserved, [{ actorId: "s1", seatId: "144:80" }]);
  assert.equal(playerState(c, "u1"), "seated");
});

test("another live socket of the same user does not take over a host who is seated", async () => {
  // Tab A sits on its seat; a background tab B of the same user (re)joins the meeting from elsewhere in the room.
  const positions = new Map([
    ["A", { x: 80, y: 80 }],
    ["B", { x: 200, y: 200 }],
  ]);
  const { coordinator: c, released } = multiSocketHarness(positions);
  await c.joinPlayer("a", "u1", "A");
  assert.equal(playerState(c, "u1"), "seated");
  await c.joinPlayer("a", "u1", "B");
  assert.equal(
    playerState(c, "u1"),
    "seated",
    "the background tab moved the seated host to a new seat",
  );
  assert.deepEqual(released, [], "the seated socket lost its reservation");

  const generation = await c.start("a", "u1", ["n1"]);
  const ready = c.ready("a", generation!);
  c.arrived("a", "n1", generation!);
  assert.equal(await ready, true);
  // Arrival reports from the standby socket are ignored; the seated socket is the participant.
  c.playerArrived("a", "u1", "B");
  assert.equal(c.snapshot("a")?.phase, "ready");
});

test("when the seated socket leaves, a standby socket of the same user takes over without breaking the gathering", async () => {
  // Reconnect: the new socket joined while the old one still looked seated, then the old one disconnects.
  const positions = new Map([
    ["old", { x: 80, y: 80 }],
    ["new", { x: 80, y: 80 }],
  ]);
  const { coordinator: c, reserved } = multiSocketHarness(positions);
  await c.joinPlayer("a", "u1", "old");
  await c.joinPlayer("a", "u1", "new");
  const generation = await c.start("a", "u1", ["n1"]);
  const ready = c.ready("a", generation!);
  await c.leavePlayer("a", "u1", "old");
  assert.equal(c.snapshot("a")?.failure, null, "the old socket leaving aborted the gathering");
  assert.equal(reserved.at(-1)?.actorId, "new");
  assert.equal(playerState(c, "u1"), "seated");
  c.arrived("a", "n1", generation!);
  assert.equal(await ready, true);
});

test("a standby socket leaving does not touch the participant", async () => {
  const positions = new Map([
    ["A", { x: 80, y: 80 }],
    ["B", { x: 200, y: 200 }],
  ]);
  const { coordinator: c, released } = multiSocketHarness(positions);
  await c.joinPlayer("a", "u1", "A");
  await c.joinPlayer("a", "u1", "B");
  await c.leavePlayer("a", "u1", "B");
  assert.equal(playerState(c, "u1"), "seated");
  assert.deepEqual(released, []);
});

test("an NPC with no meeting spot left attends from where it stands instead of blocking the gathering", async () => {
  const { coordinator: c, occupied, moves } = harness();
  occupied.add("80:80");
  const generation = await c.start("a", "u1", ["n1", "n2"]);
  const n2 = c.snapshot("a")?.participants.find((p) => p.actorId === "n2");
  assert.deepEqual(
    { state: n2?.state, seatId: n2?.seatId, target: n2?.target },
    { state: "standing", seatId: null, target: null },
  );
  assert.equal(c.snapshot("a")?.failure, null);
  assert.equal(moves.length, 1, "the demoted NPC was sent somewhere");
  const ready = c.ready("a", generation!);
  c.arrived("a", "n1", generation!);
  assert.equal(await ready, true);

  // Ending the meeting does not walk the demoted NPC "back" — it never left.
  await c.cancel("a");
  assert.deepEqual(
    moves.slice(1).map((m) => m.actorId),
    ["n1"],
  );
});
