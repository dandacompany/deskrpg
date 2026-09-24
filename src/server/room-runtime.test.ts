import assert from "node:assert/strict";
import test from "node:test";
import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";

setupThrowawaySqlite("room-runtime-test");

import * as rooms from "@/lib/chat-rooms";
import type { NpcAdapter, AdapterExecuteOptions } from "@/lib/adapters/types";
import {
  getOrCreateRoomRuntime,
  invalidateRoomRuntime,
  type RoomRuntimeDeps,
} from "./room-runtime";

type Emitted = [string, unknown];

function fakeIo(emitted: Emitted[]) {
  return {
    to(room: string) {
      return {
        emit(e: string, p: unknown) {
          emitted.push([`${e}@${room}`, p]);
        },
      };
    },
  };
}

/** Small settle window retained for legacy event assertions. */
const settle = () => new Promise((r) => setTimeout(r, 30));

const ev = (emitted: Emitted[], name: string) =>
  emitted.filter(([e]) => e.startsWith(name)).map(([, p]) => p);

/** Mock adapter that returns a fixed answer and records the transcripts it received. */
function mockAdapter(reply: string, prompts: string[] = []): NpcAdapter {
  return {
    type: "mock",
    async execute(o: AdapterExecuteOptions) {
      prompts.push(String(o.prompt ?? ""));
      return { response: reply, session: { sessionRef: o.sessionKey } };
    },
    async testConnection() {
      return { status: "ok" as const };
    },
  } as NpcAdapter;
}

/**
 * Observes only this file's assembly rules, without a gateway or CLI. The real wiring (`getNpcConfigsForChannel`
 * + `resolveNpcAdapter`) requires hermes profiles in the DB and a live backend.
 */
function injected(
  channelId: string,
  npcs: { id: string; name: string; adapter: NpcAdapter }[],
): RoomRuntimeDeps {
  const byId = new Map(npcs.map((n) => [n.id, n]));
  return {
    getNpcConfigs: async () =>
      npcs.map((n) => ({
        id: n.id,
        name: n.name,
        agentId: null,
        sessionKeyPrefix: n.id,
        adapterType: "mock",
        adapterConfig: {},
        hermesProfileId: null,
        _channelId: channelId,
        _name: n.name,
        role: "Participant",
        passPolicy: null,
      })),
    resolveAdapter: async (npc, ctx) => ({
      participant: {
        npcId: npc.id,
        displayName: npc.name,
        role: "동료",
        passPolicy: null,
        instructions: null,
      },
      adapter: byId.get(npc.id)!.adapter,
      sessionKey: `${npc.sessionKeyPrefix}-${ctx.sessionScope}`,
    }),
  };
}

async function seedRoom(opts: { npcCount: number; memberCount: number }) {
  const seeded = await seedChannelWithProfiles({ placedActive: opts.npcCount });
  const room = await rooms.createRoom({
    channelId: seeded.channelId,
    name: "기획",
    createdBy: seeded.userId,
    npcIds: seeded.npcIds.slice(0, opts.memberCount),
    userIds: [],
  });
  return { seeded, room };
}

test("a group room's participants are only that room's NPC members, not every on-duty NPC", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 3, memberCount: 2 });
  const emitted: Emitted[] = [];
  const prompts: string[] = [];
  const spoke: string[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("네", prompts) },
    { id: seeded.npcIds[1], name: "하늘", adapter: mockAdapter("저도요", prompts) },
    { id: seeded.npcIds[2], name: "단비", adapter: mockAdapter("불려오면 안 됨", prompts) },
  ]);

  invalidateRoomRuntime(room.id);
  const runtime = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  assert.ok(runtime);

  // members policy — with no mention, every member answers. Danbi, outside the room, does not join.
  await runtime.handleHumanMessage("단테", "다들 어때", "s1");
  await settle();
  for (const p of ev(emitted, `room:message@room-${room.id}`) as {
    message: { senderName: string };
  }[])
    spoke.push(p.message.senderName);
  assert.deepEqual(spoke.sort(), ["소피", "하늘"]);
});

