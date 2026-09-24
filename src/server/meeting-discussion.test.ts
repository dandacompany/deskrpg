import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../lib/adapters/types";
import { createMeetingSpatialCoordinator } from "./meeting-spatial-coordinator";
import {
  defaultCreateMeetingBroker,
  meetingSessionScope,
  meetingSummarySessionScope,
  registerMeetingDiscussionHandlers,
  resolveNpcAdapter,
  settleMeeting,
  type MeetingBrokerLike,
} from "./meeting-discussion";

type RecordedCall = {
  type: "emit";
  target: string;
  event: string;
  payload: unknown;
};

for (const stage of ["entry", "summary", "persist", "run-error"] as const) {
  test(`이전 브로커의 ${stage} 완료는 맵 교체 후 새 회의를 종료하지 않는다`, async () => {
    const calls: RecordedCall[] = [];
    const socket = createFakeSocket("socket-1", calls);
    const activeBrokers = new Map<string, MeetingBrokerLike>();
    const discussionInitiators = new Map<string, string>();
    const registry = new AdapterRegistry();
    registry.register(recordingAdapter(["ok"]));
    type Factory = NonNullable<
      Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"]["createMeetingBroker"]
    >;
    const callbacks: Parameters<Factory>[1][] = [];
    let resume!: () => void;
    const gate = new Promise<void>((r) => {
      resume = r;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    let rejectRun!: (error: Error) => void;
    let persisted = 0;
    let cancelled = 0;
    const deps: Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"] = {
      activeBrokers,
      discussionInitiators,
      meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
      players: new Map(),
      user: { userId: "u1" },
      adapterRegistry: registry,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [npcConfig({ adapterType: "cli" })],
      createMeetingBroker: (_config, cb) => {
        callbacks.push(cb);
        const old = callbacks.length === 1;
        return {
          config: { participants: [{ npcId: "npc-1", displayName: "NPC" }] },
          turns: [],
          isRunning: () => true,
          stop: () => {},
          run: () =>
            old && stage === "run-error"
              ? new Promise<void>((_r, reject) => {
                  rejectRun = reject;
                })
              : Promise.resolve(),
        } as unknown as MeetingBrokerLike;
      },
      generateMeetingSummary: async () => {
        if (stage === "summary") {
          entered();
          await gate;
        }
        return { keyTopics: [], conclusions: null };
      },
      persistMeetingMinutes: async () => {
        persisted++;
        if (stage === "persist") {
          entered();
          await gate;
        }
        return null;
      },
    };
    registerMeetingDiscussionHandlers({ io: createFakeIo(calls), socket, deps });
    await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "old" });
    let completion: void | Promise<void>;
    if (stage === "summary" || stage === "persist") {
      await socket.trigger("meeting:stop", { channelId: "a" });
      completion = callbacks[0].onMeetingEnd!("old transcript", 1);
      await waiting;
    }
    activeBrokers.delete("a");
    discussionInitiators.delete("a");
    await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "fresh" });
    const fresh = activeBrokers.get("a");
    deps.spatial = {
      cancel: async () => {
        cancelled++;
      },
    } as unknown as ReturnType<typeof createMeetingSpatialCoordinator>;
    if (stage === "entry") await callbacks[0].onMeetingEnd!("old transcript", 1);
    else if (stage === "run-error") {
      rejectRun(new Error("old run failed"));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    } else {
      resume();
      await completion!;
    }
    assert.equal(activeBrokers.get("a"), fresh);
    assert.equal(discussionInitiators.get("a"), "u1");
    assert.equal(cancelled, 0);
    assert.equal(persisted, stage === "persist" ? 1 : 0);
    assert.equal(
      calls.filter((call) => ["meeting:end", "meeting:error"].includes(call.event)).length,
      0,
    );
    if (stage === "entry") {
      await socket.trigger("meeting:stop", { channelId: "a" });
      assert.equal(
        activeBrokers.get("a"),
        fresh,
        "정상 stop은 완료 콜백까지 현재 브로커를 유지한다",
      );
      await callbacks[1].onMeetingEnd!("fresh transcript", 2);
      assert.equal(activeBrokers.has("a"), false);
      assert.equal(calls.filter((call) => call.event === "meeting:end").length, 1);
      assert.equal(cancelled, 2);
    }
  });
}

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
      return {
        emit(event: string, payload: unknown) {
          calls.push({ type: "emit", target: room, event, payload });
        },
      };
    },
  };
}

