import test from "node:test";
import { DEFAULT_NPC_MOTION } from "../lib/npc-motion-config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import {
  createNpcCoordination,
  MAX_IDLE_NPC_CHANNELS,
  STALLED_MOTION_MS,
  type CoordinationChannel,
  type NpcMotion,
} from "./npc-coordination";

type Snapshot = {
  channelId: string;
  revision: number;
  ambientLeaderId: string | null;
  npcs: NpcMotion[];
  seats: {
    seatId: string;
    actorId: string;
    ownerSocketId: string;
    x: number;
    y: number;
    spatial?: boolean;
  }[];
};
type Client = { socket: ClientSocket; latest: Snapshot; events: string[] };
test("a delayed meeting reservation does not overwrite the new map's reservation after reset", async () => {
  let delayed = false;
  let release!: (data: CoordinationChannel) => void;
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const h = await harness({
    load: async () => {
      if (!delayed) return channel;
      announce();
      return new Promise<CoordinationChannel>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const client = await h.connect("a");
    await h.coord.reset("a");
    delayed = true;
    const pending = h.coord.spatial.reserve("a", "n1", { x: 128, y: 128, seatId: "128:128" });
    await started;
    await h.coord.reset("a");
    delayed = false;
    const fresh = stateEvent(client, (s) => s.seats.some((seat) => seat.actorId === "n2"));
    assert.equal(
      await h.coord.spatial.reserve("a", "n2", { x: 128, y: 128, seatId: "128:128" }),
      true,
    );
    const snapshot = await fresh;
    release(channel);
    await assert.rejects(pending, /Stale channel load/);
    assert.deepEqual(client.latest, snapshot);
  } finally {
    await h.close();
  }
});
test("a map reset discards validated meeting participant positions", async () => {
  const h = await harness({
    load: async () => ({
      ...channel,
      meetingSpace: {
        id: "meeting",
        version: 1,
        bounds: { x: 0, y: 0, width: 16, height: 16 },
        entry: { x: 1, y: 1 },
        seatIds: [],
        standingPositions: [],
        wallObjectIds: [],
        wallTileKeys: [],
      },
    }),
  });
  try {
    const client = await h.connect("a");
    assert.equal(await h.coord.spatial.isInside("a", client.socket.id!), true);
    await h.coord.reset("a");
    assert.equal(await h.coord.spatial.isInside("a", client.socket.id!), false);
  } finally {
    await h.close();
  }
});
const channel: CoordinationChannel = {
  npcs: [
    { id: "n1", x: 32, y: 32 },
    { id: "n2", x: 64, y: 32 },
    { id: "n3", x: 96, y: 32 },
  ],
  seats: [
    { id: "128:128", x: 128, y: 128 },
    { id: "192:128", x: 192, y: 128 },
    { id: "32:32", x: 32, y: 32 },
  ],
  bounds: { width: 512, height: 512 },
};
const ack = (client: Client, event: string, payload: Record<string, unknown>) =>
  client.socket.timeout(2000).emitWithAck(event, { channelId: "a", ...payload }) as Promise<{
    ok: boolean;
    error?: string;
  }>;
function stateEvent(client: Client, predicate: (state: Snapshot) => boolean) {
  return new Promise<Snapshot>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.socket.off("npc:motion-state", listener);
      reject(new Error("snapshot timeout"));
    }, 2000);
    const listener = (state: Snapshot) => {
      if (predicate(state)) {
        clearTimeout(timeout);
        client.socket.off("npc:motion-state", listener);
        resolve(state);
      }
    };
    client.socket.on("npc:motion-state", listener);
  });
}
async function harness(
  options: {
    now?: () => number;
    load?: (id: string) => Promise<CoordinationChannel>;
    onSpatialPlayerArrival?: (channelId: string, userId: string, socketId: string) => void;
    onSpatialArrival?: (channelId: string, actorId: string, generation: number) => void;
    onSpatialBlocked?: (
      channelId: string,
      actorId: string,
      reason: string,
      generation: number,
    ) => void;
    loadMotionConfig?: (channelId: string) => Promise<unknown>;
  } = {},
) {
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  const players = new Map<
    string,
    { mapId: string; x: number; y: number; userId?: string; characterId?: string }
  >();
  const servers = new Map<string, ServerSocket>();
  const clients: Client[] = [];
  let loads = 0;
  const coord = createNpcCoordination(io, {
    getPlayer: (id) => players.get(id),
    loadChannel: async (id) => {
      loads++;
      return options.load
        ? options.load(id)
        : id === "a"
          ? channel
          : { ...channel, npcs: [{ id: "foreign", x: 32, y: 32 }] };
    },
    now: options.now,
    onSpatialPlayerArrival: options.onSpatialPlayerArrival,
    onSpatialArrival: options.onSpatialArrival,
    onSpatialBlocked: options.onSpatialBlocked,
    loadMotionConfig: options.loadMotionConfig,
  });
  io.on("connection", (socket) => {
    servers.set(socket.id, socket);
    coord.register(socket);
    const channelId = socket.handshake.auth.channel as string | undefined;
    if (channelId) {
      players.set(socket.id, {
        mapId: channelId,
        x: 300,
        y: 350,
        ...socket.handshake.auth.identity,
      });
      void socket.join(channelId);
      void coord.joined(socket, channelId);
    }
    socket.on("disconnect", () => players.delete(socket.id));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  return {
    coord,
    servers,
    players,
    loads: () => loads,
    async connect(
      channelId: string | null = "a",
      identity?: { userId: string; characterId: string },
    ) {
      const socket = connectSocket(`http://127.0.0.1:${address.port}`, {
        transports: ["websocket"],
        forceNew: true,
        autoConnect: false,
        auth: { channel: channelId, identity },
      });
      const client = { socket, latest: null as unknown as Snapshot, events: [] as string[] };
      socket.on("npc:motion-state", (state: Snapshot) => {
        client.latest = state;
        client.events.push("snapshot");
      });
      socket.on("npc:come-to-player", () => client.events.push("call"));
      const ready = channelId
        ? stateEvent(client, () => true)
        : new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.connect();
      await ready;
      clients.push(client);
      return client;
    },
    async close() {
      clients.forEach((client) => client.socket.disconnect());
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

for (const attempt of ["same-seat", "different-seat", "release"] as const) {
  test(`meeting player reservation survives legacy ${attempt}`, async () => {
    let now = 0;
    const arrivals: string[] = [];
    const h = await harness({
      now: () => now,
      onSpatialPlayerArrival: (_channel, userId) => arrivals.push(userId),
    });
    try {
      const a = await h.connect("a", { userId: "meeting-user", characterId: "character" });
      const reserved = stateEvent(a, (s) => s.seats.some((seat) => seat.spatial === true));
      assert.equal(
        await h.coord.spatial.reserve("a", a.socket.id!, { x: 128, y: 128, seatId: "128:128" }),
        true,
      );
      await reserved;
      const result = await ack(
        a,
        attempt === "release" ? "seat:release" : "seat:claim",
        attempt === "release" ? {} : { seatId: attempt === "same-seat" ? "128:128" : "192:128" },
      );
      if (attempt === "same-seat") assert.equal(result.ok, true);
      else assert.equal(result.error, "meeting_reserved");
      assert.equal(a.latest.seats.length, 1);
      assert.equal(a.latest.seats[0].seatId, "128:128");
      assert.equal(a.latest.seats[0].spatial, true);
      now += 1000;
      await h.coord.moved(h.servers.get(a.socket.id!)!, 200, 200);
      now += 1000;
      await h.coord.moved(h.servers.get(a.socket.id!)!, 128, 128);
      assert.deepEqual(arrivals, ["meeting-user"]);
      const released = stateEvent(a, (s) => s.seats.length === 0);
      await h.coord.spatial.release("a", a.socket.id!);
      await released;
    } finally {
      await h.close();
    }
  });
}

for (const home of [true, false]) {
  test(`회의 복귀 완료 후 ${home ? "업무" : "대체"} 좌석은 일반 이동 규칙으로 돌아간다`, async () => {
    let now = 0;
    const h = await harness({ now: () => now });
    try {
      const a = await h.connect();
      const meeting = { x: 128, y: 128, seatId: "128:128" };
      const target = home ? { x: 32, y: 32, seatId: "32:32" } : meeting;
      if (home)
        assert.equal((await ack(a, "seat:claim", { actorId: "n1", seatId: "192:128" })).ok, true);
      assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
      assert.equal(await h.coord.spatial.move("a", "n1", 1, meeting, false), true);
      assert.equal(
        (await ack(a, "seat:claim", { actorId: "n1", seatId: "192:128" })).error,
        "meeting_reserved",
      );
      now += 1000;
      assert.equal(
        (await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "down" }))
          .ok,
        true,
      );
      assert.equal((await ack(a, "npc:arrived", { npcId: "n1", generation: 1 })).ok, true);
      assert.equal((await ack(a, "seat:release", { actorId: "n1" })).error, "meeting_reserved");
      await h.coord.spatial.release("a", "n1");
      assert.equal(await h.coord.spatial.reserve("a", "n1", target), true);
      assert.equal(await h.coord.spatial.move("a", "n1", 2, target, true), true);
      assert.equal(
        (await ack(a, "npc:arrived", { npcId: "n1", generation: 1 })).error,
        "stale_generation",
      );
      if (home)
        assert.equal(
          (await ack(a, "npc:arrived", { npcId: "n1", generation: 2 })).error,
          "not_at_target",
        );
      assert.equal(
        (await ack(a, "seat:claim", { actorId: "n1", seatId: "192:128" })).error,
        "meeting_reserved",
      );
      now += 1000;
      assert.equal(
        (
          await ack(a, "npc:position-update", {
            npcId: "n1",
            x: target.x,
            y: target.y,
            direction: "down",
          })
        ).ok,
        true,
      );
      assert.equal((await ack(a, "npc:arrived", { npcId: "n1", generation: 2 })).ok, true);
      assert.equal(a.latest.npcs[0].phase, home ? "idle" : "ambient");
      assert.equal(a.latest.npcs[0].spatialTarget, null);
      assert.ok(!a.latest.seats.some((seat) => seat.actorId === "n1" && seat.spatial));
      assert.equal((await ack(a, "seat:claim", { seatId: target.seatId })).error, "seat_occupied");
      assert.equal(
        (await ack(a, "seat:release", { actorId: "n1" })).error,
        home ? "not_owner" : undefined,
      );
      assert.equal((await ack(a, "seat:claim", { actorId: "n2", seatId: "192:128" })).ok, true);
      const secondExcursion = await ack(a, "seat:claim", {
        actorId: "n3",
        seatId: home ? "128:128" : "32:32",
      });
      assert.equal(secondExcursion.error, home ? undefined : "ambient_limit");
      assert.equal((await ack(a, "seat:release", { actorId: "n2" })).ok, true);
      if (home) assert.equal((await ack(a, "seat:release", { actorId: "n3" })).ok, true);
      assert.equal((await ack(a, "seat:claim", { actorId: "n1", seatId: "192:128" })).ok, true);
      assert.equal((await ack(a, "seat:release", { actorId: "n1" })).ok, true);
      const b = await h.connect();
      const server = h.servers.get(a.socket.id!)!;
      await server.leave("a");
      await h.coord.left(server, "a");
      assert.equal((await ack(b, "seat:claim", { actorId: "n1", seatId: "192:128" })).ok, true);
    } finally {
      await h.close();
    }
  });
}

test("real sockets reject unauthenticated/cross-channel/nonmember/invalid motion", async () => {
  const h = await harness();
  try {
    const a = await h.connect(),
      b = await h.connect("b"),
      anonymous = await h.connect(null);
    assert.equal((await ack(anonymous, "npc:call", { npcId: "n1" })).error, "forbidden");
    assert.equal((await ack(b, "npc:call", { npcId: "n1" })).error, "forbidden");
    assert.equal((await ack(a, "npc:call", { npcId: "foreign" })).error, "unknown_npc");
    assert.equal((await ack(a, "npc:call", { npcId: "n1" })).ok, true);
    for (const patch of [
      { x: -1, y: 2 },
      { x: 513, y: 2 },
      { x: Number.NaN, y: 2 },
      { x: 2, y: 2, direction: "bad" },
    ])
      assert.equal(
        (await ack(a, "npc:position-update", { npcId: "n1", direction: "down", ...patch })).error,
        "invalid_motion",
      );
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    assert.equal((await ack(a, "npc:arrived", { npcId: "n1" })).error, "forbidden");
  } finally {
    await h.close();
  }
});

test("simultaneous calls atomically choose one owner and publish state before the legacy call", async () => {
  const h = await harness();
  try {
    const a = await h.connect(),
      b = await h.connect();
    a.events.length = b.events.length = 0;
    const results = await Promise.all([
      ack(a, "npc:call", { npcId: "n1" }),
      ack(b, "npc:call", { npcId: "n1" }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok)?.error, "already_claimed");
    const owner = results[0].ok ? a : b,
      loser = owner === a ? b : a;
    assert.equal(owner.latest.npcs[0].ownerSocketId, owner.socket.id);
    assert.equal(loser.latest.npcs[0].ownerSocketId, owner.socket.id);
    assert.ok(owner.events.indexOf("snapshot") < owner.events.indexOf("call"));
    assert.equal(
      (await ack(loser, "npc:position-update", { npcId: "n1", x: 100, y: 100, direction: "down" }))
        .error,
      "not_owner",
    );
    assert.equal((await ack(loser, "npc:return-home", { npcId: "n1" })).error, "not_owner");
  } finally {
    await h.close();
  }
});

test("late join retains waiting, public-seat rest and returning coordinates; homes are authoritative", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 220, y: 200, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    assert.equal((await ack(a, "seat:claim", { actorId: "n2", seatId: "192:128" })).ok, true);
    await ack(a, "npc:position-update", { npcId: "n2", x: 192, y: 128, direction: "up" });
    await ack(a, "npc:arrived", { npcId: "n2" });
    await ack(a, "npc:call", { npcId: "n3" });
    await ack(a, "npc:position-update", { npcId: "n3", x: 250, y: 200, direction: "right" });
    await ack(a, "npc:return-home", { npcId: "n3", homeX: 250, homeY: 200 });
    assert.equal((await ack(a, "npc:arrived", { npcId: "n3" })).error, "not_at_home");
    const late = await h.connect();
    assert.deepEqual(
      late.latest.npcs.map((npc) => [npc.phase, npc.x, npc.y]),
      [
        ["waiting", 220, 200],
        ["ambient", 192, 128],
        ["returning", 250, 200],
      ],
    );
    assert.equal(late.latest.seats[0].actorId, "n2");
    assert.equal(late.latest.npcs[2].homeX, 96);
    assert.equal((await ack(a, "npc:call", { npcId: "n3" })).ok, true);
    // 2026-09-20: re-calling during the walk home used to be a no-op ("idempotent"). But if `npc:arrived`
    // keeps being rejected with `not_at_home` (the state right above), that employee gets stuck in `returning`,
    // and since the call is a no-op they can never be called again — exactly the defect of card `…70uRM`.
    // Now a re-call interrupts the walk home and calls again.
    assert.equal(a.latest.npcs[2].phase, "called", "귀가 중 재호출은 다시 부르는 것이다");
    await ack(a, "npc:return-home", { npcId: "n3", homeX: 250, homeY: 200 });
    await ack(a, "npc:position-update", { npcId: "n3", x: 100, y: 32, direction: "down" });
    assert.equal(
      (await ack(a, "npc:arrived", { npcId: "n3" })).error,
      "not_at_home",
      "4px is not final home",
    );
    await ack(a, "npc:position-update", { npcId: "n3", x: 96, y: 32, direction: "down" });
    assert.equal((await ack(a, "npc:arrived", { npcId: "n3" })).ok, true);
  } finally {
    await h.close();
  }
});

test("elected leader alone drives legacy ambient events and two excursions include public rest/return", async () => {
  const h = await harness();
  try {
    const a = await h.connect(),
      b = await h.connect();
    const driver = b.latest.ambientLeaderId === a.socket.id ? a : b,
      other = driver === a ? b : a;
    const move = (npcId: string) => ({ npcId, x: 240, y: 180, direction: "down" });
    assert.equal((await ack(other, "npc:position-update", move("n1"))).error, "not_owner");
    assert.equal((await ack(driver, "npc:position-update", move("n1"))).ok, true);
    await ack(driver, "npc:arrived", { npcId: "n1" });
    assert.equal(driver.latest.npcs[0].ownerSocketId, null);
    assert.equal((await ack(driver, "npc:position-update", move("n2"))).ok, true);
    assert.equal((await ack(driver, "npc:position-update", move("n3"))).error, "ambient_limit");
    await ack(driver, "npc:return-home", { npcId: "n1" });
    assert.equal((await ack(driver, "npc:position-update", move("n3"))).error, "ambient_limit");
    await ack(driver, "npc:position-update", { npcId: "n1", x: 32, y: 32, direction: "down" });
    await ack(driver, "npc:arrived", { npcId: "n1" });
    assert.equal((await ack(driver, "npc:position-update", move("n3"))).ok, true);
  } finally {
    await h.close();
  }
});

test("seat claims serialize, validate actual occupancy and retain stationary arrived reservations", async () => {
  let time = 0;
  const h = await harness({ now: () => time });
  try {
    const a = await h.connect(),
      b = await h.connect();
    assert.equal((await ack(a, "seat:claim", { seatId: "not-a-seat" })).error, "unknown_seat");
    assert.equal(
      (await ack(a, "seat:claim", { seatId: "32:32" })).error,
      "seat_occupied",
      "unclaimed home is occupied by actual NPC",
    );
    assert.equal(
      (await ack(a, "seat:claim", { seatId: "128:128", actorId: b.socket.id })).error,
      "not_owner",
    );
    const results = await Promise.all([
      ack(a, "seat:claim", { seatId: "128:128" }),
      ack(b, "seat:claim", { seatId: "128:128" }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const owner = results[0].ok ? a : b,
      other = owner === a ? b : a;
    await h.coord.moved(h.servers.get(owner.socket.id!)!, 128, 128);
    time = 120_000;
    assert.equal((await ack(other, "seat:claim", { seatId: "128:128" })).error, "seat_occupied");
    await h.coord.moved(h.servers.get(owner.socket.id!)!, 200, 200);
    assert.equal((await ack(other, "seat:claim", { seatId: "128:128" })).ok, true);
    assert.equal((await ack(other, "seat:release", {})).ok, true);
    assert.equal((await ack(owner, "seat:claim", { seatId: "128:128" })).ok, true);
    time += 60_001;
    assert.equal(
      (await ack(other, "seat:claim", { seatId: "128:128" })).ok,
      true,
      "unarrived lease expires",
    );
  } finally {
    await h.close();
  }
});

test("identityless disconnect releases player seats and transfers called NPC without resetting the empty channel", async () => {
  const h = await harness();
  try {
    const owner = await h.connect(),
      survivor = await h.connect();
    await ack(owner, "npc:call", { npcId: "n1" });
    await ack(owner, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "down" });
    await ack(owner, "seat:claim", { seatId: "192:128" });
    const transferred = stateEvent(survivor, (state) => state.npcs[0].phase === "returning");
    owner.socket.disconnect();
    const state = await transferred;
    assert.equal(state.npcs[0].ownerSocketId, survivor.socket.id);
    assert.equal(state.npcs[0].x, 128);
    assert.equal(state.seats.length, 0);
    survivor.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = await h.connect();
    assert.equal(fresh.latest.npcs[0].phase, "returning");
    assert.equal(fresh.latest.npcs[0].x, 128);
    assert.equal(h.loads(), 1);
  } finally {
    await h.close();
  }
});

test("invalidation refreshes NPC membership while retaining valid motion and occupancy", async () => {
  let data = channel;
  const h = await harness({ load: async () => data });
  try {
    const a = await h.connect();
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 250, y: 250, direction: "down" });
    data = {
      ...channel,
      npcs: [
        { id: "n1", x: 64, y: 64 },
        { id: "new", x: 80, y: 80 },
      ],
    };
    const next = stateEvent(a, (state) => state.npcs.some((npc) => npc.npcId === "new"));
    await h.coord.invalidate("a");
    const state = await next;
    assert.equal(state.npcs[0].x, 250);
    assert.equal(state.npcs[0].homeX, 64);
    assert.equal((await ack(a, "npc:call", { npcId: "n2" })).error, "unknown_npc");
    assert.deepEqual((await h.coord.occupancy("a", a.socket.id)).length, 2);
    assert.deepEqual(await h.coord.occupancy("a"), [
      { x: 250, y: 250 },
      { x: 80, y: 80 },
      { x: 300, y: 350 },
    ]);
  } finally {
    await h.close();
  }
});

test("an authorization check cannot survive a channel switch during deferred loading", async () => {
  let release: ((value: CoordinationChannel) => void) | undefined;
  let calls = 0;
  const h = await harness({
    load: async () =>
      ++calls === 1
        ? channel
        : new Promise<CoordinationChannel>((resolve) => {
            release = resolve;
          }),
  });
  try {
    const a = await h.connect();
    const invalidation = h.coord.invalidate("a");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(release);
    const server = h.servers.get(a.socket.id!)!;
    const received = new Promise<void>((resolve) => server.once("npc:call", () => resolve()));
    const request = ack(a, "npc:call", { npcId: "n1" });
    await received;
    h.players.get(a.socket.id!)!.mapId = "b";
    await server.leave("a");
    release(channel);
    assert.equal((await request).error, "forbidden");
    await invalidation;
  } finally {
    if (release) release(channel);
    await h.close();
  }
});

test("new leader drives ambient state after join and old leader is rejected", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    await ack(a, "npc:position-update", { npcId: "n1", x: 160, y: 100, direction: "down" });
    const b = await h.connect();
    const driver = b.latest.ambientLeaderId === a.socket.id ? a : b,
      other = driver === a ? b : a;
    assert.equal(
      (await ack(driver, "npc:position-update", { npcId: "n1", x: 170, y: 100, direction: "down" }))
        .ok,
      true,
    );
    assert.equal(
      (await ack(other, "npc:position-update", { npcId: "n1", x: 180, y: 100, direction: "down" }))
        .error,
      "not_owner",
    );
    const transferred = stateEvent(other, (state) => state.ambientLeaderId === other.socket.id);
    driver.socket.disconnect();
    const state = await transferred;
    assert.equal(state.npcs[0].ownerSocketId, null);
    assert.equal(state.npcs[0].phase, "ambient");
  } finally {
    await h.close();
  }
});

