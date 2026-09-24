import assert from "node:assert/strict";
import test from "node:test";

import {
  setupThrowawaySqlite,
  seedUser,
  seedChannel,
  seedChannelWithProfiles,
} from "@/test-setup/npc-seed";

// `db` is a lazily-initialized singleton, and node:test splits into a process per file,
// so grabbing a temp DB once at the top of the module means every test in this file uses that DB.
// `./chat-rooms` statically imports `@/db`, so to avoid ESM hoisting, this file also has
// to use a dynamic import in every test (same pattern as npc-roster.test.ts).
setupThrowawaySqlite("chat-rooms-test");

test("there's one office room per channel — calling it twice returns the same id", async () => {
  const { ensureOfficeRoom } = await import("./chat-rooms");
  const owner = await seedUser();
  const ch = await seedChannel(owner.id);
  const a = await ensureOfficeRoom(ch.id, owner.id);
  const b = await ensureOfficeRoom(ch.id, owner.id);
  assert.equal(a.id, b.id);
  assert.equal(a.replyPolicy, "mention");
});

test("the list is office + only groups I'm a member of", async () => {
  const { ensureOfficeRoom, createRoom, listRoomsForUser, isRoomMember } =
    await import("./chat-rooms");
  const owner = await seedUser("owner");
  const other = await seedUser("other");
  const ch = await seedChannel(owner.id);
  await ensureOfficeRoom(ch.id, owner.id);
  const mine = await createRoom({
    channelId: ch.id,
    name: "기획",
    createdBy: owner.id,
    npcIds: [],
    userIds: [],
  });
  await createRoom({
    channelId: ch.id,
    name: "남의 방",
    createdBy: other.id,
    npcIds: [],
    userIds: [],
  });
  const rooms = await listRoomsForUser(ch.id, owner.id);
  assert.deepEqual(
    rooms.map((r) => r.kind),
    ["office", "group"],
  );
  assert.equal(rooms[1].id, mine.id);
  assert.equal(await isRoomMember(mine.id, owner.id), true, "만든 사람은 자동 멤버");
});

test("stacking messages bumps last_message_at and returns the most recent N lines oldest-first", async () => {
  const { createRoom, appendRoomMessage, recentRoomMessages, listRoomsForUser } =
    await import("./chat-rooms");
  const owner = await seedUser();
  const ch = await seedChannel(owner.id);
  const room = await createRoom({
    channelId: ch.id,
    name: "r",
    createdBy: owner.id,
    npcIds: [],
    userIds: [],
  });
  await appendRoomMessage({
    roomId: room.id,
    senderKind: "user",
    senderId: owner.id,
    senderName: "단테",
    content: "1",
  });
  await appendRoomMessage({
    roomId: room.id,
    senderKind: "npc",
    senderId: "n",
    senderName: "소피",
    content: "2",
  });
  await appendRoomMessage({
    roomId: room.id,
    senderKind: "system",
    senderId: null,
    senderName: "",
    content: "3",
  });
  const recent = await recentRoomMessages(room.id, 2);
  assert.deepEqual(
    recent.map((m) => m.content),
    ["2", "3"],
  );
  // Mixes in a room with zero messages in the same list query, to check that the batch
  // query (N+1 removal) matches rooms with and without messages correctly, without mixing them up.
  const emptyRoom = await createRoom({
    channelId: ch.id,
    name: "빈 방",
    createdBy: owner.id,
    npcIds: [],
    userIds: [],
  });
  const rooms = await listRoomsForUser(ch.id, owner.id);
  const summary = rooms.find((r) => r.id === room.id);
  const emptySummary = rooms.find((r) => r.id === emptyRoom.id);
  assert.equal(summary?.lastMessage?.content, "3");
  assert.equal(emptySummary?.lastMessage, undefined);
});

test("inviting an NPC member ignores duplicates, and deleting a room cascades", async () => {
  const {
    createRoom,
    addMembers,
    roomNpcMemberIds,
    appendRoomMessage,
    deleteRoom,
    recentRoomMessages,
  } = await import("./chat-rooms");
  const seeded = await seedChannelWithProfiles({ placedActive: 2 });
  const room = await createRoom({
    channelId: seeded.channelId,
    name: "r",
    createdBy: seeded.userId,
    npcIds: [seeded.npcIds[0]],
    userIds: [],
  });
  await addMembers(room.id, seeded.userId, [seeded.npcIds[0], seeded.npcIds[1]], []);
  assert.deepEqual(
    (await roomNpcMemberIds(room.id)).sort(),
    [seeded.npcIds[0], seeded.npcIds[1]].sort(),
  );
  await appendRoomMessage({
    roomId: room.id,
    senderKind: "user",
    senderId: seeded.userId,
    senderName: "u",
    content: "x",
  });
  await deleteRoom(room.id);
  assert.deepEqual(await recentRoomMessages(room.id, 10), []);
});