test("does not create a broker before the actual gathering and starts exactly once after everyone arrives", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);
  const spatial = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => ({ x: 16, y: 16, seatId: null }),
    reserve: async () => true,
    move: async () => true,
    release: async () => {},
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  let created = 0,
    ran = 0;
  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers: new Map(),
      discussionInitiators: new Map(),
      meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
      players: new Map(),
      user: { userId: "u1" },
      adapterRegistry: new AdapterRegistry(),
      spatial,
      canStartMeeting: () => true,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [
        { id: "n1", name: "NPC", agentId: null, sessionKeyPrefix: "a" },
      ],
      createMeetingBroker: () => {
        created++;
        return {
          config: { participants: [{ npcId: "n1", displayName: "NPC" }] },
          turns: [],
          run: async () => {
            ran++;
          },
          isRunning: () => true,
          stop: () => {},
        } as unknown as MeetingBrokerLike;
      },
      generateMeetingSummary: async () => ({ keyTopics: [], conclusions: null }),
      persistMeetingMinutes: async () => null,
    },
  });
  const pending = socket.trigger("meeting:start-discussion", {
    channelId: "a",
    topic: "topic",
    selectedNpcIds: ["n1"],
  });
  // Drive all microtasks of the async gathering schedule without file I/O or a real server.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(created, 0);
  assert.equal(spatial.snapshot("a")?.phase, "assembling");
  await socket.trigger("meeting:start-discussion", {
    channelId: "a",
    topic: "duplicate",
    selectedNpcIds: ["n1"],
  });
  assert.equal(created, 0);
  spatial.arrived("a", "n1", spatial.snapshot("a")!.generation);
  await pending;
  assert.equal(created, 1);
  assert.equal(ran, 1);
});