test("canceling a reserved but unstarted NPC seat visit frees its excursion slot", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    await ack(a, "seat:claim", { actorId: "n1", seatId: "128:128" });
    await ack(a, "seat:claim", { actorId: "n2", seatId: "192:128" });
    await ack(a, "seat:release", { actorId: "n1" });
    assert.equal(a.latest.npcs[0].phase, "idle");
    assert.equal(
      (await ack(a, "npc:position-update", { npcId: "n3", x: 240, y: 240, direction: "down" })).ok,
      true,
    );
  } finally {
    await h.close();
  }
});

import { OFFICE_ENVIRONMENTS, buildOfficeEnvironment } from "../game/three/office-environments";
import { tiledSnapshot } from "../game/three/tiled-preview";
import { furnitureSeats } from "../game/three/seating";
import { deriveChannelMotionLayout, closestValidUnoccupiedSpawn } from "./channel-motion-layout";
import { ACTOR_RADIUS } from "../game/navigation";

for (const { id } of OFFICE_ENVIRONMENTS) {
  test(`real ${id} map allocates 10 NPCs + two simultaneous socket joins without overlap`, async () => {
    const savedMap = buildOfficeEnvironment(id);
    const homes = furnitureSeats(tiledSnapshot(savedMap).objects)
      .slice(0, 10)
      .map((seat, i) => ({
        id: `npc-${i}`,
        positionX: Math.floor(seat.anchorX ?? seat.x),
        positionY: Math.floor(seat.anchorZ ?? seat.z),
      }));
    const layout = deriveChannelMotionLayout({ mapData: JSON.stringify(savedMap) }, homes)!;
    assert.ok(layout);
    assert.equal(layout.npcs.length, 10);
    const http = createServer();
    const io = new Server(http, { transports: ["websocket"] });
    const players = new Map<
      string,
      { mapId: string; x: number; y: number; userId?: string; characterId?: string }
    >();
    const coord = createNpcCoordination(io, {
      getPlayer: (id) => players.get(id),
      loadChannel: async () => layout,
    });
    io.on("connection", (socket) => {
      coord.register(socket);
      void (async () => {
        const live = await coord.occupancy("office", socket.id);
        // Match production order: after the final await, read occupied players and allocate/set synchronously.
        const spawn = closestValidUnoccupiedSpawn(layout, layout.npcs[0], [
          ...live,
          ...players.values(),
        ]);
        if (!spawn) {
          socket.emit("fixture:spawn", null);
          return;
        }
        players.set(socket.id, { mapId: "office", ...spawn });
        await socket.join("office");
        await coord.joined(socket, "office");
        socket.emit("fixture:spawn", spawn);
      })();
      socket.on("disconnect", () => players.delete(socket.id));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address === "object");
    const clients: ClientSocket[] = [];
    const join = () =>
      new Promise<{ x: number; y: number }>((resolve, reject) => {
        const socket = connectSocket(`http://127.0.0.1:${address.port}`, {
          transports: ["websocket"],
          forceNew: true,
        });
        clients.push(socket);
        const timeout = setTimeout(() => reject(new Error("spawn timeout")), 2000);
        socket.once("fixture:spawn", (spawn) => {
          clearTimeout(timeout);
          resolve(spawn);
        });
      });
    try {
      const spawned = await Promise.all([join(), join()]);
      const all = [...layout.npcs, ...spawned];
      assert.equal(all.length, 12);
      for (let i = 0; i < all.length; i++) {
        assert.ok(layout.canStandAt(all[i]), `${i} stands clear of real map furniture`);
        for (let j = 0; j < i; j++)
          assert.ok(
            Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) >= ACTOR_RADIUS * 2 * 32,
            `${i}/${j} maintain disc separation`,
          );
      }
      const coordinates = (points: { x: number; y: number }[]) =>
        points.map(({ x, y }) => `${x}:${y}`).sort();
      assert.deepEqual(coordinates(await coord.occupancy("office")), coordinates(all));
    } finally {
      clients.forEach((client) => client.disconnect());
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
}

test("legacy home position and arrival flushes never consume ambient excursion slots", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    const positions = await Promise.all(
      channel.npcs.map((npc) =>
        ack(a, "npc:position-update", { npcId: npc.id, x: npc.x, y: npc.y, direction: "down" }),
      ),
    );
    assert.ok(positions.every((result) => result.ok));
    assert.ok(a.latest.npcs.every((npc) => npc.phase === "idle" && !npc.moving));
    const arrivals = await Promise.all(
      channel.npcs.map((npc) => ack(a, "npc:arrived", { npcId: npc.id })),
    );
    assert.ok(arrivals.every((result) => result.ok));
    assert.equal(
      (await ack(a, "npc:position-update", { npcId: "n1", x: 140, y: 140, direction: "down" })).ok,
      true,
    );
    assert.equal(
      (await ack(a, "npc:position-update", { npcId: "n2", x: 180, y: 180, direction: "down" })).ok,
      true,
    );
  } finally {
    await h.close();
  }
});

test("prejoin occupancy does not retain empty channels without disconnect room membership", async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 6; i++) await h.coord.occupancy("a");
    assert.equal(h.loads(), 6, "each empty-room preload was evicted after its read");
    await h.connect();
    assert.equal(h.loads(), 7);
    await h.coord.occupancy("a");
    assert.equal(h.loads(), 7, "active room keeps shared authority");
  } finally {
    await h.close();
  }
});

