import assert from "node:assert/strict";
import test from "node:test";
import type { MeetingSpatialState } from "../lib/meeting-discussion-state";
import { createMeetingSpatialCoordinator } from "./meeting-spatial-coordinator";

import {
  MEETING_NPC_STREAM_EVENT,
  deliverMeetingNpcAnswer,
  registerMeetingSocketHandlers,
} from "./meeting-socket";

type RecordedCall = {
  type: "emit" | "join" | "leave" | "to";
  target?: string;
  event?: string;
  payload?: unknown;
};

function createFakeSocket(id: string, calls: RecordedCall[]) {
  const handlers = new Map<string, (payload: unknown) => unknown>();

  return {
    id,
    on(event: string, handler: (payload: unknown) => unknown) {
      handlers.set(event, handler);
    },
    emit(event: string, payload: unknown) {
      calls.push({ type: "emit", target: "self", event, payload });
    },
    join(room: string) {
      calls.push({ type: "join", target: room });
    },
    leave(room: string) {
      calls.push({ type: "leave", target: room });
    },
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          calls.push({ type: "emit", target: room, event, payload });
        },
      };
    },
    async trigger(event: string, payload: unknown) {
      const handler = handlers.get(event);
      assert.ok(handler, `missing handler for ${event}`);
      await handler(payload);
    },
  };
}

function createFakeIo(calls: RecordedCall[]) {
  return {
    to(room: string) {
      calls.push({ type: "to", target: room });
      return {
        emit(event: string, payload: unknown) {
          calls.push({ type: "emit", target: room, event, payload });
        },
      };
    },
  };
}

test("availability exposes only channel and active, without joining or changing meeting state", async () => {
  for (const phase of [null, "idle", "assembling", "ready", "returning", "blocked"] as const) {
    for (const hasNpc of [false, true]) {
      for (const discussionActive of [false, true]) {
        const calls: RecordedCall[] = [];
        const socket = createFakeSocket("s1", calls);
        const meetingRooms = new Map<string, { participants: Set<string>; messages: [] }>();
        const state: MeetingSpatialState | null = phase && {
          channelId: "a",
          spaceId: "private",
          generation: 1,
          phase,
          participants: [
            {
              actorId: "secret-id",
              kind: hasNpc ? "npc" : "player",
              state: "walking",
              seatId: null,
              target: null,
            },
          ],
          failure: null,
        };
        const spatial = new Proxy(
          {
            snapshot: (channelId: string) => {
              assert.equal(channelId, "a");
              return state;
            },
          },
          {
            get(target, prop) {
              assert.equal(
                prop,
                "snapshot",
                "availability must never mutate spatial state or reserve seats",
              );
              return target.snapshot;
            },
          },
        ) as ReturnType<typeof createMeetingSpatialCoordinator>;
        const before = structuredClone(state);
        registerMeetingSocketHandlers({
          io: createFakeIo(calls),
          socket,
          deps: {
            meetingRooms,
            spatial,
            players: new Map([["s1", { mapId: "a" }]]),
            lastChatTime: new Map(),
            chatCooldownMs: 0,
            user: { userId: "u1" },
            getParticipationAccess: async (channelId, userId) => {
              assert.equal(channelId, "a");
              assert.equal(userId, "u1");
              return { access: { allowed: true } };
            },
            getDiscussionState: () =>
              discussionActive
                ? {
                    topic: "secret",
                    npcs: [],
                    mode: "manual",
                    initiatorId: "u1",
                    initiatorSocketId: "other",
                    rawStreams: { npc: "private content" },
                  }
                : null,
          },
        });
        await socket.trigger("meeting:availability", { channelId: "a" });
        assert.deepEqual(calls, [
          {
            type: "emit",
            target: "self",
            event: "meeting:availability",
            payload: {
              channelId: "a",
              active: discussionActive || (hasNpc && (phase === "assembling" || phase === "ready")),
            },
          },
        ]);
        assert.equal(meetingRooms.size, 0);
        assert.deepEqual(state, before);
      }
    }
  }
});