test("registerMeetingDiscussionHandlers starts a broker and emits mode change", async () => {
  const calls: RecordedCall[] = [];
  const activeBrokers = new Map<string, MeetingBrokerLike>();
  const discussionInitiators = new Map<string, string>();
  const meetingRooms = new Map([
    [
      "channel-1",
      {
        participants: new Set(["socket-1"]),
        messages: [],
      },
    ],
  ]);
  const players = new Map([
    [
      "socket-1",
      {
        characterName: "Dante",
      },
    ],
  ]);

  let runCalled = false;
  let nextTurnCalls = 0;
  let directedCalls = 0;
  let allowedControl = true;
  let callbacks: Parameters<
    NonNullable<
      Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"]["createMeetingBroker"]
    >
  >[1];
  const socket = createFakeSocket("socket-1", calls);

  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers,
      discussionInitiators,
      meetingRooms,
      players,
      user: { userId: "user-1", nickname: "Dante" },
      adapterRegistry: new AdapterRegistry(),
      getNpcConfigsForChannel: async () => [
        {
          id: "npc-1",
          name: "Analyst",
          agentId: "agent-1",
          sessionKeyPrefix: "sess-1",
          adapterType: "openclaw",
          hermesProfileId: null,
          role: "Participant",
          passPolicy: null,
        },
      ],
      canControlMeeting: async () => allowedControl,
      createMeetingBroker: (_config, registeredCallbacks) => {
        callbacks = registeredCallbacks;
        return {
          config: {
            participants: [
              {
                npcId: "npc-1",
                displayName: "Analyst",
                role: "Participant",
                passPolicy: null,
                openclawAgentId: "agent-1",
              },
            ],
            sessionKeyPrefix: "sess-1",
            meetingId: "meet-1",
          },
          turns: [],
          isRunning: () => true,
          run: async () => {
            runCalled = true;
          },
          stop: () => {},
          setMode: () => {},
          nextTurn: () => {
            nextTurnCalls++;
          },
          directSpeak: () => {
            directedCalls++;
          },
          abortCurrentTurn: () => {},
          addUserMessage: () => {},
        };
      },
      generateMeetingSummary: async () => ({ keyTopics: [], conclusions: null }),
      persistMeetingMinutes: async () => null,
    },
  });

  await socket.trigger("meeting:start-discussion", {
    channelId: "channel-1",
    topic: "Roadmap sync",
    settings: { initialMode: "auto", maxTotalTurns: 6 },
  });

  assert.equal(runCalled, true);
  assert.ok(activeBrokers.has("channel-1"));
  assert.equal(discussionInitiators.get("channel-1"), "user-1");
  assert.deepEqual(activeBrokers.get("channel-1")?.discussionState?.npcs, [
    { id: "npc-1", name: "Analyst" },
  ]);
  const live = activeBrokers.get("channel-1")!.discussionState!;
  callbacks!.onWaitingInput?.(null);
  assert.equal(live.isWaitingInput, true);
  callbacks!.onTurnStart?.(activeBrokers.get("channel-1")!.config.participants[0]);
  assert.equal(live.isWaitingInput, false);
  assert.deepEqual(live.currentSpeaker, { npcId: "npc-1", npcName: "Analyst" });
  callbacks!.onTurnChunk?.("npc-1", "Hello ");
  callbacks!.onTurnChunk?.("npc-1", "world");
  assert.deepEqual(live.rawStreams, { "npc-1": "Hello world" });
  callbacks!.onTurnEnd?.("npc-1", "Hello world");
  assert.equal(live.currentSpeaker, null);
  assert.deepEqual(live.rawStreams, {});
  assert.equal(
    (meetingRooms.get("channel-1")!.messages as Array<{ content: string }>)[0].content,
    "Hello world",
  );
  callbacks!.onWaitingInput?.(null);
  assert.equal(live.isWaitingInput, true);

  await socket.trigger("meeting:next-turn", { channelId: "channel-1" });
  assert.equal(nextTurnCalls, 0, "auto cannot consume a manual next turn");
  callbacks!.onModeChanged?.("manual", "user");
  assert.equal(live.isWaitingInput, false);
  const modeEvent = calls.filter((call) => call.event === "meeting:mode-changed").at(-1)!
    .payload as {
    execution: { isWaitingInput: boolean; currentSpeaker: unknown };
  };
  assert.equal(modeEvent.execution.isWaitingInput, false);
  assert.equal(modeEvent.execution.currentSpeaker, null);
  await socket.trigger("meeting:next-turn", { channelId: "channel-1" });
  assert.equal(nextTurnCalls, 0, "polling/busy manual state cannot queue a release");
  callbacks!.onWaitingInput?.(null);
  allowedControl = false;
  await socket.trigger("meeting:next-turn", { channelId: "channel-1" });
  assert.equal(nextTurnCalls, 0);
  assert.equal(live.isWaitingInput, true, "denied requests do not consume readiness");
  allowedControl = true;
  await Promise.all([
    socket.trigger("meeting:next-turn", { channelId: "channel-1" }),
    socket.trigger("meeting:next-turn", { channelId: "channel-1" }),
  ]);
  assert.equal(nextTurnCalls, 1, "readiness is consumed before duplicate requests arrive");
  assert.equal(live.isWaitingInput, false);
  await socket.trigger("meeting:direct-speak", { channelId: "channel-1", npcId: "npc-1" });
  assert.equal(directedCalls, 1, "directed interruption remains allowed while busy");

  const started = calls.find((call) => call.event === "meeting:mode-changed")?.payload as {
    discussion?: { topic: string; npcs: unknown[] };
  };
  assert.equal(started.discussion?.topic, "Roadmap sync");
  assert.deepEqual(started.discussion?.npcs, [{ id: "npc-1", name: "Analyst" }]);
  assert.ok(
    calls.some(
      (call) =>
        call.target === "meeting-channel-1" &&
        call.event === "meeting:mode-changed" &&
        (call.payload as { mode?: string }).mode === "auto",
    ),
  );
});