test("invalidation resolving after last disconnect retains the previously active channel", async () => {
  let release: ((value: CoordinationChannel) => void) | undefined;
  let calls = 0;
  const h = await harness({
    load: async () =>
      ++calls === 2
        ? new Promise<CoordinationChannel>((resolve) => {
            release = resolve;
          })
        : channel,
  });
  try {
    const a = await h.connect();
    const invalidation = h.coord.invalidate("a");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(release);
    a.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release(channel);
    await invalidation;
    const next = await h.connect();
    assert.equal(h.loads(), 2);
    assert.ok(next.latest.npcs.every((npc) => npc.phase === "idle"));
  } finally {
    if (release) release(channel);
    await h.close();
  }
});

test("legacy room intent handshakes once through real sockets before confirmed motion and preserves competing ownership", async () => {
  const h = await harness();
  try {
    const caller = await h.connect();
    const observer = await h.connect();
    type Intent = { npcId: string; targetPlayerId: string; reason: string; roomId: string };
    const confirmed: { client: Client; intent: Intent; precedingEvent: string }[] = [];
    const attempts = new Map<Client, number>();
    let settle!: (result: { ok: boolean; error?: string }) => void;
    for (const client of [caller, observer]) {
      client.socket.on("npc:come-to-player", (intent: Intent) => {
        const motion = client.latest.npcs.find((npc) => npc.npcId === intent.npcId);
        if (motion?.ownerSocketId === intent.targetPlayerId && motion.phase === "called") {
          confirmed.push({ client, intent, precedingEvent: client.events.at(-2)! });
          return;
        }
        // The room runtime's legacy event is an intent, not authority. Only its
        // target asks the coordinator; observers wait for the confirmed snapshot.
        if (intent.targetPlayerId !== client.socket.id) return;
        attempts.set(client, (attempts.get(client) ?? 0) + 1);
        void ack(client, "npc:call", intent).then(settle);
      });
    }
    const inject = (target: Client) => {
      const result = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        settle = resolve;
      });
      const intent = {
        npcId: "n1",
        targetPlayerId: target.socket.id!,
        reason: "map-chat",
        roomId: "office-room",
      };
      for (const server of h.servers.values()) server.emit("npc:come-to-player", intent);
      return result;
    };
    const observerClaim = stateEvent(
      observer,
      (state) => state.npcs[0].ownerSocketId === caller.socket.id,
    );
    assert.equal((await inject(caller)).ok, true);
    await observerClaim;
    // An ack round trip drains the observer's preceding ordered event packets.
    assert.equal((await ack(observer, "npc:return-home", { npcId: "n1" })).error, "not_owner");
    assert.equal(attempts.get(caller), 1);
    assert.equal(attempts.get(observer) ?? 0, 0);
    assert.equal(confirmed.length, 2);
    for (const entry of confirmed) {
      assert.equal(entry.precedingEvent, "snapshot");
      assert.equal(entry.intent.reason, "map-chat");
      assert.equal(entry.intent.roomId, "office-room");
      assert.equal(entry.client.latest.npcs[0].ownerSocketId, caller.socket.id);
    }
    const motion = { npcId: "n1", x: 160, y: 100, direction: "down" };
    assert.equal((await ack(caller, "npc:position-update", motion)).ok, true);
    assert.equal((await ack(observer, "npc:position-update", motion)).error, "not_owner");
    assert.equal((await ack(caller, "npc:return-home", { npcId: "n1" })).ok, true);

    // A later room turn targeting the observer cannot steal a returning NPC.
    const conflict = await inject(observer);
    assert.equal(conflict.ok, false);
    assert.equal(attempts.get(observer), 1);
    assert.equal(confirmed.length, 2);
    assert.equal(observer.latest.npcs[0].ownerSocketId, caller.socket.id);
    assert.equal(observer.latest.npcs[0].phase, "returning");
    assert.equal((await ack(observer, "npc:position-update", motion)).error, "not_owner");
    assert.equal((await ack(caller, "npc:position-update", { ...motion, x: 32, y: 32 })).ok, true);
    assert.equal((await ack(caller, "npc:arrived", { npcId: "n1" })).ok, true);
    assert.equal(caller.latest.npcs[0].phase, "idle");
  } finally {
    await h.close();
  }
});

