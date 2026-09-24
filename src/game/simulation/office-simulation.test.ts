import test from "node:test";
import assert from "node:assert/strict";
import { EventBus, pendingChannelData, setPendingChannelData } from "../EventBus";
import { OfficeSimulation, isTypingTarget } from "./office-simulation";
import type { TickLoop } from "./tick-loop";
import { SMALLTALK_LINES } from "../npc-smalltalk";

type Runtime = OfficeSimulation & Record<string, unknown>;

const legacyMap = {
  layers: {
    floor: Array.from({ length: 5 }, () => Array(6).fill(1)),
    walls: Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 6 }, () => (row === 0 ? 2 : 0)),
    ),
  },
  objects: [{ id: "desk", type: "desk", col: 4, row: 3 }],
};

function withFetch<T>(body: unknown, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(body)))) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("boot announces scene-ready → three:bridge-ready in that order and consumes the channel data", async () => {
  const order: string[] = [];
  const sceneReady = () => order.push("scene-ready");
  const bridgeReady = (bridge: unknown) => {
    order.push("three:bridge-ready");
    assert.equal(bridge, sim.officeBridge);
  };
  EventBus.on("scene-ready", sceneReady);
  EventBus.on("three:bridge-ready", bridgeReady);
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch({ npcs: [] }, async () => {
      sim["boot"](pendingChannelData!);
      await settle();
    });
    assert.deepEqual(order, ["scene-ready", "three:bridge-ready"]);
    assert.equal(pendingChannelData, null, "pending channel data is consumed once");
    assert.equal(sim["channelId"], "ch");
  } finally {
    EventBus.off("scene-ready", sceneReady);
    EventBus.off("three:bridge-ready", bridgeReady);
    sim.dispose();
  }
});

test("the bridge exposes only layout, start position, owner and whether it is Tiled — no tile editing entry point", async () => {
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch({ npcs: [] }, async () => {
      sim["boot"](pendingChannelData!);
      await settle();
    });
    assert.deepEqual(sim.officeBridge.editor(), {
      placement: false,
      spawn: false,
      owner: false,
      tiled: false,
      seatLabels: [],
    });
    assert.equal("edit" in sim.officeBridge, false);
    assert.equal("save" in sim.officeBridge, false);
    EventBus.emit("placement-mode-start", { id: "npc" });
    EventBus.emit("owner-status", { isOwner: true });
    const { seatLabels, ...placing } = sim.officeBridge.editor();
    assert.deepEqual(placing, {
      placement: true,
      spawn: false,
      owner: true,
      tiled: false,
    });
    assert.ok(Array.isArray(seatLabels));
    EventBus.emit("placement-mode-end");
    const map = sim.officeBridge.map();
    assert.equal("artwork" in map, false, "the simulation never produces map artwork");
    // Meeting space normalization widens the map — the original grid stays as is at the top left.
    assert.ok(map.cols >= 6 && map.rows >= 5);
    assert.equal(map.tiled, false);
    assert.ok(map.meetingSpace, "normalization attaches the meeting space");
    assert.equal(map.walls[0][0], 2);
    assert.ok(map.blocked.includes("0,0"), "legacy wall tiles are blocked");
    assert.ok(map.blocked.includes("4,3"), "furniture occupies its tile");
    assert.ok(!map.blocked.includes("1,1"));
  } finally {
    sim.dispose();
  }
});

test("the player spawns in an empty spot after receiving NPC positions, and actor snapshots carry no texture", async () => {
  const spawned: string[] = [];
  const onSpawn = () => spawned.push("player-spawned");
  EventBus.on("player-spawned", onSpawn);
  setPendingChannelData({
    channelId: "ch",
    mapData: legacyMap,
    mapConfig: { spawnCol: 1, spawnRow: 1 },
  });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch(
      { npcs: [{ id: "n1", name: "Mina", positionX: 1, positionY: 1, direction: "down" }] },
      async () => {
        sim["boot"](pendingChannelData!);
        assert.equal(sim["playerReady"], false, "spawn waits for the NPC prefetch");
        await settle();
      },
    );
    assert.deepEqual(spawned, ["player-spawned"]);
    const actors = sim.officeBridge.actors();
    const player = actors.find((actor) => actor.kind === "player")!;
    const npc = actors.find((actor) => actor.kind === "npc")!;
    assert.ok(player);
    assert.notDeepEqual([player.x, player.y], [48, 48], "the configured tile is taken by the NPC");
    assert.deepEqual([npc.x, npc.y, npc.name], [48, 48, "Mina"]);
    for (const actor of actors) assert.equal("texture" in actor, false);
  } finally {
    EventBus.off("player-spawned", onSpawn);
    sim.dispose();
  }
});