// ---------------------------------------------------------------------------
// Resolution/wiring layer — defaultCreateMeetingBroker + resolveNpcAdapter
// This layer (dispatch classification, exclusion reasons, adapter assembly, engine callback remapping) was not
// exercised by any test before this commit (M5).
// ---------------------------------------------------------------------------

type ExcludedNotice = { npcId: string; displayName: string; reason: string };

function npcConfig(over: Record<string, unknown> = {}) {
  return {
    id: "npc-1",
    name: "Analyst",
    agentId: null as string | null,
    sessionKeyPrefix: "sess-1",
    adapterType: "openclaw",
    hermesProfileId: null as string | null,
    role: "Participant",
    passPolicy: null as string | null,
    ...over,
  };
}

function recordingAdapter(replies: string[]) {
  const queue = [...replies];
  const prompts: string[] = [];
  return {
    type: "cli",
    prompts,
    async execute(options: { sessionKey: string; prompt: string }) {
      prompts.push(options.prompt);
      const text = queue.length > 1 ? queue.shift()! : queue[0];
      return { response: text, session: { sessionRef: options.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  };
}

function brokerConfig(npcs: ReturnType<typeof npcConfig>[], over: Record<string, unknown> = {}) {
  return {
    topic: "Roadmap sync",
    npcs,
    userId: "user-1",
    channelId: "channel-1",
    adapterRegistry: new AdapterRegistry(),
    sessionKeyPrefix: "sess-1",
    meetingId: "meet-1",
    settings: {},
    quota: { maxTotalTurns: 4 },
    ...over,
  } as unknown as Parameters<typeof defaultCreateMeetingBroker>[0];
}

test("resolution layer: notifies each exclusion with its own reason", async () => {
  const registry = new AdapterRegistry();
  const excluded: ExcludedNotice[] = [];

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({ id: "n-unbound", name: "Unbound", adapterType: "unbound" }),
        npcConfig({
          id: "n-hermes",
          name: "Hermes",
          adapterType: "hermes",
          hermesProfileId: "p-1",
        }),
        // After OpenClaw removal: an NPC whose adapterType is still openclaw is excluded as unbound regardless of
        // agentId — because the backend it would use no longer exists.
        npcConfig({
          id: "n-oc",
          name: "LegacyOpenClaw",
          adapterType: "openclaw",
          agentId: "agent-9",
        }),
        npcConfig({ id: "n-registry", name: "Registry", adapterType: "cli" }),
      ],
      { adapterRegistry: registry },
    ),
    { onParticipantsExcluded: (list: ExcludedNotice[]) => excluded.push(...list) },
    { createHermesAdapter: async () => null }, // simulates a profile resolution failure
  );

  assert.deepEqual(
    excluded.map((e) => [e.npcId, e.reason]),
    [
      ["n-unbound", "unbound"],
      ["n-hermes", "hermes_profile_unavailable"],
      ["n-oc", "unbound"],
      ["n-registry", "adapter_unavailable"],
    ],
  );
  assert.deepEqual(broker.config.participants, [], "해석에 실패한 NPC는 참가자로 남지 않는다");
});

test("resolution layer: hermes / registry dispatches each go to the right backend, and openclaw is dropped", async () => {
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["PASS"]) as never);

  const hermesCalls: Array<[string, string, string]> = [];
  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({
          id: "n-hermes",
          name: "Hermes",
          adapterType: "hermes",
          hermesProfileId: "p-1",
        }),
        npcConfig({
          id: "n-oc",
          name: "LegacyOpenClaw",
          adapterType: "openclaw",
          agentId: "agent-9",
        }),
        npcConfig({ id: "n-cli", name: "Cli", adapterType: "cli" }),
      ],
      { adapterRegistry: registry },
    ),
    {},
    {
      createHermesAdapter: async (npcId: string, userId: string, contextKey: string) => {
        hermesCalls.push([npcId, userId, contextKey]);
        return recordingAdapter(["PASS"]) as never;
      },
    },
  );

  // Only the hermes branch goes through the hermes adapter factory. contextKey is sessionKey with the prefix stripped.
  assert.deepEqual(hermesCalls, [["n-hermes", "user-1", "meeting-meet-1"]]);
  // openclaw has no backend to use, so it doesn't remain a participant. Same even if it has an agentId.
  assert.deepEqual(
    broker.config.participants.map((p) => p.npcId),
    ["n-hermes", "n-cli"],
  );
});

