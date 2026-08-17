import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../lib/adapters/types";
import {
  defaultCreateMeetingBroker,
  registerMeetingDiscussionHandlers,
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
      getOrConnectGateway: async () => ({ connected: true }),
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
// 해석/배선 레이어 — defaultCreateMeetingBroker + resolveMeetingParticipant
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
    gateway: { connected: true },
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

test("resolution layer: 제외 사유 다섯 가지를 각각 그 사유로 통지한다", async () => {
  const registry = new AdapterRegistry();
  const excluded: ExcludedNotice[] = [];

  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({ id: "n-unbound", name: "Unbound", adapterType: "unbound" }),
        npcConfig({ id: "n-hermes", name: "Hermes", adapterType: "hermes", hermesProfileId: "p-1" }),
        npcConfig({ id: "n-noagent", name: "NoAgent", adapterType: "openclaw", agentId: null }),
        npcConfig({ id: "n-nogw", name: "NoGateway", adapterType: "openclaw", agentId: "agent-9" }),
        npcConfig({ id: "n-registry", name: "Registry", adapterType: "cli" }),
      ],
      { gateway: null, adapterRegistry: registry },
    ),
    { onParticipantsExcluded: (list: ExcludedNotice[]) => excluded.push(...list) },
    { createHermesAdapter: async () => null }, // 프로필 해석 실패를 흉내낸다
  );

  assert.deepEqual(
    excluded.map((e) => [e.npcId, e.reason]),
    [
      ["n-unbound", "unbound"],
      ["n-hermes", "hermes_profile_unavailable"],
      ["n-noagent", "no_agent"],
      ["n-nogw", "gateway_not_connected"],
      ["n-registry", "adapter_unavailable"],
    ],
  );
  assert.deepEqual(broker.config.participants, [], "해석에 실패한 NPC는 참가자로 남지 않는다");
});

test("resolution layer: hermes / openclaw / registry 디스패치가 각각 맞는 백엔드로 간다", async () => {
  const registry = new AdapterRegistry();
  registry.register(recordingAdapter(["PASS"]) as never);

  const hermesCalls: Array<[string, string, string]> = [];
  const broker = await defaultCreateMeetingBroker(
    brokerConfig(
      [
        npcConfig({ id: "n-hermes", name: "Hermes", adapterType: "hermes", hermesProfileId: "p-1" }),
        npcConfig({ id: "n-oc", name: "OpenClaw", adapterType: "openclaw", agentId: "agent-9" }),
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
  // openclaw 갈래만 openclawAgentId를 채운다(회의 요약이 이 값을 쓴다).
  assert.deepEqual(
    broker.config.participants.map((p) => [p.npcId, p.openclawAgentId]),
    [["n-hermes", null], ["n-oc", "agent-9"], ["n-cli", null]],
  );
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
