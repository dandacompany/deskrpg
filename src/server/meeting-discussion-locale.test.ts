import assert from "node:assert/strict";
import test from "node:test";

import { AdapterRegistry } from "../lib/adapters/types";
import {
  defaultCreateMeetingBroker,
  registerMeetingDiscussionHandlers,
  type MeetingBrokerLike,
} from "./meeting-discussion";

// The meeting speaks the language of whoever opened it: the opener's socket locale is captured at
// start and reaches the turn prompts, the minutes and the summary prompt.

type Deps = Parameters<typeof registerMeetingDiscussionHandlers>[0]["deps"];
type BrokerFactory = NonNullable<Deps["createMeetingBroker"]>;

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  return {
    id: "socket-1",
    on(event: string, handler: (payload: unknown) => unknown) {
      handlers.set(event, handler);
    },
    emit() {},
    async trigger(event: string, payload: unknown) {
      await handlers.get(event)!(payload);
    },
  };
}

const fakeIo = { to: () => ({ emit() {} }) };

function npcConfig() {
  return {
    id: "npc-1",
    name: "Analyst",
    agentId: null as string | null,
    sessionKeyPrefix: "sess-1",
    adapterType: "cli",
    hermesProfileId: null as string | null,
    role: "Participant",
    passPolicy: null as string | null,
  };
}

function recordingAdapter(reply: string) {
  const prompts: string[] = [];
  return {
    type: "cli",
    prompts,
    async execute(options: { sessionKey: string; prompt: string }) {
      prompts.push(options.prompt);
      return { response: reply, session: { sessionRef: options.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  };
}

for (const locale of ["ja", null] as const) {
  test(`a meeting opened from a ${String(locale)} socket summarizes in that language`, async () => {
    const registry = new AdapterRegistry();
    registry.register(recordingAdapter("ok") as never);
    const configs: Parameters<BrokerFactory>[0][] = [];
    const callbacks: Parameters<BrokerFactory>[1][] = [];
    const summaryLocales: unknown[] = [];
    const socket = fakeSocket();
    registerMeetingDiscussionHandlers({
      io: fakeIo as never,
      socket: socket as never,
      deps: {
        activeBrokers: new Map<string, MeetingBrokerLike>(),
        discussionInitiators: new Map(),
        meetingRooms: new Map([["a", { participants: new Set(["socket-1"]), messages: [] }]]),
        players: new Map(),
        user: { userId: "u1" },
        adapterRegistry: registry,
        locale,
        canControlMeeting: () => true,
        getNpcConfigsForChannel: async () => [npcConfig()],
        createMeetingBroker: (config, cb) => {
          configs.push(config);
          callbacks.push(cb);
          return {
            config: { participants: [{ npcId: "npc-1", displayName: "Analyst" }] },
            turns: [],
            isRunning: () => true,
            stop: () => {},
            run: () => Promise.resolve(),
          } as unknown as MeetingBrokerLike;
        },
        generateMeetingSummary: async (...args) => {
          summaryLocales.push(args[5]);
          return { keyTopics: [], conclusions: null };
        },
        persistMeetingMinutes: async () => null,
      },
    });
    await socket.trigger("meeting:start-discussion", { channelId: "a", topic: "Roadmap" });
    await callbacks[0].onMeetingEnd!("transcript", 1);
    assert.equal(configs[0].locale, locale);
    assert.deepEqual(summaryLocales, [locale]);
  });
}

test("the default broker runs English turn prompts and minutes for a non-Korean meeting", async () => {
  const adapter = recordingAdapter("PASS");
  const registry = new AdapterRegistry();
  registry.register(adapter as never);
  let transcript = "";
  const broker = await defaultCreateMeetingBroker(
    {
      topic: "Roadmap",
      npcs: [npcConfig()],
      userId: "u1",
      channelId: "c1",
      adapterRegistry: registry,
      sessionKeyPrefix: "sess-1",
      meetingId: "meet-1",
      settings: {},
      quota: { maxTotalTurns: 2 },
      locale: "en",
    } as unknown as Parameters<typeof defaultCreateMeetingBroker>[0],
    {
      onMeetingEnd: (text) => {
        transcript = text;
      },
    },
  );
  await broker.run();
  assert.ok(adapter.prompts[0]?.startsWith("📋 [Meeting poll: Roadmap]"));
  assert.ok(transcript.startsWith("# Meeting minutes: Roadmap"));
});