test("resolution layer: meeting session key format stays the same after a rename", async () => {
  const adapterRegistry = new AdapterRegistry();
  const resolved = await resolveNpcAdapter(
    npcConfig({
      id: "npc123",
      name: "단비",
      sessionKeyPrefix: null,
      adapterType: "hermes",
      hermesProfileId: "p-1",
    }) as never,
    {
      sessionScope: "meeting-abc",
      userId: "u1",
      adapterRegistry,
      createHermesAdapter: async () => recordingAdapter(["PASS"]) as never,
    },
  );

  assert.ok(!("excluded" in resolved));
  assert.equal((resolved as { sessionKey: string }).sessionKey, "npc123-meeting-abc");
});

test("resolution layer: npc.passPolicy survives to the engine and is carried in the poll prompt", async () => {
  // Reverting item 1 (H1) — dropping passPolicy from EngineParticipant or hardcoding null into formatPollMessage
  // again — breaks this assertion.
  const registry = new AdapterRegistry();
  const adapter = recordingAdapter(["PASS"]);
  registry.register(adapter as never);

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({
          id: "n-cli",
          name: "Cli",
          adapterType: "cli",
          passPolicy: "근거 없으면 PASS 하세요",
        }),
      ],
      { adapterRegistry: registry },
    ),
    {},
  );

  assert.deepEqual(
    broker.config.participants.map((p) => p.passPolicy),
    ["근거 없으면 PASS 하세요"],
  );

  await broker.run();
  assert.ok(
    adapter.prompts.some((p) => p.includes("[발언 지침] 근거 없으면 PASS 하세요")),
    `폴링 프롬프트에 [발언 지침]이 있어야 한다: ${JSON.stringify(adapter.prompts[0])}`,
  );
});

test("resolution layer: an invalid settings.initialMode is not cast and falls back to auto", async () => {
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["PASS"]) as never);

  const modeChanges: Array<[string, string]> = [];
  const broker = await defaultCreateMeetingBroker(
    brokerConfig([npcConfig({ id: "n-cli", name: "Cli", adapterType: "cli" })], {
      adapterRegistry: registry,
      settings: { initialMode: "bogus" },
    }),
    { onModeChanged: (mode: string, by: string) => modeChanges.push([mode, by]) },
  );

  // If it fell back to auto, it ends naturally with everyone PASSing without waiting (directed/manual would stop here).
  await broker.run();
  assert.deepEqual(modeChanges, [], "생성자에 넘긴 초기 모드는 mode-changed를 만들지 않는다");
  assert.equal(broker.isRunning(), false);
});

test("resolution layer: a participant's role is passed through to the speaking prompt", async () => {
  const registry = new AdapterRegistry();
  const adapter = recordingAdapter(["SPEAK: 예", "말합니다"]);
  registry.register(adapter as never);

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [npcConfig({ id: "n-cli", name: "Cli", adapterType: "cli", role: "Facilitator" })],
      { adapterRegistry: registry, quota: { maxTotalTurns: 1 } },
    ),
    {},
  );
  await broker.run();

  const speakPrompt = adapter.prompts.find((p) => p.includes("참석자"));
  assert.ok(speakPrompt, "발언 프롬프트가 있어야 한다");
  assert.match(speakPrompt!, /Cli\(Facilitator\)/);
});