test("ten NPCs and two sockets sustain one hour of seat contention, occupied homes and leader replacement", async () => {
  const map = buildOfficeEnvironment("publishing");
  const anchors = furnitureSeats(tiledSnapshot(map).objects);
  const layout = deriveChannelMotionLayout(
    { mapData: JSON.stringify(map) },
    anchors.slice(0, 10).map((seat, i) => ({
      id: `soak-${i}`,
      positionX: Math.floor(seat.anchorX ?? seat.x),
      positionY: Math.floor(seat.anchorZ ?? seat.z),
    })),
  )!;
  const publicSeats = layout.seats.filter(
    (seat) => !layout.npcs.some((npc) => Math.hypot(npc.x - seat.x, npc.y - seat.y) < 16),
  );
  assert.ok(publicSeats.length >= 3);
  let time = 0;
  const h = await harness({ now: () => time, load: async () => layout });
  const arrivals = new Set<string>();
  let contentions = 0;
  try {
    let clients = [await h.connect(), await h.connect()];
    for (let cycle = 0; cycle < 40; cycle++) {
      const driver = clients.find(
        (client) => client.socket.id === clients.map((entry) => entry.socket.id!).sort()[0],
      )!;
      const observer = clients.find((client) => client !== driver)!;
      const first = layout.npcs[(cycle * 2) % 10];
      const second = layout.npcs[(cycle * 2 + 1) % 10];
      const third = layout.npcs[(cycle * 2 + 2) % 10];
      const [shared, alternate, occupied] = publicSeats;
      const move = (npcId: string, point: { x: number; y: number }) =>
        ack(driver, "npc:position-update", { npcId, ...point, direction: "down" });
      // Actual server occupancy, rather than a test-owned reservation map.
      await h.coord.moved(h.servers.get(observer.socket.id!)!, occupied.x, occupied.y);
      assert.equal(
        (await ack(driver, "seat:claim", { actorId: first.id, seatId: occupied.id })).error,
        "seat_occupied",
      );
      const race = await Promise.all(
        [first, second].map((npc) =>
          ack(driver, "seat:claim", { actorId: npc.id, seatId: shared.id }),
        ),
      );
      assert.equal(race.filter((result) => result.ok).length, 1);
      const winner = race[0].ok ? first : second;
      const loser = winner === first ? second : first;
      assert.equal(
        (await ack(driver, "seat:claim", { actorId: loser.id, seatId: alternate.id })).ok,
        true,
      );
      assert.equal(
        (await ack(driver, "seat:claim", { actorId: third.id, seatId: publicSeats[2].id })).error,
        "seat_occupied",
      );
      assert.equal((await move(third.id, shared)).error, "ambient_limit");
      assert.equal((await move(winner.id, shared)).ok, true);
      assert.equal((await move(loser.id, alternate)).ok, true);
      await ack(driver, "npc:arrived", { npcId: winner.id });
      await ack(driver, "npc:arrived", { npcId: loser.id });
      time += 90_000;
      // Arrived reservations must survive multiple lease periods.
      assert.equal(
        (await ack(observer, "seat:claim", { seatId: shared.id })).error,
        "seat_occupied",
      );
      assert.equal(driver.latest.seats.length, 2);
      assert.equal(new Set(driver.latest.seats.map((seat) => seat.seatId)).size, 2);
      assert.equal(driver.latest.npcs.filter((npc) => npc.phase !== "idle").length, 2);
      await h.coord.moved(h.servers.get(observer.socket.id!)!, winner.x, winner.y);
      await ack(driver, "npc:return-home", { npcId: winner.id });
      assert.equal(
        (await ack(driver, "seat:claim", { actorId: winner.id, seatId: `${winner.x}:${winner.y}` }))
          .error,
        "seat_occupied",
      );
      assert.equal(
        (await move(third.id, shared)).error,
        "ambient_limit",
        "return keeps excursion slot",
      );
      // The client must wait rather than move into an occupied home. Release then retry.
      await h.coord.moved(h.servers.get(observer.socket.id!)!, 300, 350);
      assert.equal(
        (await ack(driver, "seat:claim", { actorId: winner.id, seatId: `${winner.x}:${winner.y}` }))
          .ok,
        true,
      );
      assert.equal((await move(winner.id, winner)).ok, true);
      assert.equal((await ack(driver, "npc:arrived", { npcId: winner.id })).ok, true);
      await ack(driver, "npc:return-home", { npcId: loser.id });
      assert.equal((await move(loser.id, loser)).ok, true);
      assert.equal((await ack(driver, "npc:arrived", { npcId: loser.id })).ok, true);
      arrivals.add(winner.id);
      arrivals.add(loser.id);
      contentions++;
      assert.equal(driver.latest.npcs.filter((npc) => npc.phase !== "idle").length, 0);
      assert.equal(driver.latest.seats.length, 0, "return clears stale reservations each cycle");
      if (cycle === 19) {
        const elected = stateEvent(
          observer,
          (state) => state.ambientLeaderId === observer.socket.id,
        );
        driver.socket.disconnect();
        await elected;
        clients = [observer, await h.connect()];
      }
    }
    assert.equal(time, 3_600_000);
    assert.equal(contentions, 40);
    assert.equal(arrivals.size, 10, "every NPC repeatedly arrives home");
  } finally {
    await h.close();
  }
});

