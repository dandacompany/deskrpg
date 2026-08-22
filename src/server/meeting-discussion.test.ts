import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../lib/adapters/types";
import {
  defaultCreateMeetingBroker,
  registerMeetingDiscussionHandlers,
  resolveNpcAdapter,
  type MeetingBrokerLike,
} from "./meeting-discussion";

type RecordedCall = {
  type: "emit";
  target: string;
  event: string;
  payload: unknown;
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
          id: "npc-1", name: "Analyst", agentId: "agent-1", sessionKeyPrefix: "sess-1",
          adapterType: "openclaw", hermesProfileId: null, role: "Participant", passPolicy: null,
        },
      ],
      canControlMeeting: async () => true,
      createMeetingBroker: () => ({
        config: {
          participants: [{
            npcId: "npc-1",
            displayName: "Analyst",
            role: "Participant",
            passPolicy: null,
            openclawAgentId: "agent-1",
          }],
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
        nextTurn: () => {},
        directSpeak: () => {},
        abortCurrentTurn: () => {},
        addUserMessage: () => {},
      }),
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
// 해석/배선 레이어 — defaultCreateMeetingBroker + resolveNpcAdapter
// 이 층(디스패치 분류, 제외 사유, 어댑터 구성, 엔진 콜백 재매핑)은 이 커밋 전까지
// 어떤 테스트도 실행하지 않았다(M5).
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
    async testConnection() { return { status: "ok" as const }; },
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

test("resolution layer: 제외 사유를 각각 그 사유로 통지한다", async () => {
  const registry = new AdapterRegistry();
  const excluded: ExcludedNotice[] = [];

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({ id: "n-unbound", name: "Unbound", adapterType: "unbound" }),
        npcConfig({ id: "n-hermes", name: "Hermes", adapterType: "hermes", hermesProfileId: "p-1" }),
        // OpenClaw 제거 후: adapterType 이 openclaw 로 남아 있는 NPC 는 agentId 유무와
        // 무관하게 unbound 로 제외된다 — 쓸 백엔드가 더는 존재하지 않기 때문이다.
        npcConfig({ id: "n-oc", name: "LegacyOpenClaw", adapterType: "openclaw", agentId: "agent-9" }),
        npcConfig({ id: "n-registry", name: "Registry", adapterType: "cli" }),
      ],
      { adapterRegistry: registry },
    ),
    { onParticipantsExcluded: (list: ExcludedNotice[]) => excluded.push(...list) },
    { createHermesAdapter: async () => null }, // 프로필 해석 실패를 흉내낸다
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

test("resolution layer: hermes / registry 디스패치가 각각 맞는 백엔드로 가고, openclaw 는 빠진다", async () => {
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["PASS"]) as never);

  const hermesCalls: Array<[string, string, string]> = [];
  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({ id: "n-hermes", name: "Hermes", adapterType: "hermes", hermesProfileId: "p-1" }),
        npcConfig({ id: "n-oc", name: "LegacyOpenClaw", adapterType: "openclaw", agentId: "agent-9" }),
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

  // hermes 갈래만 hermes 어댑터 팩토리를 거친다. contextKey는 sessionKey에서 prefix를 뗀 값이다.
  assert.deepEqual(hermesCalls, [["n-hermes", "user-1", "meeting-meet-1"]]);
  // openclaw 는 쓸 백엔드가 없으므로 참가자로 남지 않는다. agentId 가 있어도 마찬가지다.
  assert.deepEqual(
    broker.config.participants.map((p) => p.npcId),
    ["n-hermes", "n-cli"],
  );
});

test("resolution layer: 개명 후에도 회의 세션키 형식이 그대로다", async () => {
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

test("resolution layer: npc.passPolicy가 엔진까지 살아남아 폴링 프롬프트에 실린다", async () => {
  // item 1(H1)을 되돌리면 — EngineParticipant에서 passPolicy를 빼거나 formatPollMessage에
  // null을 다시 하드코딩하면 — 이 단언이 깨진다.
  const registry = new AdapterRegistry();
  const adapter = recordingAdapter(["PASS"]);
  registry.register(adapter as never);

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [npcConfig({ id: "n-cli", name: "Cli", adapterType: "cli", passPolicy: "근거 없으면 PASS 하세요" })],
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

test("resolution layer: 잘못된 settings.initialMode는 캐스팅되지 않고 auto로 떨어진다", async () => {
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["PASS"]) as never);

  const modeChanges: Array<[string, string]> = [];
  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [npcConfig({ id: "n-cli", name: "Cli", adapterType: "cli" })],
      { adapterRegistry: registry, settings: { initialMode: "bogus" } },
    ),
    { onModeChanged: (mode: string, by: string) => modeChanges.push([mode, by]) },
  );

  // auto로 떨어졌으면 대기 없이 전원 PASS로 자연 종료된다(directed/manual이면 여기서 멈춘다).
  await broker.run();
  assert.deepEqual(modeChanges, [], "생성자에 넘긴 초기 모드는 mode-changed를 만들지 않는다");
  assert.equal(broker.isRunning(), false);
});

test("resolution layer: 참가자의 role이 발언 프롬프트까지 전달된다", async () => {
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