test("starting without channel data waits for channel-data-ready, then boots", async () => {
  setPendingChannelData(null);
  const sim = new OfficeSimulation() as Runtime;
  const booted: unknown[] = [];
  sim["boot"] = (data: unknown) => booted.push(data);
  try {
    // start()'s waiting branch uses no browser APIs.
    sim.start();
    assert.equal(booted.length, 0);
    setPendingChannelData({ channelId: "late", mapData: legacyMap });
    // boot is replaced with a fake, so the rest of start() (rAF, keyboard) attaches to a fake window.
    sim["loop"] = { start() {}, stop() {} } as unknown as TickLoop;
    const originalWindow = (globalThis as { window?: unknown }).window;
    const listeners: string[] = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener(name: string) {
        listeners.push(`+${name}`);
      },
      removeEventListener(name: string) {
        listeners.push(`-${name}`);
      },
    };
    try {
      EventBus.emit("channel-data-ready");
      assert.equal(booted.length, 1);
      assert.equal((booted[0] as { channelId: string }).channelId, "late");
      sim.dispose();
      assert.deepEqual(listeners, ["+keydown", "+keyup", "+blur", "-keydown", "-keyup", "-blur"]);
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  } finally {
    setPendingChannelData(null);
    sim.dispose();
  }
});

test("does not intercept game keys when an input box has focus", () => {
  assert.equal(isTypingTarget(null), false);
  assert.equal(
    isTypingTarget({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget),
    false,
  );
  assert.equal(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget), true);
  assert.equal(
    isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    true,
  );
});

test("dispose removes only this simulation's EventBus listeners and leaves the page's listeners", async () => {
  let pageCount = 0;
  const page = () => pageCount++;
  EventBus.on("dialog:open", page);
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  await withFetch({ npcs: [] }, async () => {
    sim["boot"](pendingChannelData!);
    await settle();
  });
  EventBus.emit("dialog:open");
  assert.equal(sim["dialogOpen"], true);
  sim.dispose();
  sim["dialogOpen"] = false;
  EventBus.emit("dialog:open");
  assert.equal(sim["dialogOpen"], false, "disposed simulation ignores page events");
  assert.equal(pageCount, 2);
  EventBus.off("dialog:open", page);
});

// Card "npc:call refusals never reach the user".
//
// Ownership is taken optimistically first so walking is not interrupted. The ack used to be ignored entirely,
// so even when the server refused **only the client believed it was the owner**, and the user saw no
// indication at all. On refusal, ownership must be reverted and the reason shown.
test("when a call is refused, optimistic ownership is reverted and the reason is shown", async () => {
  const sim = new OfficeSimulation() as Runtime;
  const toasts: string[] = [];
  const onToast = (data: { messageKey?: string }) => toasts.push(data.messageKey ?? "");
  EventBus.on("toast:show", onToast);
  try {
    let ack: ((result: unknown) => void) | undefined;
    sim["socket"] = {
      connected: true,
      id: "me",
      emit: (_event: string, _payload: unknown, callback?: (result: unknown) => void) => {
        ack = callback;
      },
    } as never;
    sim["motionSnapshot"] = { current: {} } as never;

    assert.equal(sim["ensureLocalNpcOwnership"]({ id: "n1" } as never), true);
    assert.equal(sim["npcOwnership"].owner("n1"), "me", "걸음을 위해 먼저 잡는다");
    assert.ok(ack, "ack 콜백 없이 emit 하고 있다 — 거절이 도달할 길이 없다");

    ack({ ok: false, error: "meeting_reserved" });
    assert.equal(sim["npcOwnership"].owner("n1"), undefined, "거절됐는데 소유권이 남아 있다");
    assert.deepEqual(toasts, ["game.npcCall.meetingReserved"]);
  } finally {
    EventBus.off("toast:show", onToast);
    sim.dispose();
  }
});