test("last-member refresh retains ambient coordinates, public seat and excursion through prejoin reads", async () => {
  let time = 0;
  const h = await harness({ now: () => time });
  try {
    const a = await h.connect();
    await ack(a, "seat:claim", { actorId: "n1", seatId: "128:128" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    time += 1500;
    assert.ok((await h.coord.occupancy("a")).some((p) => p.x === 128 && p.y === 128));
    const b = await h.connect();
    assert.equal(b.latest.npcs[0].phase, "ambient");
    assert.equal(b.latest.npcs[0].x, 128);
    assert.equal(b.latest.npcs[0].moving, false);
    assert.equal(b.latest.seats[0].actorId, "n1");
    assert.equal(b.latest.seats[0].ownerSocketId, b.socket.id);
    assert.equal(h.loads(), 1);
  } finally {
    await h.close();
  }
});

test("leader disconnect transfers an ambient seat without sending its occupant home", async () => {
  const h = await harness();
  try {
    const a = await h.connect(),
      b = await h.connect();
    const driver = b.latest.ambientLeaderId === a.socket.id ? a : b;
    const survivor = driver === a ? b : a;
    await ack(driver, "seat:claim", { actorId: "n1", seatId: "128:128" });
    await ack(driver, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(driver, "npc:arrived", { npcId: "n1" });
    const server = h.servers.get(driver.socket.id!)!;
    await server.leave("a");
    const update = stateEvent(survivor, (s) => s.ambientLeaderId === survivor.socket.id);
    await h.coord.left(server, "a");
    const state = await update;
    assert.equal(state.npcs[0].phase, "ambient");
    assert.equal(state.npcs[0].ownerSocketId, null);
    assert.equal(state.seats[0].ownerSocketId, survivor.socket.id);
    assert.equal(
      (await ack(survivor, "seat:claim", { actorId: "n2", seatId: "128:128" })).error,
      "seat_occupied",
    );
  } finally {
    await h.close();
  }
});

test("same authenticated character reclaims a waiting NPC and its player seat during disconnect grace", async () => {
  const h = await harness();
  try {
    const identity = { userId: "u1", characterId: "c1" };
    const a = await h.connect("a", identity);
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    await ack(a, "seat:claim", { seatId: "192:128" });
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    const b = await h.connect("a", identity);
    assert.equal(b.latest.npcs[0].phase, "waiting");
    assert.equal(b.latest.npcs[0].ownerSocketId, b.socket.id);
    assert.equal(b.latest.npcs[0].x, 128);
    assert.equal(b.latest.seats[0].actorId, b.socket.id);
    assert.equal(b.latest.seats[0].ownerSocketId, b.socket.id);
  } finally {
    await h.close();
  }
});

test("continuation survives idle heartbeat, leader handoff and last-member reconnect", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    const continuation = {
      ambientSchedule: { phase: "rest", elapsed: 22000, duration: 75000, pause: 800 },
      ambientSeat: { x: 1, y: 1 },
      ambientTimer: 450,
      path: [],
    };
    assert.equal((await ack(a, "npc:continuation-update", { npcId: "n1", continuation })).ok, true);
    assert.equal(a.latest.npcs[0].phase, "idle", "heartbeat must not invent an excursion");
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    const b = await h.connect();
    assert.deepEqual(
      (b.latest.npcs[0] as NpcMotion & { continuation?: unknown }).continuation,
      continuation,
    );
    assert.equal(b.latest.npcs[0].phase, "idle");
    const roam = {
      ...continuation,
      ambientSchedule: { phase: "roam", elapsed: 1200, duration: 25000, pause: 800 },
      path: [{ x: 4, y: 4 }],
    };
    assert.equal(
      (
        await ack(b, "npc:position-update", {
          npcId: "n1",
          x: 80,
          y: 80,
          direction: "right",
          continuation: roam,
        })
      ).ok,
      true,
    );
    const c = await h.connect();
    assert.deepEqual(
      (c.latest.npcs[0] as NpcMotion & { continuation?: unknown }).continuation,
      roam,
    );
  } finally {
    await h.close();
  }
});

test("inactive authenticated ambient seat outlives caller grace but room cache expires after a day", async () => {
  let time = 0;
  const h = await harness({ now: () => time });
  try {
    const a = await h.connect("a", { userId: "u", characterId: "c" });
    await ack(a, "seat:claim", { actorId: "n1", seatId: "128:128" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    time = 31_000;
    const b = await h.connect();
    assert.equal(b.latest.seats[0]?.actorId, "n1");
    assert.equal(b.latest.npcs[0].phase, "ambient");
    const nextServer = h.servers.get(b.socket.id!)!;
    await nextServer.leave("a");
    await h.coord.left(nextServer, "a");
    time += 24 * 60 * 60 * 1000 + 1;
    const c = await h.connect();
    assert.equal(c.latest.npcs[0].phase, "idle");
    assert.equal(c.latest.npcs[0].x, 32);
    assert.equal(h.loads(), 2);
  } finally {
    await h.close();
  }
});

test("idle invalidation preserves live NPC coordinates while refreshing membership", async () => {
  let release: ((data: CoordinationChannel) => void) | undefined;
  let count = 0;
  const h = await harness({
    load: async () =>
      ++count === 2
        ? new Promise<CoordinationChannel>((resolve) => {
            release = resolve;
          })
        : channel,
  });
  try {
    const a = await h.connect();
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    const invalidation = h.coord.invalidate("a");
    await new Promise((resolve) => setImmediate(resolve));
    a.socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release!(channel);
    await invalidation;
    const b = await h.connect();
    assert.equal(b.latest.npcs[0].x, 128);
    assert.equal(b.latest.npcs[0].phase, "ambient");
    assert.equal(h.loads(), 2);
  } finally {
    release?.(channel);
    await h.close();
  }
});

test("disconnect grace cannot be stolen by another identity and eventually releases caller ownership", async () => {
  let time = 0;
  const h = await harness({ now: () => time });
  try {
    const a = await h.connect("a", { userId: "u1", characterId: "c" });
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    await ack(a, "seat:claim", { seatId: "192:128" });
    const oldId = a.socket.id!;
    const server = h.servers.get(oldId)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    const b = await h.connect("a", { userId: "u2", characterId: "c" });
    assert.equal(b.latest.npcs[0].ownerSocketId, oldId);
    assert.equal((await ack(b, "npc:call", { npcId: "n1" })).error, "already_claimed");
    assert.equal((await ack(b, "seat:claim", { seatId: "192:128" })).error, "seat_occupied");
    time = 30_001;
    assert.equal((await ack(b, "seat:claim", { seatId: "192:128" })).ok, true);
    assert.equal(b.latest.npcs[0].phase, "returning");
    assert.equal(b.latest.npcs[0].ownerSocketId, b.socket.id);
    assert.equal(b.latest.npcs[0].x, 128);
  } finally {
    await h.close();
  }
});

test("continuation heartbeat rejects foreign drivers and invalid data without changing motion", async () => {
  const h = await harness();
  try {
    const a = await h.connect(),
      b = await h.connect();
    const driver = b.latest.ambientLeaderId === a.socket.id ? a : b;
    const other = driver === a ? b : a;
    const continuation = {
      ambientSchedule: { phase: "rest", elapsed: 22000, duration: 75000, pause: 800 },
    };
    assert.equal(
      (await ack(other, "npc:continuation-update", { npcId: "n1", continuation })).error,
      "not_owner",
    );
    assert.equal(
      (await ack(driver, "npc:continuation-update", { npcId: "n1", continuation })).ok,
      true,
    );
    const before = structuredClone(driver.latest.npcs[0]);
    assert.equal(
      (
        await ack(driver, "npc:position-update", {
          npcId: "n1",
          x: 150,
          y: 150,
          direction: "left",
          continuation: { ...continuation, path: [{ x: 1000, y: 0 }] },
        })
      ).error,
      "invalid_continuation",
    );
    assert.deepEqual(driver.latest.npcs[0], before);
    assert.equal(
      (await ack(driver, "npc:continuation-update", { npcId: "n1", continuation: null })).ok,
      true,
    );
    assert.equal(driver.latest.npcs[0].continuation, null);
  } finally {
    await h.close();
  }
});

test("a replacement connection joining before old disconnect inherits its authenticated NPC claim", async () => {
  const h = await harness();
  try {
    const identity = { userId: "u1", characterId: "c1" };
    const a = await h.connect("a", identity);
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    const b = await h.connect("a", identity);
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    const update = stateEvent(b, () => true);
    await h.coord.left(server, "a");
    const state = await update;
    assert.equal(state.npcs[0].ownerSocketId, b.socket.id);
    assert.equal(state.npcs[0].phase, "waiting");
  } finally {
    await h.close();
  }
});

test("inactive room cache evicts its oldest room at capacity while keeping recent shared state", async () => {
  const h = await harness();
  try {
    for (let i = 0; i <= MAX_IDLE_NPC_CHANNELS; i++) {
      const channelId = `room-${i}`;
      const client = await h.connect(channelId);
      const server = h.servers.get(client.socket.id!)!;
      await server.leave(channelId);
      await h.coord.left(server, channelId);
      client.socket.disconnect();
    }
    const loads = h.loads();
    await h.coord.occupancy(`room-${MAX_IDLE_NPC_CHANNELS}`);
    assert.equal(h.loads(), loads, "recently active room retained");
    await h.coord.occupancy("room-0");
    assert.equal(h.loads(), loads + 1, "oldest inactive state was evicted");
  } finally {
    await h.close();
  }
});

test("map refresh resets live walkers, reservations and destinations against the new layout", async () => {
  let current = channel;
  const h = await harness({ load: async () => current });
  try {
    const a = await h.connect("a"),
      b = await h.connect("a");
    assert.equal((await ack(a, "npc:call", { npcId: "n1" })).ok, true);
    assert.equal(
      (await ack(a, "npc:position-update", { npcId: "n1", x: 220, y: 200, direction: "down" })).ok,
      true,
    );
    assert.equal((await ack(b, "seat:claim", { seatId: "128:128" })).ok, true);
    current = { ...channel, npcs: [{ id: "n1", x: 320, y: 320 }], seats: [] };
    await h.coord.reset("a");
    const positions = await h.coord.occupancy("a");
    assert.ok(positions.some((p) => p.x === 320 && p.y === 320));
    assert.ok(!positions.some((p) => p.x === 32 && p.y === 32));
    const snapshotReady = stateEvent(b, () => true);
    await h.coord.joined(h.servers.get(b.socket.id!)!, "a");
    const snapshot = await snapshotReady;
    assert.deepEqual(snapshot.seats, []);
    assert.equal(snapshot.npcs[0].phase, "idle");
    assert.equal(snapshot.npcs[0].moving, false);
    assert.equal(snapshot.npcs[0].continuation ?? null, null);
  } finally {
    await h.close();
  }
});

test("an in-flight actor claim cannot publish an evicted layout after map refresh", async () => {
  let delayed = false;
  let release!: (value: CoordinationChannel) => void;
  let announce!: () => void;
  const started = new Promise<void>((r) => {
    announce = r;
  });
  const h = await harness({
    load: async () => {
      if (!delayed) return channel;
      announce();
      return new Promise<CoordinationChannel>((r) => {
        release = r;
      });
    },
  });
  try {
    const client = await h.connect("a");
    await h.coord.reset("a");
    delayed = true;
    const pending = ack(client, "npc:call", { npcId: "n1" });
    await started;
    await h.coord.reset("a");
    delayed = false;
    release(channel);
    assert.equal((await pending).ok, false, "evicted state must not retain authority");
  } finally {
    await h.close();
  }
});

test("roster reallocation changes authoritative home and discards an ambient continuation to the previous home", async () => {
  let current = channel;
  const h = await harness({ load: async () => current });
  try {
    const a = await h.connect("a");
    assert.equal(
      (
        await ack(a, "npc:position-update", {
          npcId: "n1",
          x: 220,
          y: 200,
          direction: "down",
          continuation: {
            ambientSchedule: { phase: "roam", elapsed: 1200, duration: 25000, pause: 800 },
            path: [{ x: 1, y: 1 }],
          },
        })
      ).ok,
      true,
    );
    current = {
      ...channel,
      sanitizedHomes: true,
      npcs: channel.npcs.map((n) => (n.id === "n1" ? { ...n, x: 320, y: 320 } : n)),
    };
    const changed = stateEvent(a, (s) => s.npcs[0].homeX === 320);
    await h.coord.invalidate("a");
    const snapshot = await changed;
    const npc = snapshot.npcs[0];
    assert.equal(npc.continuation ?? null, null);
    assert.equal(npc.phase, "idle");
    assert.equal(npc.homeY, 320);
    assert.deepEqual([npc.x, npc.y], [320, 320]);
  } finally {
    await h.close();
  }
});

test("delayed v2 invalidation cannot overwrite fresh v3 clients after reset", async () => {
  let loads = 0;
  let release!: (data: CoordinationChannel) => void;
  let announce!: () => void;
  const waiting = new Promise<void>((r) => {
    announce = r;
  });
  const v3 = {
    ...channel,
    sanitizedHomes: true,
    npcs: channel.npcs.map((n) => ({ ...n, x: n.x + 288, y: n.y + 288 })),
  };
  const h = await harness({
    load: async () => {
      loads++;
      if (loads === 1) return channel;
      if (loads === 2) {
        announce();
        return new Promise<CoordinationChannel>((r) => {
          release = r;
        });
      }
      return v3;
    },
  });
  try {
    const old = await h.connect("a");
    await ack(old, "npc:call", { npcId: "n1" });
    const oldRevision = old.latest.revision;
    const pending = h.coord.invalidate("a");
    await waiting;
    await h.coord.reset("a");
    h.players.clear();
    old.socket.disconnect();
    const fresh = await h.connect("a");
    const snapshotBefore = structuredClone(fresh.latest);
    release(channel);
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fresh.latest.npcs[0].homeX, 320, "stale v2 must never broadcast over v3");
    assert.deepEqual(fresh.latest, snapshotBefore);
    assert.ok(
      fresh.latest.revision > oldRevision,
      "new epoch revision must exceed all old geometry revisions",
    );
    assert.equal((await h.coord.occupancy("a"))[0].x, 320);
  } finally {
    await h.close();
  }
});

// Card "Calling an employee dies with no reaction — the only NPC ownership release path is arriving home".
//
// As "same authenticated character reclaims a waiting NPC" above shows, reconnecting with the same identity
// **already** moves ownership to the new socket. So pressing call in a new tab
// enters the "I am already the owner" branch, which used to only broadcast and silently return, so
// `npc:come-to-player` never went out — nobody moved and there was no error.
// (Measured 2026-09-20: one employee was in this state. Clocking out → in was the only workaround.)
test("a re-call from the same socket re-emits come-to-player", async () => {
  const h = await harness();
  try {
    const identity = { userId: "u1", characterId: "c1" };
    const a = await h.connect("a", identity);
    await ack(a, "npc:call", { npcId: "n1" });
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "left" });
    await ack(a, "npc:arrived", { npcId: "n1" });
    assert.equal(a.latest.npcs[0].phase, "waiting");

    // New tab (same identity) — ownership has moved to this socket.
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    const b = await h.connect("a", identity);
    assert.equal(b.latest.npcs[0].ownerSocketId, b.socket.id, "소유권이 새 탭으로 넘어와야 한다");

    const called = new Promise<{ npcId: string; targetPlayerId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("come-to-player 가 오지 않았다")), 2000);
      b.socket.once("npc:come-to-player", (payload: { npcId: string; targetPlayerId: string }) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });
    assert.equal((await ack(b, "npc:call", { npcId: "n1" })).ok, true);
    const payload = await called;
    assert.equal(payload.npcId, "n1");
    assert.equal(payload.targetPlayerId, b.socket.id, "부른 사람에게 오라고 해야 한다");
    assert.equal(b.latest.npcs[0].phase, "called");
  } finally {
    await h.close();
  }
});