test("availability denies wrong channel, missing player/access, forbidden access, and channel moves during access await", async () => {
  for (const scenario of [
    "wrong-channel",
    "missing-player",
    "missing-access",
    "forbidden",
    "not-found",
    "moved",
    "access-error",
  ] as const) {
    const calls: RecordedCall[] = [];
    const socket = createFakeSocket("s1", calls);
    const players = new Map(
      scenario === "missing-player"
        ? []
        : [["s1", { mapId: scenario === "wrong-channel" ? "b" : "a" }]],
    );
    registerMeetingSocketHandlers({
      io: createFakeIo(calls),
      socket,
      deps: {
        meetingRooms: new Map(),
        players,
        lastChatTime: new Map(),
        chatCooldownMs: 0,
        user: { userId: "u1" },
        getParticipationAccess:
          scenario === "missing-access"
            ? undefined
            : async () => {
                await Promise.resolve();
                if (scenario === "moved") players.set("s1", { mapId: "b" });
                if (scenario === "access-error") throw new Error("access failed");
                return scenario === "not-found"
                  ? null
                  : { access: { allowed: scenario !== "forbidden" } };
              },
        getDiscussionState: () => {
          assert.fail("unauthorized lookup");
        },
      },
    });
    await socket.trigger("meeting:availability", { channelId: "a" });
    assert.deepEqual(
      calls,
      [
        {
          type: "emit",
          target: "self",
          event: "channel:access-denied",
          payload: {
            channelId: "a",
            action: "meeting:availability",
            reason: "forbidden",
            errorCode: "forbidden",
          },
        },
      ],
      scenario,
    );
  }
});

test("leaving the meeting room while awaiting a seat reservation rolls back both the subscription and the reservation", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("s1", calls);
  let inside = true;
  const released: string[] = [];
  const spatial = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => null,
    reserve: async () => {
      inside = false;
      return true;
    },
    move: async () => true,
    release: async (_c, id) => {
      released.push(id);
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  const meetingRooms = new Map<string, { participants: Set<string>; messages: [] }>();
  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms,
      spatial,
      players: new Map([["s1", { userId: "u1", mapId: "a" }]]),
      lastChatTime: new Map(),
      chatCooldownMs: 0,
      user: { userId: "u1" },
      getParticipationAccess: async () => ({ access: { allowed: true } }),
      isInMeetingSpace: async () => inside,
    },
  });
  await socket.trigger("meeting:join", { channelId: "a" });
  assert.equal(meetingRooms.get("a")?.participants.has("s1"), false);
  assert.equal(calls.filter((c) => c.type === "leave" && c.target === "meeting-a").length, 1);
  assert.deepEqual(released, ["s1"]);
  assert.equal(
    calls.some((c) => c.event === "meeting:state"),
    false,
  );
  assert.equal(spatial.snapshot("a")?.participants.length, 0);
});

test("pending meeting admission is cancelled by leave, disconnect, or channel movement at each await", async () => {
  for (const pauseAt of ["access", "space", "reserve", "space-after-reserve"] as const) {
    for (const cancel of ["leave", "disconnect", "move", "roundtrip"] as const) {
      const calls: RecordedCall[] = [];
      const socket = createFakeSocket("s1", calls);
      const players = new Map([["s1", { mapId: "a" }]]);
      const meetingRooms = new Map<string, { participants: Set<string>; messages: [] }>();
      let resume!: () => void;
      let paused!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        paused = resolve;
      });
      const pause = async (stage: typeof pauseAt) => {
        if (stage === pauseAt) {
          paused();
          await gate;
        }
      };
      const reserved = new Set<string>();
      let spaceChecks = 0;
      const spatial = createMeetingSpatialCoordinator({
        layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "seat" }] }),
        capture: async () => null,
        reserve: async (_channelId, id) => {
          await pause("reserve");
          reserved.add(id);
          return true;
        },
        move: async () => true,
        release: async (_channelId, id) => {
          reserved.delete(id);
        },
        returnTarget: async (_c, _a, p) => p,
        publish: () => {},
      });
      registerMeetingSocketHandlers({
        io: createFakeIo(calls),
        socket,
        deps: {
          meetingRooms,
          players,
          spatial,
          lastChatTime: new Map(),
          chatCooldownMs: 0,
          user: { userId: "u1" },
          getParticipationAccess: async () => {
            await pause("access");
            return { access: { allowed: true } };
          },
          isInMeetingSpace: async () => {
            await pause(++spaceChecks === 1 ? "space" : "space-after-reserve");
            return true;
          },
        },
      });
      const joining = socket.trigger("meeting:join", { channelId: "a" });
      await reached;
      if (cancel === "roundtrip") {
        players.set("s1", { mapId: "b" });
        players.set("s1", { mapId: "a" });
      } else if (cancel === "move") players.set("s1", { mapId: "b" });
      else
        await socket.trigger(cancel === "leave" ? "meeting:leave" : "disconnect", {
          channelId: "a",
        });
      resume();
      await joining;
      assert.equal(
        meetingRooms.get("a")?.participants.has("s1") ?? false,
        false,
        `${pauseAt}/${cancel}`,
      );
      assert.equal(reserved.size, 0, `${pauseAt}/${cancel}: reservation leak`);
      assert.equal(spatial.snapshot("a")?.participants.length ?? 0, 0);
      assert.equal(
        calls.some(
          (call) => call.event === "meeting:state" || call.event === "meeting:participant-joined",
        ),
        false,
      );
    }
  }
});

