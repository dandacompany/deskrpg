import assert from "node:assert/strict";
import test from "node:test";

import { setupThrowawaySqlite, seedUser, seedChannel } from "@/test-setup/npc-seed";

// `./conversation-reads` statically imports `@/db`, so every test imports it dynamically after the
// throwaway DB is set (same pattern as chat-rooms.test.ts).
setupThrowawaySqlite("conversation-reads-test");

const T = (minute: number) => new Date(Date.UTC(2026, 8, 26, 10, minute)).toISOString();

async function seedRoom() {
  const { ensureOfficeRoom } = await import("./chat-rooms");
  const me = await seedUser("me");
  const other = await seedUser("other");
  const channel = await seedChannel(me.id);
  const room = await ensureOfficeRoom(channel.id, me.id);
  return { me, other, channel, room };
}

async function addRoomMessage(input: {
  roomId: string;
  at: string;
  senderKind?: "user" | "npc" | "system";
  senderId?: string | null;
  noticeJson?: string | null;
}) {
  const { db, chatRoomMessages } = await import("@/db");
  await db.insert(chatRoomMessages).values({
    id: crypto.randomUUID(),
    roomId: input.roomId,
    senderKind: input.senderKind ?? "npc",
    senderId: input.senderId ?? null,
    senderName: "someone",
    content: "hello",
    noticeJson: input.noticeJson ?? null,
    createdAt: input.at as unknown as Date,
  });
}

test("room unread counts only others' visible messages after the read point", async () => {
  const { markConversationRead, roomUnreadCounts } = await import("./conversation-reads");
  const { me, other, room } = await seedRoom();
  await addRoomMessage({ roomId: room.id, at: T(1) });
  await markConversationRead({
    userId: me.id,
    kind: "room",
    targetId: room.id,
    at: new Date(T(2)),
  });
  await addRoomMessage({ roomId: room.id, at: T(3) }); // counted
  await addRoomMessage({ roomId: room.id, at: T(4), senderKind: "user", senderId: me.id }); // mine
  await addRoomMessage({ roomId: room.id, at: T(5), senderKind: "user", senderId: other.id }); // counted
  await addRoomMessage({
    roomId: room.id,
    at: T(6),
    senderKind: "system",
    noticeJson: JSON.stringify({ kind: "approval_blocked", audience: other.id }),
  }); // someone else's private notice

  const counts = await roomUnreadCounts(me.id, [room.id]);
  assert.equal(counts.get(room.id), 2);
});

test("a room with no read point counts every visible message, and an empty room is 0", async () => {
  const { roomUnreadCounts } = await import("./conversation-reads");
  const { createRoom } = await import("./chat-rooms");
  const { me, channel, room } = await seedRoom();
  await addRoomMessage({ roomId: room.id, at: T(1) });
  await addRoomMessage({ roomId: room.id, at: T(2) });
  const empty = await createRoom({
    channelId: channel.id,
    name: "empty",
    createdBy: me.id,
    npcIds: [],
    userIds: [],
  });

  const counts = await roomUnreadCounts(me.id, [room.id, empty.id]);
  assert.equal(counts.get(room.id), 2);
  assert.equal(counts.get(empty.id) ?? 0, 0);
});

test("the read point only moves forward and never past now", async () => {
  const { markConversationRead, readMarks } = await import("./conversation-reads");
  const { me, room } = await seedRoom();
  const late = await markConversationRead({
    userId: me.id,
    kind: "room",
    targetId: room.id,
    at: new Date(T(5)),
  });
  assert.equal(late, T(5));
  const back = await markConversationRead({
    userId: me.id,
    kind: "room",
    targetId: room.id,
    at: new Date(T(1)),
  });
  assert.equal(back, T(5), "an older mark does not move the point back");

  const future = new Date(Date.now() + 86_400_000);
  const clamped = await markConversationRead({
    userId: me.id,
    kind: "room",
    targetId: room.id,
    at: future,
  });
  assert.ok(new Date(clamped).getTime() <= Date.now(), "a future mark is clamped to now");
  assert.equal((await readMarks(me.id, "room", [room.id])).get(room.id), clamped);
});

test("baselines are written only where no read point exists", async () => {
  const { ensureReadBaselines, markConversationRead, readMarks } =
    await import("./conversation-reads");
  const { me, room } = await seedRoom();
  const otherRoom = crypto.randomUUID();
  await markConversationRead({
    userId: me.id,
    kind: "room",
    targetId: room.id,
    at: new Date(T(1)),
  });

  await ensureReadBaselines(me.id, "room", [room.id, otherRoom], new Date(T(9)));

  const marks = await readMarks(me.id, "room", [room.id, otherRoom]);
  assert.equal(marks.get(room.id), T(1), "an existing point is kept");
  assert.equal(marks.get(otherRoom), T(9));
});

test("DM unread counts only the NPC's replies after the read point, per NPC", async () => {
  const { dmUnreadCounts, markConversationRead } = await import("./conversation-reads");
  const { db, characters, chatMessages } = await import("@/db");
  const me = await seedUser("dm");
  const [character] = await db
    .insert(characters)
    .values({ userId: me.id, name: "Me", appearance: "{}" })
    .returning();
  const { seedChannelWithProfiles } = await import("@/test-setup/npc-seed");
  const seeded = await seedChannelWithProfiles({ placedActive: 2 });
  const [a, b] = seeded.npcIds.map((id) => ({ id }));
  const add = (npcId: string, role: string, at: string) =>
    db.insert(chatMessages).values({
      characterId: character.id,
      npcId,
      role,
      content: "x",
      createdAt: at as unknown as Date,
    });
  await add(a.id, "npc", T(1));
  await add(a.id, "player", T(2));
  await markConversationRead({ userId: me.id, kind: "dm", targetId: a.id, at: new Date(T(2)) });
  await add(a.id, "npc", T(3));
  await add(a.id, "player", T(4));
  await add(b.id, "npc", T(1));

  const counts = await dmUnreadCounts(me.id, character.id, [a.id, b.id]);
  assert.equal(counts.get(a.id), 1);
  assert.equal(counts.get(b.id), 1);
});

test("report acknowledgments: none at first, import once, then per-report acks accumulate", async () => {
  const { loadReportAck, importReportAck, acknowledgeReportFor } =
    await import("./conversation-reads");
  const { me, channel } = await seedRoom();

  assert.equal(await loadReportAck(me.id, channel.id), null);

  const imported = await importReportAck(me.id, channel.id, { through: T(3), ids: ["m1"] });
  assert.deepEqual(imported, { through: T(3), ids: ["m1"] });

  const acked = await acknowledgeReportFor(me.id, channel.id, "m2");
  assert.deepEqual(acked, { through: T(3), ids: ["m1", "m2"] });
  assert.deepEqual(await acknowledgeReportFor(me.id, channel.id, "m2"), acked, "idempotent");

  // A second import (another browser's leftovers) merges instead of overwriting.
  const merged = await importReportAck(me.id, channel.id, { through: T(1), ids: ["m0", "m1"] });
  assert.deepEqual(merged, { through: T(3), ids: ["m1", "m2", "m0"] });
});

test("an acknowledgment with no watermark round-trips as null", async () => {
  const { loadReportAck, acknowledgeReportFor } = await import("./conversation-reads");
  const { me, channel } = await seedRoom();
  await acknowledgeReportFor(me.id, channel.id, "m1");
  assert.deepEqual(await loadReportAck(me.id, channel.id), { through: null, ids: ["m1"] });
});