// The minimum for Direction 2: once the reconnect grace ends, ownership must be cleared, and **the next call**
// must reclaim it. After the grace expires, `prune` hands ownership to that channel's leader and sets phase to
// `returning` — that leader is not the person who called the employee but the driver that runs the animation.
// If that state blocks another user's call with `already_claimed`, a callable employee becomes uncallable.
test("ownership left over after the grace ends does not block another user's call", async () => {
  let time = 0;
  const h = await harness({ now: () => time });
  try {
    const a = await h.connect("a", { userId: "u1", characterId: "c1" });
    const b = await h.connect("a", { userId: "u2", characterId: "c2" });
    const c = await h.connect("a", { userId: "u3", characterId: "c3" });
    await ack(a, "npc:call", { npcId: "n1" });
    const oldId = a.socket.id!;
    const server = h.servers.get(oldId)!;
    await server.leave("a");
    await h.coord.left(server, "a");
    assert.equal(
      (await ack(b, "npc:call", { npcId: "n1" })).error,
      "already_claimed",
      "유예 중에는 지켜진다",
    );

    time = 30_001;
    // The grace has ended. Whether the leader is c or b, **the caller** is b.
    const called = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("come-to-player 가 오지 않았다")), 2000);
      b.socket.once("npc:come-to-player", (payload: { targetPlayerId: string }) => {
        clearTimeout(timeout);
        resolve(payload.targetPlayerId);
      });
    });
    assert.equal(
      (await ack(b, "npc:call", { npcId: "n1" })).ok,
      true,
      "유예가 끝났는데도 남은 소유권이 호출을 막고 있다",
    );
    assert.equal(await called, b.socket.id);
    assert.equal(b.latest.npcs[0].ownerSocketId, b.socket.id);
    assert.equal(b.latest.npcs[0].phase, "called");
    // Flush the queued packets to c with one side-effect-free ack (an existing idiom in this file).
    assert.equal((await ack(c, "npc:call", { npcId: "nope" })).error, "unknown_npc");
    assert.equal(c.latest.npcs[0].ownerSocketId, b.socket.id, "다른 사람에게도 같은 사실이 보인다");
    assert.equal(c.latest.npcs[0].phase, "called");
  } finally {
    await h.close();
  }
});

// Card "NPCs stay in the meeting seats even after the meeting ends".
//
// The walk back from a meeting is driven by the owning browser (the server only sets `phase="called"` +
// `spatialTarget`). When a solo user leaves, the drivers drop to 0, and it used to freeze with no owner, stopped, and
// `spatialTarget` left over — the meeting seat stayed occupied and re-entering did not resume it (the resume loop
// only looks at phase `returning`). A walk nobody is watching has no reason to be replayed, so **the server settles
// the outcome.**
test("if the return driver disappears and nobody is left, the server settles to the target", async () => {
  const arrivals: { actorId: string; generation: number }[] = [];
  const blocked: string[] = [];
  const h = await harness({
    onSpatialArrival: (_channelId, actorId, generation) => arrivals.push({ actorId, generation }),
    onSpatialBlocked: (_channelId, actorId, reason) => blocked.push(`${actorId}:${reason}`),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    const desk = { x: 32, y: 32, seatId: "32:32" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 1, meeting, false), true);
    await ack(a, "npc:position-update", { npcId: "n1", x: 128, y: 128, direction: "down" });
    await ack(a, "npc:arrived", { npcId: "n1", generation: 1 });
    // The meeting ended — walking back to their seat.
    await h.coord.spatial.release("a", "n1");
    assert.equal(await h.coord.spatial.reserve("a", "n1", desk), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 2, desk, true), true);
    arrivals.length = 0;

    // The only user leaves the map (the exact moment Dante hit).
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");

    assert.deepEqual(
      arrivals,
      [{ actorId: "n1", generation: 2 }],
      "정산이 회의 세션에 도착으로 보고돼야 회의석이 풀린다",
    );
    assert.deepEqual(blocked, [], "구동자가 없다는 이유로 세션을 죽이지 않는다");

    // The state seen after re-entering = Acceptance (a).
    const back = await h.connect();
    const npc = back.latest.npcs.find((entry) => entry.npcId === "n1")!;
    assert.deepEqual([npc.x, npc.y], [desk.x, desk.y], "NPC 가 자기 자리에 있어야 한다");
    assert.equal(npc.spatialTarget ?? null, null, "회의 이동이 남아 있으면 다음 회의가 막힌다");
    assert.equal(npc.moving, false);
    assert.equal(npc.phase, "idle");
    assert.equal(npc.ownerSocketId, null);
  } finally {
    await h.close();
  }
});