test("when a call is accepted, ownership and the screen are left as is", async () => {
  const sim = new OfficeSimulation() as Runtime;
  const toasts: string[] = [];
  const onToast = (data: { messageKey?: string }) => toasts.push(data.messageKey ?? "");
  EventBus.on("toast:show", onToast);
  try {
    let ack: ((result: unknown) => void) | undefined;
    sim["socket"] = {
      connected: true,
      id: "me",
      emit: (_event: string, _payload: unknown, callback?: (result: unknown) => void) => {
        ack = callback;
      },
    } as never;
    sim["motionSnapshot"] = { current: {} } as never;
    sim["ensureLocalNpcOwnership"]({ id: "n1" } as never);
    ack!({ ok: true, revision: 7 });
    assert.equal(sim["npcOwnership"].owner("n1"), "me");
    assert.deepEqual(toasts, []);
  } finally {
    EventBus.off("toast:show", onToast);
    sim.dispose();
  }
});

// ---------------------------------------------------------------------------
// Working employees (design 2026-09-21 npc-working-state, decisions B-1 and C-1)
// ---------------------------------------------------------------------------

test("when a card starts running, that employee is sent to their assigned seat", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const sent: string[] = [];
    sim["npcs"] = [
      {
        id: "n1",
        pixelX: 500,
        pixelY: 500,
        homeCol: 2,
        homeRow: 3,
        moveState: "idle",
        calledForRoom: null,
      },
    ] as never;
    sim["mayDriveNpc"] = () => true;
    sim["sendNpcHome"] = (npc: { id: string }) => sent.push(npc.id);

    sim["seatNpcForWork"]("n1");
    assert.deepEqual(sent, ["n1"], "일을 시작했는데 자리로 가지 않았습니다");
  } finally {
    sim.dispose();
  }
});

test("does not move unless it is the owner — everyone must not walk the same employee", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const sent: string[] = [];
    sim["npcs"] = [
      {
        id: "n1",
        pixelX: 500,
        pixelY: 500,
        homeCol: 2,
        homeRow: 3,
        moveState: "idle",
        calledForRoom: null,
      },
    ] as never;
    sim["mayDriveNpc"] = () => false;
    sim["sendNpcHome"] = (npc: { id: string }) => sent.push(npc.id);

    sim["seatNpcForWork"]("n1");
    assert.deepEqual(sent, [], "임자가 아닌데 걷게 했습니다");
  } finally {
    sim.dispose();
  }
});

test("an employee who came when called is not sent back to their seat — what the user called takes priority", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const sent: string[] = [];
    sim["npcs"] = [
      {
        id: "n1",
        pixelX: 500,
        pixelY: 500,
        homeCol: 2,
        homeRow: 3,
        moveState: "idle",
        calledForRoom: "room-1",
      },
    ] as never;
    sim["mayDriveNpc"] = () => true;
    sim["sendNpcHome"] = (npc: { id: string }) => sent.push(npc.id);

    sim["seatNpcForWork"]("n1");
    assert.deepEqual(sent, [], "부른 직원을 자리로 되돌려 보냈습니다");
  } finally {
    sim.dispose();
  }
});

test("not sent again when already at the assigned seat", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const sent: string[] = [];
    // Whatever TILE_SIZE is, 0,0 is the same cell as home 0,0.
    sim["npcs"] = [
      {
        id: "n1",
        pixelX: 0,
        pixelY: 0,
        homeCol: 0,
        homeRow: 0,
        moveState: "idle",
        calledForRoom: null,
      },
    ] as never;
    sim["mayDriveNpc"] = () => true;
    sim["sendNpcHome"] = (npc: { id: string }) => sent.push(npc.id);

    sim["seatNpcForWork"]("n1");
    assert.deepEqual(sent, [], "제자리에 있는데 다시 걷게 했습니다");
  } finally {
    sim.dispose();
  }
});