// Hermes sessions are keyed as `<prefix>-<scope>`. If this string changes, that NPC's conversation
// context is silently cut — it shows up not as an error but as "can't remember yesterday's talk", so
// the literal is pinned character for character. `-meeting-` actually went missing from the summary scope once.
test("meeting session scope is meeting-<id>", () => {
  assert.equal(meetingSessionScope("meet-1"), "meeting-meet-1");
});

test("summarizer session scope appends -summary to the meeting scope", () => {
  assert.equal(meetingSummarySessionScope("meet-1"), "meeting-meet-1-summary");
});

test("summarizer scope is never equal to the meeting scope", () => {
  // If equal, the summary prompt would mix into that NPC's meeting context and contaminate the next meeting's speech.
  for (const id of ["meet-1", "a", "meet-1-summary"]) {
    assert.notEqual(meetingSummarySessionScope(id), meetingSessionScope(id));
  }
});

test("when a meeting ends, the structured outcome and summary status are saved and broadcast", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["ok"]));
  type Deps = Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"];
  type Factory = NonNullable<Deps["createMeetingBroker"]>;
  let callbacks!: Parameters<Factory>[1];
  let summaryParticipants: unknown;
  let persisted: Parameters<Deps["persistMeetingMinutes"]>[0] | undefined;
  const outcome = {
    decisions: ["A안 채택"],
    followUps: [
      {
        title: "조사",
        summary: null,
        acceptance: null,
        assigneeNpcId: "npc-1",
        assigneeName: "NPC",
        after: [],
      },
    ],
    project: { recommended: true, name: "가격 개편", reason: null },
  };
  const announced: unknown[] = [];
  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers: new Map(),
      discussionInitiators: new Map(),
      meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
      players: new Map([["socket-1", { characterName: "Dante" }]]),
      user: { userId: "u1" },
      adapterRegistry: registry,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [npcConfig({ adapterType: "cli" })],
      createMeetingBroker: (_config, cb) => {
        callbacks = cb;
        return {
          config: { participants: [{ npcId: "npc-1", displayName: "NPC" }] },
          turns: [],
          isRunning: () => true,
          stop: () => {},
          run: () => Promise.resolve(),
        } as unknown as MeetingBrokerLike;
      },
      generateMeetingSummary: async (_adapter, _key, _topic, _transcript, participants) => {
        summaryParticipants = participants;
        return { keyTopics: ["가격"], conclusions: "A안", outcome, status: "ok" };
      },
      persistMeetingMinutes: async (input) => {
        persisted = input;
        return "minutes-1";
      },
      announceOutcome: async (input) => {
        announced.push(input);
      },
    },
  });

  await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "가격" });
  await callbacks.onMeetingEnd!("전문", 10);

  // Request an office room notice so people outside the meeting room know too — pass the saved minutes id along
  // with the same outcome.
  assert.deepEqual(announced, [
    { channelId: "a", minutesId: "minutes-1", topic: "가격", outcome, summaryStatus: "ok" },
  ]);

  // Assignee candidates are only attending **employees** — human attendees are not passed.
  assert.equal(Array.isArray(summaryParticipants), true);
  assert.deepEqual(
    (summaryParticipants as Array<{ npcId: string }>).map((p) => p.npcId),
    [npcConfig({}).id],
  );
  assert.deepEqual(persisted?.outcome, outcome);
  assert.equal(persisted?.summaryStatus, "ok");
  const end = calls.find((call) => call.event === "meeting:end")?.payload as {
    outcome: unknown;
    summaryStatus: string;
    minutesId: string;
  };
  assert.deepEqual(end.outcome, outcome);
  assert.equal(end.summaryStatus, "ok");
  assert.equal(end.minutesId, "minutes-1");
});

