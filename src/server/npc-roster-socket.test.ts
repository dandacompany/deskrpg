import assert from "node:assert/strict";
import test from "node:test";

import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";

setupThrowawaySqlite("npc-roster-socket-test");

type RecordedEmit = [string, unknown];

function fakeSocket(emitted: RecordedEmit[]) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  return {
    id: "socket-1",
    on(event: string, handler: (payload: unknown) => unknown) {
      handlers.set(event, handler);
    },
    emit(event: string, payload: unknown) {
      emitted.push([event, payload]);
    },
    async trigger(event: string, payload: unknown) {
      const handler = handlers.get(event);
      assert.ok(handler, `missing handler for ${event}`);
      await handler(payload);
    },
  };
}

function fakeIo(emitted: RecordedEmit[]) {
  return {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push([`${event}@${room}`, payload]);
        },
      };
    },
  };
}

/** Mimics only the broker's participant roster — that is all the guard looks at. */
function fakeBroker(npcIds: string[]) {
  return { config: { participants: npcIds.map((npcId) => ({ npcId })) } };
}

async function setup(opts: { owner?: boolean; npcs?: number } = {}) {
  const { registerNpcRosterHandlers } = await import("./npc-roster-socket");
  const { channelId, npcIds, userId } = await seedChannelWithProfiles({
    placedActive: opts.npcs ?? 1,
  });
  const emitted: RecordedEmit[] = [];
  const socket = fakeSocket(emitted);
  const activeBrokers = new Map<string, { config: { participants: Array<{ npcId: string }> } }>();
  registerNpcRosterHandlers({
    io: fakeIo(emitted),
    socket,
    deps: {
      activeBrokers,
      user: { userId },
      isChannelOwner: async () => opts.owner ?? true,
    },
  });
  return { channelId, npcId: npcIds[0], npcIds, emitted, socket, activeBrokers };
}

test("blocks only NPCs seated in a meeting; uncalled NPCs clock out as usual", async () => {
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { channelId, npcIds, emitted, socket, activeBrokers } = await setup({ npcs: 2 });
  const [inMeeting, notInMeeting] = npcIds;

  // A discussion takes as participants only the subset picked by selectedNpcIds, not all NPCs in the channel.
  activeBrokers.set(channelId, fakeBroker([inMeeting]));

  await socket.trigger("npc:set-active", { channelId, npcId: notInMeeting, active: false });
  assert.equal(emitted.at(-1)![0], `npc:updated@${channelId}`, "부르지 않은 NPC 는 막지 않는다");
  assert.equal((await selectNpcById(notInMeeting))!.active, false);

  await socket.trigger("npc:set-active", { channelId, npcId: inMeeting, active: false });
  assert.deepEqual(emitted.at(-1), [
    "npc:set-active:error",
    { npcId: inMeeting, errorCode: "npc_in_meeting" },
  ]);
  assert.equal((await selectNpcById(inMeeting))!.active, true, "회의 중에는 상태가 바뀌지 않는다");
});

test("without a broker, clocks out even if someone has the meeting panel open", async () => {
  // meetingRooms' participants are people's socket.ids and the room is never deleted —
  // using that for the meeting check would let one viewer with the panel open block the owner indefinitely.
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { channelId, npcId, emitted, socket, activeBrokers } = await setup();

  assert.equal(activeBrokers.size, 0);
  await socket.trigger("npc:set-active", { channelId, npcId, active: false });
  assert.equal(emitted.at(-1)![0], `npc:updated@${channelId}`);
  assert.equal((await selectNpcById(npcId))!.active, false);
});

test("after the meeting ends, the clock-out applies and npc:updated goes to the whole channel", async () => {
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { channelId, npcId, emitted, socket, activeBrokers } = await setup();

  activeBrokers.delete(channelId);
  await socket.trigger("npc:set-active", { channelId, npcId, active: false });
  assert.equal((await selectNpcById(npcId))!.active, false);
  const [event, payload] = emitted.at(-1)!;
  assert.equal(event, `npc:updated@${channelId}`);
  assert.equal((payload as { npc: { id: string; active: boolean } }).npc.id, npcId);
  assert.equal((payload as { npc: { active: boolean } }).npc.active, false);
});

test("clocking in is not blocked even during a meeting", async () => {
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { setNpcActive } = await import("@/lib/npc-roster");
  const { channelId, npcId, emitted, socket, activeBrokers } = await setup();

  await setNpcActive(npcId, false);
  activeBrokers.set(channelId, fakeBroker([npcId]));
  await socket.trigger("npc:set-active", { channelId, npcId, active: true });
  assert.equal((await selectNpcById(npcId))!.active, true);
  assert.equal(emitted.at(-1)![0], `npc:updated@${channelId}`);
});

test("forbidden if not the channel owner", async () => {
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { channelId, npcId, emitted, socket } = await setup({ owner: false });

  await socket.trigger("npc:set-active", { channelId, npcId, active: false });
  assert.deepEqual(emitted.at(-1), ["npc:set-active:error", { npcId, errorCode: "forbidden" }]);
  assert.equal((await selectNpcById(npcId))!.active, true);
});

test("an NPC in another channel cannot be touched with ownership of one's own channel", async () => {
  const { selectNpcById } = await import("@/lib/npc-projection");
  const { channelId, emitted, socket } = await setup();
  const other = await seedChannelWithProfiles({ placedActive: 1 });

  await socket.trigger("npc:set-active", { channelId, npcId: other.npcIds[0], active: false });
  assert.deepEqual(emitted.at(-1), [
    "npc:set-active:error",
    { npcId: other.npcIds[0], errorCode: "npc_not_found" },
  ]);
  assert.equal((await selectNpcById(other.npcIds[0]))!.active, true);
});

test("silently ignores an empty payload", async () => {
  const { channelId, npcId, emitted, socket } = await setup();

  await socket.trigger("npc:set-active", undefined);
  await socket.trigger("npc:set-active", { channelId, npcId });
  assert.deepEqual(emitted, []);
});