test("only employees who newly started work are sent to their seat — employees already working are not sent again", async () => {
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch({ npcs: [] }, async () => {
      sim["boot"](pendingChannelData!);
      await settle();
    });
    const seated: string[] = [];
    sim["seatNpcForWork"] = (npcId: string) => seated.push(npcId);
    sim["workingNpcs"] = new Set(["n1"]);

    EventBus.emit("npc:working-state", { npcIds: ["n1", "n2"], counts: { n1: 1, n2: 2 } });
    assert.deepEqual(seated, ["n2"], "이미 일하던 직원을 다시 자리로 보냈습니다");
    assert.deepEqual(sim["workingCounts"], { n1: 1, n2: 2 });
  } finally {
    sim.dispose();
  }
});

test("calling a working employee is not blocked, and that fact is reported", () => {
  const sim = new OfficeSimulation() as Runtime;
  const toasts: { key: string; params?: Record<string, string> }[] = [];
  const onToast = (d: { messageKey?: string; params?: Record<string, string> }) =>
    toasts.push({ key: d.messageKey ?? "", params: d.params });
  EventBus.on("toast:show", onToast);
  try {
    sim["player"] = { x: 0, y: 0 } as never;
    sim["motionSnapshot"] = { current: {} } as never;
    sim["npcs"] = [
      {
        id: "n1",
        name: "소피",
        pixelX: 0,
        pixelY: 0,
        moveState: "idle",
        calledForRoom: null,
        distanceTo: () => 9999,
        moveTo: () => true,
      },
    ] as never;
    sim["workingCounts"] = { n1: 2 };
    sim["ensureLocalNpcOwnership"] = () => true;
    sim["npcTilePositions"] = new Set() as never;

    sim["handleNpcCallToPlayer"]({ npcId: "n1", npcName: "소피" } as never);

    const busy = toasts.find((t) => t.key === "game.calledWhileWorking");
    assert.ok(busy, `작업 중을 알리지 않았습니다: ${toasts.map((t) => t.key).join(",")}`);
    assert.equal(busy.params?.count, "2", "몇 건인지 말해야 합니다");
  } finally {
    EventBus.off("toast:show", onToast);
    sim.dispose();
  }
});

test("calling an idle employee does not show the working notice", () => {
  const sim = new OfficeSimulation() as Runtime;
  const toasts: string[] = [];
  const onToast = (d: { messageKey?: string }) => toasts.push(d.messageKey ?? "");
  EventBus.on("toast:show", onToast);
  try {
    sim["player"] = { x: 0, y: 0 } as never;
    sim["motionSnapshot"] = { current: {} } as never;
    sim["npcs"] = [
      {
        id: "n1",
        name: "소피",
        pixelX: 0,
        pixelY: 0,
        moveState: "idle",
        calledForRoom: null,
        distanceTo: () => 9999,
        moveTo: () => true,
      },
    ] as never;
    sim["workingCounts"] = {};
    sim["ensureLocalNpcOwnership"] = () => true;
    sim["npcTilePositions"] = new Set() as never;

    sim["handleNpcCallToPlayer"]({ npcId: "n1", npcName: "소피" } as never);
    assert.ok(
      !toasts.includes("game.calledWhileWorking"),
      "일하지 않는 직원에게 작업 중 안내가 떴습니다",
    );
  } finally {
    EventBus.off("toast:show", onToast);
    sim.dispose();
  }
});