test("leave then rejoin during seat reservation keeps only the newest admission and duplicate joins reuse its seat", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("s1", calls);
  const meetingRooms = new Map<string, { participants: Set<string>; messages: [] }>();
  let resume!: () => void;
  let paused!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const reserved = new Set<string>();
  let reservations = 0;
  const spatial = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "seat" }] }),
    capture: async () => null,
    reserve: async (_channelId, id) => {
      reservations++;
      if (reservations === 1) {
        paused();
        await gate;
      }
      reserved.add(id);
      return true;
    },
    move: async () => true,
    release: async (_channelId, id) => {
      reserved.delete(id);
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms,
      players: new Map([["s1", { mapId: "a" }]]),
      spatial,
      lastChatTime: new Map(),
      chatCooldownMs: 0,
      user: { userId: "u1" },
      getParticipationAccess: async () => ({ access: { allowed: true } }),
      isInMeetingSpace: async () => true,
    },
  });
  const first = socket.trigger("meeting:join", { channelId: "a" });
  await reached;
  const superseded = socket.trigger("meeting:join", { channelId: "a" });
  await socket.trigger("meeting:leave", { channelId: "a" });
  await socket.trigger("meeting:leave", { channelId: "a" });
  const latest = socket.trigger("meeting:join", { channelId: "a" });
  resume();
  await Promise.all([first, superseded, latest]);
  assert.equal(calls.filter((call) => call.event === "meeting:state").length, 1);
  assert.equal(reservations, 2);
  assert.deepEqual([...reserved], ["s1"]);
  assert.deepEqual([...meetingRooms.get("a")!.participants], ["s1"]);
  assert.equal(spatial.snapshot("a")?.participants.length, 1);
  await socket.trigger("meeting:join", { channelId: "a" });
  assert.equal(reservations, 2, "duplicate admission reuses the existing seat");
  await socket.trigger("meeting:leave", { channelId: "a" });
  await socket.trigger("meeting:leave", { channelId: "a" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reserved.size, 0);
  assert.equal(meetingRooms.get("a")?.participants.size, 0);
  assert.equal(spatial.snapshot("a")?.participants.length, 0);
});

test("superseding an existing participant's duplicate join never releases their assembling seat", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("s1", calls);
  const released: string[] = [];
  const spatial = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "seat" }] }),
    capture: async () => ({ x: 0, y: 0, seatId: null }),
    reserve: async () => true,
    move: async () => true,
    release: async (_channelId, id) => {
      released.push(id);
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  const meetingRooms = new Map<string, { participants: Set<string>; messages: [] }>();
  let resume!: () => void;
  let paused!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  let spaceChecks = 0;
  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms,
      spatial,
      players: new Map([["s1", { mapId: "a" }]]),
      lastChatTime: new Map(),
      chatCooldownMs: 0,
      user: { userId: "u1" },
      getParticipationAccess: async () => ({ access: { allowed: true } }),
      isInMeetingSpace: async () => {
        if (++spaceChecks === 4) {
          paused();
          await gate;
        }
        return true;
      },
    },
  });
  await socket.trigger("meeting:join", { channelId: "a" });
  await spatial.start("a", "u1", ["npc1"]);
  assert.equal(spatial.snapshot("a")?.phase, "assembling");
  const firstDuplicate = socket.trigger("meeting:join", { channelId: "a" });
  await reached;
  const secondDuplicate = socket.trigger("meeting:join", { channelId: "a" });
  resume();
  await Promise.all([firstDuplicate, secondDuplicate]);
  assert.deepEqual(released, [], "superseded observer request must not release existing admission");
  assert.equal(spatial.snapshot("a")?.phase, "assembling");
  assert.equal(spatial.snapshot("a")?.participants.filter((p) => p.kind === "player").length, 1);
  assert.equal(meetingRooms.get("a")?.participants.has("s1"), true);
  assert.equal(
    calls.some((call) => call.type === "leave"),
    false,
  );
});

test("registerMeetingSocketHandlers joins the room and emits meeting state", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);

  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms: new Map(),
      players: new Map([
        [
          "socket-1",
          {
            characterName: "Dante",
            appearance: { sprite: "demo" },
            mapId: "channel-1",
          },
        ],
      ]),
      lastChatTime: new Map(),
      chatCooldownMs: 2_000,
      user: { userId: "user-1", nickname: "Dante" },
      getParticipationAccess: async () => ({
        access: { allowed: true },
      }),
      emitChannelAccessDenied: (_socket, input) => {
        calls.push({
          type: "emit",
          target: "self",
          event: "channel:access-denied",
          payload: input,
        });
      },
    },
  });

  await socket.trigger("meeting:join", { channelId: "channel-1" });

  assert.ok(calls.some((call) => call.type === "join" && call.target === "meeting-channel-1"));
  assert.ok(
    calls.some((call) => call.event === "meeting:state"),
    "expected meeting:state emission",
  );
  const state = calls.find((call) => call.event === "meeting:state")?.payload as {
    participants: Array<{ id: string; userId?: string }>;
  };
  assert.equal(
    state.participants.find((participant) => participant.id === "socket-1")?.userId,
    "user-1",
  );
  const joined = calls.find((call) => call.event === "meeting:participant-joined")?.payload as {
    userId?: string;
  };
  assert.equal(joined.userId, "user-1", "broadcast identity comes from authenticated user");
});