test("whatever the broker onError passes, meeting:error carries a string code and reason", async () => {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["ok"]));
  type Factory = NonNullable<
    Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"]["createMeetingBroker"]
  >;
  let cb!: Parameters<Factory>[1];
  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers: new Map(),
      discussionInitiators: new Map(),
      meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
      players: new Map(),
      user: { userId: "u1" },
      adapterRegistry: registry,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [npcConfig({ adapterType: "cli" })],
      createMeetingBroker: (_config, callbacks) => {
        cb = callbacks;
        return {
          config: { participants: [{ npcId: "npc-1", displayName: "NPC" }] },
          turns: [],
          isRunning: () => true,
          stop: () => {},
          run: () => new Promise<void>(() => {}),
        } as unknown as MeetingBrokerLike;
      },
      generateMeetingSummary: async () => ({ keyTopics: [], conclusions: null }),
      persistMeetingMinutes: async () => null,
    },
  });
  await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "t" });

  // Same shape as observed on staging — the adapter threw a HermesError
  const usage = Object.assign(new Error("HTTP 429: The usage limit has been reached"), {
    name: "HermesError",
    code: "run_failed",
    status: 200,
  });
  for (const thrown of [usage, { code: "x", message: "obj" }, "plain", undefined]) {
    cb.onError!(thrown);
  }
  const payloads = calls
    .filter((call) => call.event === "meeting:error")
    .map((call) => call.payload as { error: unknown; detail: unknown });
  assert.equal(payloads.length, 4);
  for (const p of payloads) {
    assert.equal(typeof p.error, "string", `error 가 문자열이 아니다: ${JSON.stringify(p)}`);
    assert.ok(p.detail === null || typeof p.detail === "string");
  }
  assert.deepEqual(payloads[0], {
    error: "backend_usage_limit",
    detail: "HTTP 429: The usage limit has been reached",
  });
});

// A meeting where every turn fails due to the model backend limit (429). Uses the real engine
// (defaultCreateMeetingBroker) and the real spatial coordinator — a fake broker can't show "does the engine end after
// turn errors".
async function runFailingMeeting(opts: { hang?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);
  const released: string[] = [];
  const spatial = createMeetingSpatialCoordinator({
    layout: async () => ({ spaceId: "meeting", targets: [{ x: 80, y: 80, seatId: "80:80" }] }),
    capture: async () => ({ x: 16, y: 16, seatId: "16:16" }),
    reserve: async () => true,
    move: async () => true,
    release: async (_c, actorId) => {
      released.push(actorId);
    },
    returnTarget: async (_c, _a, p) => p,
    publish: () => {},
  });
  let adapterCalls = 0;
  const registry = new AdapterRegistry();
  registry.register({
    type: "cli",
    async execute() {
      adapterCalls++;
      // Hold the response to observe the host leaving while the meeting is in progress.
      if (opts.hang) return new Promise(() => {});
      throw Object.assign(new Error("HTTP 429: The usage limit has been reached"), {
        name: "HermesError",
        code: "run_failed",
        status: 200,
      });
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as never);
  const activeBrokers = new Map<string, MeetingBrokerLike>();
  const discussionInitiators = new Map<string, string>();
  let ended = 0;
  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers,
      discussionInitiators,
      meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
      players: new Map(),
      user: { userId: "u1" },
      adapterRegistry: registry,
      spatial,
      canStartMeeting: () => true,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [
        npcConfig({ id: "n1", name: "Sophie", adapterType: "cli" }),
      ],
      generateMeetingSummary: async () => {
        ended++;
        return { keyTopics: [], conclusions: null, status: "failed" };
      },
      persistMeetingMinutes: async () => null,
    },
  });
  const pending = socket.trigger("meeting:start-discussion", {
    channelId: "a",
    topic: "t",
    selectedNpcIds: ["n1"],
    settings: { maxTotalTurns: 4 },
  });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  spatial.arrived("a", "n1", spatial.snapshot("a")!.generation);
  await pending;
  const seatedAfterStart = spatial.snapshot("a")?.phase;
  // Give the engine a chance to end on its own (accumulated failures → consecutive_failures).
  const deadline = Date.now() + (opts.hang ? 50 : 3000);
  while (Date.now() < deadline && activeBrokers.has("a")) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return {
    calls,
    released,
    spatial,
    activeBrokers,
    discussionInitiators,
    adapterCalls,
    ended,
    seatedAfterStart,
    socket,
  };
}