test("working employees do not go for a stroll even when the ambient schedule is due", async () => {
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch(
      { npcs: [{ id: "n1", name: "Mina", positionX: 1, positionY: 1, direction: "down" }] },
      async () => {
        sim["boot"](pendingChannelData!);
        await settle();
      },
    );
    const npc = (sim["npcs"] as { id: string; moveState: string; ambientTimer: number }[])[0];
    assert.ok(npc, "사전 조건: NPC 가 하나 있다");
    const seated: string[] = [];
    sim["seatNpcForWork"] = (id: string) => seated.push(id);
    sim["mayDriveNpc"] = () => true;
    // The test has no socket, so it is not the ambient leader — left as is, strolling would be blocked whether working or not
    // and this test would distinguish nothing.
    (sim["npcOwnership"] as { mayRoam: (npcId: string, leader: boolean) => boolean }).mayRoam =
      () => true;

    sim["workingNpcs"] = new Set(["n1"]);
    npc.ambientTimer = 99_999; // The schedule is more than due
    sim["updateNpcs"]();

    assert.equal(npc.moveState, "idle", "일하는 중인데 자리에서 일어났습니다");
    assert.equal(npc.ambientTimer, 0, "앰비언트 타이머가 리셋되지 않았습니다");
    assert.deepEqual(seated, ["n1"], "일하는 직원을 자리로 다시 보내지 않았습니다");
  } finally {
    sim.dispose();
  }
});

test("when work starts during a stroll, they stop and go to their seat", async () => {
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch(
      { npcs: [{ id: "n1", name: "Mina", positionX: 1, positionY: 1, direction: "down" }] },
      async () => {
        sim["boot"](pendingChannelData!);
        await settle();
      },
    );
    const npc = (sim["npcs"] as { id: string; moveState: string; stopStroll: () => void }[])[0];
    let stopped = 0;
    npc.stopStroll = () => {
      stopped += 1;
      npc.moveState = "idle";
    };
    npc.moveState = "strolling";
    const seated: string[] = [];
    sim["seatNpcForWork"] = (id: string) => seated.push(id);
    sim["mayDriveNpc"] = () => true;
    // The test has no socket, so it is not the ambient leader — left as is, strolling would be blocked whether working or not
    // and this test would distinguish nothing.
    (sim["npcOwnership"] as { mayRoam: (npcId: string, leader: boolean) => boolean }).mayRoam =
      () => true;

    sim["workingNpcs"] = new Set(["n1"]);
    sim["updateNpcs"]();

    assert.equal(stopped, 1, "걷던 직원이 일을 시작했는데 멈추지 않았습니다");
    assert.deepEqual(seated, ["n1"], "멈춘 자리에 배지만 단 채 서 있습니다");
  } finally {
    sim.dispose();
  }
});

test("strolls of employees who are not working are left alone", async () => {
  setPendingChannelData({ channelId: "ch", mapData: legacyMap });
  const sim = new OfficeSimulation() as Runtime;
  try {
    await withFetch(
      { npcs: [{ id: "n1", name: "Mina", positionX: 1, positionY: 1, direction: "down" }] },
      async () => {
        sim["boot"](pendingChannelData!);
        await settle();
      },
    );
    const seated: string[] = [];
    sim["seatNpcForWork"] = (id: string) => seated.push(id);
    (sim["npcOwnership"] as { mayRoam: (npcId: string, leader: boolean) => boolean }).mayRoam =
      () => true;
    sim["workingNpcs"] = new Set();
    sim["updateNpcs"]();
    assert.deepEqual(seated, [], "일하지 않는 직원을 자리로 보냈습니다");
  } finally {
    sim.dispose();
  }
});

// ---------------------------------------------------------------------------
// Walking speed — the channel setting reaches calls, meeting calls, normal moves and strolls separately

test("a call comes running at the channel's call speed", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const calls: { speed?: number }[] = [];
    sim["player"] = { x: 0, y: 0 } as never;
    sim["motionSnapshot"] = { current: {} } as never;
    sim["npcs"] = [
      {
        id: "n1",
        name: "소피",
        pixelX: 0,
        pixelY: 0,
        moveState: "idle",
        calledForRoom: null,
        distanceTo: () => 9999,
        moveTo: (_c: number, _r: number, _f: unknown, _v: unknown, o: { speed?: number }) => {
          calls.push(o);
          return true;
        },
      },
    ] as never;
    sim["workingCounts"] = {};
    sim["ensureLocalNpcOwnership"] = () => true;
    sim["npcTilePositions"] = new Set() as never;
    sim.setMotionConfig({ summon: 360 });

    sim["handleNpcCallToPlayer"]({ npcId: "n1", npcName: "소피" } as never);
    assert.equal(calls.at(-1)?.speed, 360, "호출이 채널 호출 속도를 쓰지 않았습니다");
  } finally {
    sim.dispose();
  }
});