test("registerMeetingSocketHandlers rejects meeting chat from sockets outside the room", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-2", calls);

  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms: new Map(),
      players: new Map([
        [
          "socket-2",
          {
            characterName: "Dante",
            appearance: null,
          },
        ],
      ]),
      lastChatTime: new Map(),
      chatCooldownMs: 2_000,
      user: { userId: "user-1", nickname: "Dante" },
      getParticipationAccess: async () => ({
        access: { allowed: true },
      }),
      emitChannelAccessDenied: (_socket, input) => {
        calls.push({
          type: "emit",
          target: "self",
          event: "channel:access-denied",
          payload: input,
        });
      },
    },
  });

  await socket.trigger("meeting:chat", { channelId: "channel-1", message: "hello" });

  assert.ok(
    calls.some((call) => call.event === "channel:access-denied"),
    "expected channel:access-denied emission",
  );
});

test("meeting socket contract uses the stream event name shared by UI and runtime", () => {
  assert.equal(MEETING_NPC_STREAM_EVENT, "meeting:npc-stream");
});

test("deliverMeetingNpcAnswer keeps the answer and done:true even when session ref persistence fails", async () => {
  // M6 regression guard: previously persistHermesSessionRef was awaited before the final emit and wasn't
  // wrapped, so a single transient DB error (1) popped the answer from room.messages, (2) kept done:true
  // from going out, leaving the client bubble open, and (3) also kept meeting:message from going out.
  const order: string[] = [];
  let loggedError: unknown = null;

  await deliverMeetingNpcAnswer({
    emitDone: () => order.push("done"),
    emitMessage: () => order.push("message"),
    persistSessionRef: async () => {
      order.push("persist");
      throw new Error("db down");
    },
    onPersistError: (err) => {
      loggedError = err;
    },
  });

  assert.deepEqual(order, ["done", "message", "persist"], "영속화는 확정 전달 이후에만 시도한다");
  assert.equal((loggedError as Error)?.message, "db down", "영속화 실패는 삼키지 않고 로깅한다");
});

test("deliverMeetingNpcAnswer only delivers when there is no persistence target (openclaw/registry)", async () => {
  const order: string[] = [];
  await deliverMeetingNpcAnswer({
    emitDone: () => order.push("done"),
    emitMessage: () => order.push("message"),
    persistSessionRef: null,
  });
  assert.deepEqual(order, ["done", "message"]);
});

test("authorized late observer and reconnected initiator receive the resolved discussion roster", async () => {
  const discussion = {
    topic: "Selected team",
    npcs: [
      { id: "npc-2", name: "소피" },
      { id: "npc-7", name: "마틴" },
    ],
    mode: "manual" as const,
    initiatorId: "owner",
    initiatorSocketId: "old-socket",
  };
  for (const userId of ["observer", "owner"]) {
    const calls: RecordedCall[] = [];
    const socket = createFakeSocket(`new-${userId}`, calls);
    registerMeetingSocketHandlers({
      io: createFakeIo(calls),
      socket,
      deps: {
        meetingRooms: new Map(),
        players: new Map([[socket.id, { mapId: "channel-1" }]]),
        lastChatTime: new Map(),
        chatCooldownMs: 2000,
        user: { userId },
        getParticipationAccess: async () => ({ access: { allowed: true } }),
        getDiscussionState: () => discussion,
      },
    });
    await socket.trigger("meeting:join", { channelId: "channel-1" });
    const state = calls.find((call) => call.event === "meeting:state")!.payload as {
      discussion: typeof discussion;
      isInitiator: boolean;
    };
    assert.deepEqual(state.discussion, discussion);
    assert.equal(state.isInitiator, userId === "owner");
  }
});
test("denied observer cannot retrieve a discussion roster", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("denied", calls);
  registerMeetingSocketHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      meetingRooms: new Map(),
      players: new Map(),
      lastChatTime: new Map(),
      chatCooldownMs: 2000,
      user: { userId: "outsider" },
      getParticipationAccess: async () => ({ access: { allowed: false } }),
      getDiscussionState: () => {
        assert.fail("must authorize before accessing roster");
      },
    },
  });
  await socket.trigger("meeting:join", { channelId: "channel-1" });
  assert.equal(
    calls.some((call) => call.event === "meeting:state"),
    false,
  );
});