test("if members remain, one takes over the return walk and keeps walking", async () => {
  const blocked: string[] = [];
  const h = await harness({
    onSpatialBlocked: (_channelId, actorId, reason) => blocked.push(`${actorId}:${reason}`),
  });
  try {
    const a = await h.connect();
    const b = await h.connect();
    const desk = { x: 32, y: 32, seatId: "32:32" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", desk), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 1, desk, true), true);
    // Read the **actual** driver after flushing the snapshot — the join-time snapshot has no owner, so
    // skipping this lets the test pass even after disconnecting the wrong side (measured).
    assert.equal((await ack(b, "npc:call", { npcId: "nope" })).error, "unknown_npc");
    const driverId = b.latest.npcs[0].ownerSocketId;
    assert.ok(driverId, "회의 이동에는 구동자가 있어야 한다");
    const driver = driverId === a.socket.id ? a : b;
    const survivor = driver === a ? b : a;

    const server = h.servers.get(driver.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");

    assert.equal((await ack(survivor, "npc:call", { npcId: "nope" })).error, "unknown_npc");
    const npc = survivor.latest.npcs[0];
    assert.equal(npc.ownerSocketId, survivor.socket.id, "남은 브라우저가 이어받아야 한다");
    assert.equal(npc.moving, true, "넘겨받았으면 계속 걸어야 한다");
    assert.ok(npc.spatialTarget, "회의 복귀 목표가 유지돼야 한다");
    assert.deepEqual(blocked, [], "승계가 되는데 세션을 죽이면 회의가 blocked 로 남는다");
  } finally {
    await h.close();
  }
});

test("with no browser at all to drive it, the meeting return move is settled immediately", async () => {
  const arrivals: string[] = [];
  const h = await harness({
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
  });
  try {
    // The path where the channel was brought up once and the meeting ends with nobody left (cron, automation).
    const a = await h.connect();
    const desk = { x: 32, y: 32, seatId: "32:32" };
    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");

    assert.equal(
      await h.coord.spatial.move("a", "n1", 7, desk, true),
      true,
      "구동자가 없다는 이유로 복귀가 실패하면 NPC 가 회의석에 남는다",
    );
    assert.deepEqual(arrivals, ["n1"]);
    const back = await h.connect();
    const npc = back.latest.npcs.find((entry) => entry.npcId === "n1")!;
    assert.deepEqual([npc.x, npc.y], [desk.x, desk.y]);
    assert.equal(npc.spatialTarget ?? null, null);
  } finally {
    await h.close();
  }
});

// The driver disappearing while **heading into** a meeting is different. A meeting cannot proceed without a user, so
// the session must be blocked (`driver_disconnected`), but freezing the NPC mid-walk and holding the meeting seat
// reservation would keep the next meeting from opening too — clear the meeting seat and settle in place.
test("if the driver disappears on the way to a meeting, the meeting seat is cleared and settled in place", async () => {
  const blocked: string[] = [];
  const h = await harness({
    onSpatialBlocked: (_channelId, actorId, reason) => blocked.push(`${actorId}:${reason}`),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    const home = { x: a.latest.npcs[0].homeX, y: a.latest.npcs[0].homeY };

    const server = h.servers.get(a.socket.id!)!;
    await server.leave("a");
    await h.coord.left(server, "a");

    assert.deepEqual(blocked, ["n1:driver_disconnected"], "회의는 사용자 없이 진행할 수 없다");
    const back = await h.connect();
    const npc = back.latest.npcs.find((entry) => entry.npcId === "n1")!;
    assert.equal(npc.spatialTarget ?? null, null, "회의 이동이 남으면 다음 회의가 막힌다");
    assert.deepEqual([npc.x, npc.y], [home.x, home.y], "제자리로 정산한다");
    assert.equal(
      back.latest.seats.some((seat) => seat.seatId === meeting.seatId),
      false,
      "회의석 예약이 남아 있으면 좌석 수 계산이 어긋난다",
    );
  } finally {
    await h.close();
  }
});

test("atReservation — someone standing still on the seat counts as arrived without moving (same rule as the move notice)", async () => {
  let now = 0;
  const arrivals: string[] = [];
  const h = await harness({
    now: () => now,
    onSpatialPlayerArrival: (_channel, userId) => arrivals.push(userId),
  });
  try {
    const a = await h.connect("a", { userId: "seated-user", characterId: "character" });
    const seat = { x: 128, y: 128, seatId: "128:128" };
    // Arrive on the seat first and stop — no reservation at this point, so no arrival notice.
    now += 1000;
    await h.coord.moved(h.servers.get(a.socket.id!)!, 200, 200);
    now += 1000;
    await h.coord.moved(h.servers.get(a.socket.id!)!, 128, 128);
    assert.deepEqual(arrivals, [], "예약 전에는 통지가 없어야 한다");
    assert.equal(await h.coord.spatial.atReservation("a", a.socket.id!), false, "예약이 없다");

    // Now reserve that spot. Since there is no further movement, no move notice arrives.
    assert.equal(await h.coord.spatial.reserve("a", a.socket.id!, seat), true);
    assert.deepEqual(arrivals, [], "움직이지 않았으니 이동 통지는 여전히 없다");
    assert.equal(
      await h.coord.spatial.atReservation("a", a.socket.id!),
      true,
      "좌석 위에 있는데 도착으로 보지 않는다 — 집결이 이동 중에서 멈춘다",
    );

    // Must be the same rule: outside the radius, neither counts as arrived.
    now += 1000;
    await h.coord.moved(h.servers.get(a.socket.id!)!, 131, 128);
    assert.equal(await h.coord.spatial.atReservation("a", a.socket.id!), false);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// The person opening a meeting takes the employee they called into the meeting.
//
// An employee bound to someone's call got no origin from `capture()`, so the gathering broke with
// "참가자를 찾을 수 없습니다". If the call is owned by the opener's **own socket**, release it and take them along. The origin
// is not the current spot they were dragged to by the call but **their own seat (home)** — they must not go back
// next to the host when the meeting ends. An employee someone else holds is never taken.
// ---------------------------------------------------------------------------

test("capture — releases an employee the opener called, and the origin is their own seat before the call", async () => {
  let now = 0;
  const h = await harness({ now: () => now });
  try {
    const a = await h.connect("a", { userId: "host", characterId: "c1" });
    const home = a.latest.npcs.find((n) => n.npcId === "n1")!;
    const homeAt = { x: home.homeX, y: home.homeY };
    assert.equal((await ack(a, "npc:call", { npcId: "n1" })).ok, true);
    // Walked next to the host via the call.
    now += 1000;
    await ack(a, "npc:position-update", { npcId: "n1", x: 250, y: 250, direction: "down" });
    assert.equal(
      await h.coord.spatial.capture("a", "n1"),
      null,
      "여는 사람을 모르면 지금처럼 캡처하지 않는다",
    );

    const released = stateEvent(
      a,
      (st) => st.npcs.find((n) => n.npcId === "n1")?.ownerSocketId === null,
    );
    const origin = await h.coord.spatial.capture("a", "n1", a.socket.id!);
    assert.ok(origin, "내가 부른 직원을 회의로 데려가지 못한다");
    // The call must actually be released. Changing only phase lets the walk through (an ambient off its seat
    // bypasses the ownership check) but the screen still shows "내 호출에 대기".
    await released;
    assert.deepEqual(
      { x: origin.x, y: origin.y },
      homeAt,
      "원위치가 호출로 끌려온 자리다 — 회의가 끝나면 주재자 옆으로 돌아간다",
    );
    // Released, so the meeting walk is not blocked by the ownership check.
    assert.equal(
      await h.coord.spatial.move("a", "n1", 1, { x: 128, y: 128, seatId: "128:128" }, false),
      true,
      "캡처는 됐는데 여전히 호출에 묶여 회의 좌석으로 못 간다",
    );
  } finally {
    await h.close();
  }
});

test("capture — does not take an employee another user called", async () => {
  const h = await harness();
  try {
    const host = await h.connect("a", { userId: "host", characterId: "c1" });
    const other = await h.connect("a", { userId: "other", characterId: "c2" });
    assert.equal((await ack(other, "npc:call", { npcId: "n1" })).ok, true);
    assert.equal(
      await h.coord.spatial.capture("a", "n1", host.socket.id!),
      null,
      "남이 데리고 있는 직원을 회의가 빼앗았다",
    );
    // Ownership is unchanged too — the caller keeps holding them.
    assert.equal((await ack(host, "npc:call", { npcId: "n1" })).error, "already_claimed");
  } finally {
    await h.close();
  }
});

test("meeting seat moves are accepted at the default meeting-call speed (300px/s) — previously the 180 cap stalled the gathering", async () => {
  // Measured locally: at 150px/s the meeting call gathering finished; at 300px/s it stuck in "이동 중" forever.
  // Because the server rejected seat-move position updates with a 180px/s cap.
  let now = 0;
  const h = await harness({ now: () => now });
  try {
    const a = await h.connect();
    const seat = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", seat), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 1, seat, false), true);
    const step = (DEFAULT_NPC_MOTION.meetingSummon * 0.05) / Math.SQRT2;
    let x = 32;
    let y = 32;
    while (x < 128) {
      now += 50;
      x = Math.min(128, x + step);
      y = Math.min(128, y + step);
      const res = await ack(a, "npc:position-update", { npcId: "n1", x, y, direction: "down" });
      assert.equal(res.ok, true, `${x.toFixed(1)},${y.toFixed(1)} 에서 거절: ${res.error}`);
    }
  } finally {
    await h.close();
  }
});

test("raising the cap still rejects teleports — accumulated credit blocks it", async () => {
  let now = 0;
  const h = await harness({ now: () => now });
  try {
    const a = await h.connect();
    const seat = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", seat), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 1, seat, false), true);
    now += 50; // 136px in 50ms — that is 2700px/s.
    const res = await ack(a, "npc:position-update", {
      npcId: "n1",
      x: 128,
      y: 128,
      direction: "down",
    });
    assert.equal(res.error, "invalid_motion");
  } finally {
    await h.close();
  }
});

// When a tab is hidden, the browser pauses rAF and walk notices stop. The connection is alive, so the "no driver"
// settlement (`settleDriverlessSpatial`) is not called, and calls and meeting gatherings freeze in "이동 중".
// The server confirms as arrived any move whose walking **stopped long ago**.
test("a call whose walk notices stopped is settled next to the caller after the deadline", async () => {
  let t = 1_000_000;
  const h = await harness({ now: () => t });
  try {
    const a = await h.connect();
    assert.equal((await ack(a, "npc:call", { npcId: "n1" })).ok, true);
    t += STALLED_MOTION_MS - 1;
    await h.coord.sweepStalled();
    assert.equal(
      a.latest.npcs.find((n) => n.npcId === "n1")!.phase,
      "called",
      "기한 전엔 기다린다",
    );

    const settled = stateEvent(a, (s) => s.npcs.find((n) => n.npcId === "n1")!.phase === "waiting");
    t += 1;
    await h.coord.sweepStalled();
    const npc = (await settled).npcs.find((n) => n.npcId === "n1")!;
    assert.equal(npc.moving, false);
    assert.equal(npc.ownerSocketId, a.socket.id, "보고·대화는 호출한 사람과 이어진다");
    assert.ok(Math.hypot(npc.x - 300, npc.y - 350) <= 48, "호출한 사람 곁에 선다");
  } finally {
    await h.close();
  }
});

test("no settlement while walk notices continue", async () => {
  let t = 1_000_000;
  const h = await harness({ now: () => t });
  try {
    const a = await h.connect();
    assert.equal((await ack(a, "npc:call", { npcId: "n1" })).ok, true);
    t += STALLED_MOTION_MS - 1000;
    assert.equal(
      (await ack(a, "npc:position-update", { npcId: "n1", x: 64, y: 64, direction: "down" })).ok,
      true,
    );
    t += 2000;
    await h.coord.sweepStalled();
    const npc = a.latest.npcs.find((n) => n.npcId === "n1")!;
    assert.equal(npc.phase, "called");
    assert.deepEqual([npc.x, npc.y], [64, 64]);
  } finally {
    await h.close();
  }
});

test("a meeting gathering whose walk notices stopped is confirmed as seat arrival after the deadline", async () => {
  let t = 1_000_000;
  const arrivals: string[] = [];
  const h = await harness({
    now: () => t,
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
  });
  try {
    await h.connect(); // a driver must exist for the "connection alive, only walking stopped" situation
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    t += STALLED_MOTION_MS;
    await h.coord.sweepStalled();
    assert.deepEqual(arrivals, ["n1"], "회의 세션이 착석 완료로 진행해야 한다");
    const back = await h.connect();
    const npc = back.latest.npcs.find((n) => n.npcId === "n1")!;
    assert.deepEqual([npc.x, npc.y], [meeting.x, meeting.y]);
    assert.equal(npc.moving, false);
    assert.equal(npc.phase, "waiting");
    assert.equal(
      back.latest.seats.some((seat) => seat.seatId === meeting.seatId),
      true,
      "회의석 예약은 유지된다",
    );
  } finally {
    await h.close();
  }
});

/**
 * A one-tile-wide meeting corridor: entry at tile (1,1), spots at tiles (2,1)…(4,1), the NPCs waiting outside.
 * Whoever stands nearer the entry blocks everyone behind them.
 */
const corridor: CoordinationChannel = {
  npcs: [
    { id: "n1", x: 48, y: 112 },
    { id: "n2", x: 80, y: 112 },
    { id: "n3", x: 112, y: 112 },
  ],
  seats: [{ id: "80:48", x: 80, y: 48 }],
  bounds: { width: 512, height: 512 },
  isWalkable: (x, y) =>
    (y === 1 && x >= 1 && x <= 4) || (y === 3 && x >= 1 && x <= 4) || (x === 1 && y === 2),
  meetingSpace: {
    id: "meeting",
    version: 1,
    bounds: { x: 1, y: 1, width: 4, height: 1 },
    entry: { x: 1.5, y: 1.5 },
    seatIds: ["80:48"],
    standingPositions: [
      { x: 112, y: 48, direction: "up" },
      { x: 144, y: 48, direction: "up" },
    ],
    wallObjectIds: [],
    wallTileKeys: [],
  },
};

test("meeting spots are handed out seats first, each group from the far end of the room toward the entry", async () => {
  // The map file lists the spots entry-first; the far end of each group must come first.
  const h = await harness({
    load: async () => ({
      ...corridor,
      seats: [
        { id: "80:48", x: 80, y: 48 },
        { id: "144:48", x: 144, y: 48 },
      ],
      meetingSpace: {
        ...corridor.meetingSpace!,
        seatIds: ["80:48", "144:48"],
        standingPositions: [
          { x: 48, y: 80, direction: "up" },
          { x: 112, y: 48, direction: "up" },
        ],
      },
    }),
  });
  try {
    await h.connect();
    const { targets } = await h.coord.spatial.layout("a");
    assert.deepEqual(
      targets.map((t) => `${t.x}:${t.y}`),
      ["144:48", "80:48", "112:48", "48:80"],
    );
  } finally {
    await h.close();
  }
});

test("a meeting spot that others' reserved spots wall off from the entry is not reserved", async () => {
  const h = await harness({ load: async () => corridor });
  try {
    await h.connect();
    assert.equal(await h.coord.spatial.reserve("a", "n1", { x: 112, y: 48, seatId: null }), true);
    assert.equal(
      await h.coord.spatial.reserve("a", "n2", { x: 144, y: 48, seatId: null }),
      false,
      "reserved a spot behind someone else's",
    );
    // Your own reservation does not wall you off — moving further in is fine.
    assert.equal(await h.coord.spatial.reserve("a", "n1", { x: 144, y: 48, seatId: null }), true);
    assert.equal(await h.coord.spatial.reserve("a", "n2", { x: 80, y: 48, seatId: "80:48" }), true);
  } finally {
    await h.close();
  }
});

test("another socket of the same person does not stand in the way of their own meeting spot", async () => {
  const h = await harness();
  try {
    const identity = { userId: "u1", characterId: "c1" };
    await h.connect("a", identity);
    const second = await h.connect("a", identity);
    // Both avatars stand on the spot.
    const spot = { x: 300, y: 350, seatId: null };
    assert.equal(await h.coord.spatial.reserve("a", second.socket.id!, spot), true);
    await h.coord.spatial.release("a", second.socket.id!);
    const stranger = await h.connect("a", { userId: "u2", characterId: "c2" });
    assert.equal(
      await h.coord.spatial.reserve("a", stranger.socket.id!, spot),
      false,
      "someone else standing there no longer counts",
    );
  } finally {
    await h.close();
  }
});

test("a meeting walk that keeps reporting without getting closer is settled at its spot after the deadline", async () => {
  let t = 1_000_000;
  const arrivals: string[] = [];
  const h = await harness({
    now: () => t,
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    // Jammed behind others: it shuffles back and forth and reports every half second, never getting closer.
    for (let i = 0; i < 2 * (STALLED_MOTION_MS / 1000) + 1; i++) {
      t += 500;
      const x = i % 2 ? 32 : 40;
      assert.equal(
        (await ack(a, "npc:position-update", { npcId: "n1", x, y: 32, direction: "down" })).ok,
        true,
      );
      await h.coord.sweepStalled();
    }
    assert.deepEqual(arrivals, ["n1"]);
    const npc = (await h.connect()).latest.npcs.find((n) => n.npcId === "n1")!;
    assert.deepEqual([npc.x, npc.y, npc.moving], [meeting.x, meeting.y, false]);
  } finally {
    await h.close();
  }
});

test("a meeting walk that is getting closer is not settled early", async () => {
  let t = 1_000_000;
  const arrivals: string[] = [];
  const h = await harness({
    now: () => t,
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    for (let i = 1; i <= 2 * (STALLED_MOTION_MS / 1000); i++) {
      t += 500;
      assert.equal(
        (
          await ack(a, "npc:position-update", {
            npcId: "n1",
            x: 32 + i * 4,
            y: 32 + i * 4,
            direction: "down",
          })
        ).ok,
        true,
      );
      await h.coord.sweepStalled();
    }
    assert.deepEqual(arrivals, []);
  } finally {
    await h.close();
  }
});

test("a meeting walk the driving browser gives up on is placed at its spot instead of failing the gathering", async () => {
  const arrivals: string[] = [];
  const blocked: string[] = [];
  const h = await harness({
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
    onSpatialBlocked: (_channelId, actorId, reason) => blocked.push(`${actorId}:${reason}`),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    const settled = stateEvent(a, (s) => s.npcs.find((n) => n.npcId === "n1")!.x === meeting.x);
    await ack(a, "npc:spatial-failed", { npcId: "n1", generation: 3 });
    const npc = (await settled).npcs.find((n) => n.npcId === "n1")!;
    assert.deepEqual([npc.x, npc.y, npc.moving], [meeting.x, meeting.y, false]);
    assert.deepEqual(arrivals, ["n1"]);
    assert.deepEqual(blocked, []);
  } finally {
    await h.close();
  }
});

test("the meeting coordinator can read where a socket's avatar stands", async () => {
  const h = await harness();
  try {
    const a = await h.connect();
    assert.deepEqual(await h.coord.spatial.position("a", a.socket.id!), { x: 300, y: 350 });
    assert.equal(await h.coord.spatial.position("a", "nobody"), null);
  } finally {
    await h.close();
  }
});

test("route notes alone do not keep a meeting walk that makes no progress from being settled", async () => {
  let t = 1_000_000;
  const arrivals: string[] = [];
  const h = await harness({
    now: () => t,
    onSpatialArrival: (_channelId, actorId) => arrivals.push(actorId),
  });
  try {
    const a = await h.connect();
    const meeting = { x: 128, y: 128, seatId: "128:128" };
    assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
    assert.equal(await h.coord.spatial.move("a", "n1", 3, meeting, false), true);
    const continuation = {
      ambientSchedule: { phase: "roam", elapsed: 1200, duration: 25000, pause: 800 },
      path: [{ x: 3, y: 3 }],
    };
    for (let i = 0; i < 2 * (STALLED_MOTION_MS / 1000) + 1; i++) {
      t += 500;
      assert.equal(
        (await ack(a, "npc:continuation-update", { npcId: "n1", continuation })).ok,
        true,
      );
      await h.coord.sweepStalled();
    }
    assert.deepEqual(arrivals, ["n1"]);
  } finally {
    await h.close();
  }
});

/** A meeting walk from n1's home (32,32) straight down, `px` pixels one second after it starts. */
async function reportAfterOneSecond(
  h: Awaited<ReturnType<typeof harness>>,
  client: Client,
  advance: () => void,
  px: number,
) {
  const meeting = { x: 32, y: 480, seatId: null };
  assert.equal(await h.coord.spatial.reserve("a", "n1", meeting), true);
  assert.equal(await h.coord.spatial.move("a", "n1", 1, meeting, false), true);
  advance();
  return ack(client, "npc:position-update", { npcId: "n1", x: 32, y: 32 + px, direction: "down" });
}
const slow = { walk: 55, stroll: 55, summon: 55, meetingSummon: 55 };

test("a channel whose NPCs all walk at 55px/s refuses a 150px/s report", async () => {
  let t = 1_000_000;
  const h = await harness({ now: () => t, loadMotionConfig: async () => slow });
  try {
    const a = await h.connect();
    const res = await reportAfterOneSecond(h, a, () => (t += 1000), 150);
    assert.equal(res.error, "invalid_motion");
  } finally {
    await h.close();
  }
});

test("a channel whose meeting call runs at 300px/s still accepts a 150px/s report", async () => {
  let t = 1_000_000;
  const h = await harness({
    now: () => t,
    loadMotionConfig: async () => ({ ...slow, meetingSummon: 300 }),
  });
  try {
    const a = await h.connect();
    const res = await reportAfterOneSecond(h, a, () => (t += 1000), 150);
    assert.equal(res.ok, true, res.error);
  } finally {
    await h.close();
  }
});

test("raising a channel's speeds applies without restarting the socket server", async () => {
  let t = 1_000_000;
  let config: unknown = slow;
  const h = await harness({ now: () => t, loadMotionConfig: async () => config });
  try {
    const a = await h.connect();
    assert.equal(
      (await reportAfterOneSecond(h, a, () => (t += 1000), 150)).error,
      "invalid_motion",
    );
    config = { ...slow, meetingSummon: 300 };
    t += 60_000;
    // The first report after the settings change prompts a fresh read; the new cap applies from the next report.
    await ack(a, "npc:position-update", { npcId: "n1", x: 32, y: 40, direction: "down" });
    await new Promise((resolve) => setImmediate(resolve));
    t += 1000;
    const res = await ack(a, "npc:position-update", {
      npcId: "n1",
      x: 32,
      y: 190,
      direction: "down",
    });
    assert.equal(res.ok, true, res.error);
  } finally {
    await h.close();
  }
});

test("a channel whose settings cannot be read keeps the widest cap rather than freezing walks", async () => {
  let t = 1_000_000;
  const h = await harness({
    now: () => t,
    loadMotionConfig: async () => {
      throw new Error("db down");
    },
  });
  try {
    const a = await h.connect();
    const res = await reportAfterOneSecond(h, a, () => (t += 1000), 400);
    assert.equal(res.ok, true, res.error);
  } finally {
    await h.close();
  }
});