test("a meeting call gathers at the channel's meeting call speed, not the stroll speed", () => {
  // Meeting gathering used to reuse the stroll path and gather at 55px/s.
  const sim = new OfficeSimulation() as Runtime;
  try {
    const strolls: (number | undefined)[] = [];
    sim["socket"] = { id: "me", emit() {} } as never;
    sim["npcPathfinder"] = () => () => [{ x: 3, y: 3 }];
    sim.setMotionConfig({ meetingSummon: 330, stroll: 40 });
    const npc = {
      id: "n1",
      pixelX: 32,
      pixelY: 32,
      cancelMovement() {},
      startStroll: (_path: unknown, speed?: number) => strolls.push(speed),
    };
    sim["applySpatialNpc"](
      npc as never,
      {
        npcId: "n1",
        ownerSocketId: "me",
        moving: true,
        spatialTarget: { x: 96, y: 96, generation: 1 },
      } as never,
    );
    assert.deepEqual(strolls, [330]);
  } finally {
    sim.dispose();
  }
});

test("the channel setting applies to every NPC's normal move and stroll speed — including NPCs that arrive later", () => {
  const sim = new OfficeSimulation() as Runtime;
  try {
    const first = { moveSpeed: 0, strollSpeed: 0 };
    sim["npcs"] = [first] as never;
    sim.setMotionConfig({ walk: 200, stroll: 70 });
    assert.deepEqual(first, { moveSpeed: 200, strollSpeed: 70 });
    // Empty or invalid settings mean defaults — walking does not stop.
    sim.setMotionConfig(null);
    assert.deepEqual(first, { moveSpeed: 150, strollSpeed: 55 });
  } finally {
    sim.dispose();
  }
});

test("the faster they walk, the more often positions are sent — never more than 30px at a time", () => {
  // The server checks that the straight line between two consecutive position reports is not blocked. With a fixed 200ms, at 300px/s
  // one step is 60px (2 cells), cutting across corners and getting rejected, and meeting gathering stalled at "moving" forever (measured).
  const sim = new OfficeSimulation() as Runtime;
  try {
    const interval = (speeds: { speed: number; state: string }[]) => {
      sim["npcs"] = speeds.map(({ speed, state }) => ({
        moveState: state,
        currentSpeed: () => speed,
      })) as never;
      return sim["npcPositionSyncInterval"]();
    };
    assert.equal(interval([]), 200, "움직이는 직원이 없으면 예전 간격");
    assert.equal(interval([{ speed: 150, state: "strolling" }]), 200, "옛 걸음은 예전 그대로");
    assert.equal(interval([{ speed: 300, state: "strolling" }]), 100);
    assert.equal(interval([{ speed: 480, state: "moving-to-player" }]), 62.5);
    assert.equal(
      interval([
        { speed: 55, state: "strolling" },
        { speed: 300, state: "strolling" },
      ]),
      100,
      "가장 빠른 직원에 맞춘다",
    );
    assert.equal(
      interval([{ speed: 900, state: "strolling" }]),
      50,
      "초당 20번보다 자주 보내지 않는다",
    );
    assert.equal(interval([{ speed: 300, state: "waiting" }]), 200, "멈춘 직원은 치지 않는다");
  } finally {
    sim.dispose();
  }
});

test("smalltalk follows the viewer locale given at creation and after setDisplayLocale", () => {
  const lineSet = (sim: OfficeSimulation) =>
    (sim as unknown as { smalltalk: { lineSet: unknown } }).smalltalk.lineSet;
  const defaulted = new OfficeSimulation();
  assert.equal(lineSet(defaulted), SMALLTALK_LINES.en);
  const sim = new OfficeSimulation({ locale: "ja" });
  assert.equal(lineSet(sim), SMALLTALK_LINES.ja);
  sim.setDisplayLocale("zh");
  assert.equal(lineSet(sim), SMALLTALK_LINES.zh);
});
