import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_NPC_STREAM_EVENT,
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
        calls.push({ type: "emit", target: "self", event: "channel:access-denied", payload: input });
      },
    },
  });

  await socket.trigger("meeting:join", { channelId: "channel-1" });

  assert.ok(calls.some((call) => call.type === "join" && call.target === "meeting-channel-1"));
  assert.ok(
    calls.some((call) => call.event === "meeting:state"),
    "expected meeting:state emission",
  );
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
        calls.push({ type: "emit", target: "self", event: "channel:access-denied", payload: input });
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