test("the mention policy (office) wakes only the mentioned NPC", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 2 });
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  const emitted: Emitted[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("네") },
    { id: seeded.npcIds[1], name: "하늘", adapter: mockAdapter("저도요") },
  ]);

  invalidateRoomRuntime(office.id);
  const runtime = await getOrCreateRoomRuntime(
    fakeIo(emitted) as never,
    office,
    seeded.userId,
    deps,
  );
  assert.ok(runtime);

  // In an office room every on-duty NPC in the channel participates (the attendance roster, not the member table,
  // is the source of truth).
  await runtime.handleHumanMessage("단테", "@[소피] 안녕", "s1");
  await settle();
  const said = (
    ev(emitted, `room:message@room-${office.id}`) as { message: { senderName: string } }[]
  ).map((p) => p.message.senderName);
  assert.deepEqual(said, ["소피"], "지명하지 않은 하늘은 답하지 않는다");
});

test("NPC answers are stored in the DB and broadcast to room-<id>", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("점심은 김치찌개요") },
  ]);

  invalidateRoomRuntime(room.id);
  const runtime = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  assert.ok(runtime);
  await runtime.handleHumanMessage("단테", "뭐 먹지", "s1");
  await settle();

  const [broadcast] = ev(emitted, `room:message@room-${room.id}`) as {
    roomId: string;
    message: { senderKind: string; senderId: string; senderName: string; content: string };
  }[];
  assert.equal(broadcast.roomId, room.id);
  assert.equal(broadcast.message.senderKind, "npc");
  assert.equal(broadcast.message.senderId, seeded.npcIds[0]);
  assert.equal(broadcast.message.content, "점심은 김치찌개요");

  const stored = await rooms.recentRoomMessages(room.id, 10);
  assert.deepEqual(
    stored.map((m) => [m.senderKind, m.content]),
    [["npc", "점심은 김치찌개요"]],
    "사람 메시지는 소켓 계층이 저장한다 — 런타임은 NPC 의 답만 남긴다",
  );
});

test("when a turn opens, npc:come-to-player goes out to the channel room with roomId attached", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("네") },
  ]);

  invalidateRoomRuntime(room.id);
  const runtime = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  assert.ok(runtime);
  await runtime.handleHumanMessage("단테", "소피야", "socket-abc");

  const [call] = ev(emitted, `npc:come-to-player@${seeded.channelId}`) as {
    npcId: string;
    targetPlayerId: string;
    reason: string;
    roomId: string;
  }[];
  assert.deepEqual(call, {
    npcId: seeded.npcIds[0],
    targetPlayerId: "socket-abc",
    reason: "map-chat",
    roomId: room.id,
  });
});

test("recent conversation carries at most 10 lines, and identical words from different messages both stay", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  const prompts: string[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("응", prompts) },
  ]);

  const contents = ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "네", "네"];
  for (const content of contents) {
    await rooms.appendRoomMessage({
      roomId: room.id,
      senderKind: "user",
      senderId: seeded.userId,
      senderName: "단테",
      content,
    });
  }
  // System messages must not be put in the prompt.
  await rooms.appendRoomMessage({
    roomId: room.id,
    senderKind: "system",
    senderId: null,
    senderName: "",
    content: JSON.stringify({ kind: "renamed", name: "기획 2팀" }),
  });
  // The socket layer stores the human's message first — the runtime wakes up after that.
  await rooms.appendRoomMessage({
    roomId: room.id,
    senderKind: "user",
    senderId: seeded.userId,
    senderName: "단테",
    content: "질문",
  });

  invalidateRoomRuntime(room.id);
  const runtime = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  assert.ok(runtime);
  await runtime.handleHumanMessage("단테", "질문", "s1");

  const recentBlock = prompts[0].split("[최근 대화]")[1].split("[답하는 법]")[0].trim();
  const lines = recentBlock.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 10, "최근 10줄만 싣는다");
  assert.equal(lines.filter((l) => l === "단테: 네").length, 2, "같은 말도 다른 메시지면 둘 다");
  assert.equal(lines.at(-1), "단테: 질문");
  assert.ok(!recentBlock.includes("renamed"), "시스템 메시지는 대본에 실리지 않는다");
  assert.ok(!lines.includes("단테: m0"), "가장 오래된 줄은 밀려난다");
});