test("a meeting where every call fails with a limit error ends on its own and sends employees back to their seats", async () => {
  const r = await runFailingMeeting();
  assert.equal(r.seatedAfterStart, "ready");
  assert.equal(
    r.activeBrokers.has("a"),
    false,
    "브로커가 activeBrokers 에 남아 다음 회의를 막는다",
  );
  assert.deepEqual(r.released, ["n1"], "직원이 회의석에서 풀려나지 않았다");
});

test("a meeting emptied by the host leaving also sends employees back to their seats and can restart in the same channel", async () => {
  const r = await runFailingMeeting({ hang: true });
  assert.equal(r.activeBrokers.has("a"), true, "전제: 회의가 진행 중이어야 한다");
  // Same order as the disconnect handling in socket-handlers.ts — the player leaves, and settle once the room is
  // empty.
  await r.spatial.leavePlayer("a", "u1", "socket-1");
  settleMeeting(r, "a", { stopBroker: true, context: "주재자 이탈" });
  for (let i = 0; i < 50; i++) await new Promise((res) => setImmediate(res));

  assert.equal(r.activeBrokers.has("a"), false);
  assert.deepEqual(
    r.released.filter((a) => a === "n1"),
    ["n1"],
    "직원이 회의석에서 풀려나지 않았다",
  );
  assert.equal(r.spatial.snapshot("a")?.phase, "returning");

  // When the employees return to their seats the spatial session closes, and the next meeting starts.
  // Previously the session stayed at "ready", spatial.start returned null and the meeting silently didn't start.
  r.spatial.arrived("a", "n1", r.spatial.snapshot("a")!.generation);
  assert.equal(r.spatial.snapshot("a")?.phase, "idle");
  const next = await r.spatial.start("a", "u1", ["n1"]);
  assert.notEqual(next, null, "같은 채널에서 회의를 다시 시작할 수 없다");
});

test("the turn-end stream signal carries the same final body as the meeting record — the screen finalizes the bubble with it", async () => {
  const { MEETING_NPC_STREAM_EVENT } = await import("./meeting-socket");
  const calls: RecordedCall[] = [];
  const socket = createFakeSocket("socket-1", calls);
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["ok"]));
  type Factory = NonNullable<
    Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"]["createMeetingBroker"]
  >;
  let cb!: Parameters<Factory>[1];
  const meetingRooms = new Map([
    ["a", { participants: new Set(["socket-1"]), messages: [] as Array<{ content: string }> }],
  ]);
  registerMeetingDiscussionHandlers({
    io: createFakeIo(calls),
    socket,
    deps: {
      activeBrokers: new Map(),
      discussionInitiators: new Map(),
      meetingRooms: meetingRooms as never,
      players: new Map(),
      user: { userId: "u1" },
      adapterRegistry: registry,
      canControlMeeting: () => true,
      getNpcConfigsForChannel: async () => [npcConfig({ adapterType: "cli" })],
      createMeetingBroker: (_config, callbacks) => {
        cb = callbacks;
        return {
          config: { participants: [{ npcId: "npc-1", displayName: "NPC" }] },
          turns: [],
          isRunning: () => true,
          stop: () => {},
          run: () => new Promise<void>(() => {}),
        } as unknown as MeetingBrokerLike;
      },
      generateMeetingSummary: async () => ({ keyTopics: [], conclusions: null }),
      persistMeetingMinutes: async () => null,
    },
  });
  await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "t" });

  cb.onTurnChunk!("npc-1", "첫 생성. ");
  cb.onTurnChunk!("npc-1", "둘째 생성.");
  cb.onTurnEnd!("npc-1", "둘째 생성.");

  const done = calls.find(
    (c) => c.event === MEETING_NPC_STREAM_EVENT && (c.payload as { done: boolean }).done,
  );
  assert.equal((done?.payload as { text?: string }).text, "둘째 생성.");
  assert.equal(meetingRooms.get("a")!.messages.at(-1)?.content, "둘째 생성.");
});