test("sending the same words twice keeps both in the transcript — a legitimate repeat at an interval longer than the cooldown (2s)", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  const prompts: string[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "소피", adapter: mockAdapter("응", prompts) },
  ]);

  // What the socket layer does: store the human's message first, then wake the runtime.
  const say = async (content: string) => {
    await rooms.appendRoomMessage({
      roomId: room.id,
      senderKind: "user",
      senderId: seeded.userId,
      senderName: "단테",
      content,
    });
  };

  invalidateRoomRuntime(room.id);
  await say("네");
  const runtime = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  assert.ok(runtime);
  await runtime.handleHumanMessage("단테", "네", "s1");
  await settle();

  await say("네");
  await runtime.handleHumanMessage("단테", "네", "s1");
  await settle();

  const recentBlock = prompts.at(-1)!.split("[최근 대화]")[1].split("[답하는 법]")[0];
  const lines = recentBlock.split("\n").filter((l) => l.length > 0);
  assert.equal(
    lines.filter((l) => l === "단테: 네").length,
    2,
    "두 번째 '네' 가 사라지면 NPC 는 사람이 다시 물었다는 것을 모른다",
  );
});

test("room emits receipt, thinking and cumulative content before final persisted message", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let streamed!: () => void;
  const ready = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  const adapter = mockAdapter("안녕하세요");
  adapter.execute = async (opts) => {
    opts.onDelta?.("안녕");
    streamed();
    await gate;
    opts.onDelta?.("하세요");
    return { response: "안녕하세요", session: { sessionRef: "test" } };
  };
  const rt = await getOrCreateRoomRuntime(
    fakeIo(emitted) as never,
    room,
    seeded.userId,
    injected(seeded.channelId, [{ id: seeded.npcIds[0], name: "소피", adapter }]),
  );
  assert.ok(rt);
  const result = rt.handleHumanMessage("단테", "안녕", "socket", "source-message");
  await ready;
  const responses = ev(emitted, "room:response-state") as {
    response: import("@/lib/chat-response").ChatResponse;
  }[];
  const beforeFinalMessages = ev(emitted, "room:message").length;
  release();
  await result;
  assert.deepEqual(
    responses.map((r) => r.response.status),
    ["queued", "thinking", "streaming"],
  );
  assert.equal(responses[2].response.content, "안녕");
  assert.equal(responses[0].response.sourceMessageId, "source-message");
  assert.equal(beforeFinalMessages, 0);
  const final = (
    ev(emitted, "room:response-state").at(-1) as {
      response: import("@/lib/chat-response").ChatResponse;
    }
  ).response;
  assert.equal(final.status, "complete");
  assert.equal(final.content, "안녕하세요");
  const messages = await rooms.recentRoomMessages(room.id, 10);
  assert.equal(final.messageId, messages[0].id);
});

test("invalidated pending room construction cannot replace a newer response snapshot", async () => {
  const { seeded, room } = await seedRoom({ npcCount: 1, memberCount: 1 });
  const emitted: Emitted[] = [];
  const deps = injected(seeded.channelId, [
    { id: seeded.npcIds[0], name: "Sophie", adapter: mockAdapter("hello") },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, {
    ...deps,
    getNpcConfigs: async (...args) => {
      await gate;
      return deps.getNpcConfigs!(...args);
    },
  });
  invalidateRoomRuntime(room.id);
  const current = await getOrCreateRoomRuntime(fakeIo(emitted) as never, room, seeded.userId, deps);
  await current!.handleHumanMessage("Dante", "hello", "socket", "source");
  release();
  assert.equal(await old, null);
  const { getRoomResponseSnapshot } = await import("./room-runtime");
  assert.equal(getRoomResponseSnapshot(room.id).length, 1);
});
