import assert from "node:assert/strict";
import test from "node:test";

import type { RoomMessage, RoomSummary } from "@/lib/chat-rooms-policy";
import { initialRoomState, lastRoomKey, reduceRoomState, totalRoomUnread } from "./room-state";

// The brief's literal was `as const`, but then `members` becomes a readonly tuple and
// is not assignable to RoomSummary (tsc goes red). Keep the meaning and only add a type.
const office: RoomSummary = {
  id: "o",
  kind: "office",
  name: "office",
  replyPolicy: "mention",
  createdBy: "u",
  lastMessageAt: null,
  members: [],
};
const g1: RoomSummary = {
  ...office,
  id: "g1",
  kind: "group",
  name: "기획",
  replyPolicy: "members",
};

test("when the list arrives, enter the last room (if any), otherwise office", () => {
  const s1 = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: "g1",
  });
  assert.equal(s1.currentRoomId, "g1");
  assert.equal(s1.view, "room");
  const s2 = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: "gone",
  });
  assert.equal(s2.currentRoomId, "o");
});

test("even with one room, an explicit showList moves to the new-room list", () => {
  const s = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office],
    preferRoomId: null,
  });
  assert.equal(reduceRoomState(s, { type: "showList" }).view, "list");
  const s2 = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: null,
  });
  assert.equal(reduceRoomState(s2, { type: "showList" }).view, "list");
});

test("messages accumulate per room and the list's lastMessage updates", () => {
  let s = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: null,
  });
  const m: RoomMessage = {
    id: "m1",
    roomId: "g1",
    senderKind: "user",
    senderId: "u",
    senderName: "단테",
    content: "hi",
    createdAt: "2026-09-10T00:00:00Z",
  };
  s = reduceRoomState(s, { type: "message", roomId: "g1", message: m });
  assert.deepEqual(s.messages.g1, [m]);
  assert.equal(s.rooms.find((r) => r.id === "g1")?.lastMessage?.content, "hi");
  assert.equal(s.rooms.find((r) => r.id === "g1")?.lastMessage?.notice, null);
  assert.equal(s.rooms[1].id, "g1", "최신 메시지 방이 office 바로 아래로");
});

test("a message with the same id does not accumulate twice", () => {
  let s = reduceRoomState(initialRoomState, { type: "list", rooms: [office], preferRoomId: null });
  const m: RoomMessage = {
    id: "m1",
    roomId: "o",
    senderKind: "npc",
    senderId: "n1",
    senderName: "소피",
    content: "네",
    createdAt: "2026-09-10T00:00:00Z",
  };
  s = reduceRoomState(s, { type: "message", roomId: "o", message: m });
  s = reduceRoomState(s, { type: "message", roomId: "o", message: m });
  assert.equal(s.messages.o.length, 1);
});

test("when the same id comes back as a resolved notice it is swapped in place — order and count stay the same", () => {
  let s = reduceRoomState(initialRoomState, { type: "list", rooms: [office], preferRoomId: null });
  const notice = {
    kind: "meeting_outcome" as const,
    minutesId: "min-1",
    topic: "가격 개편",
    followUpCount: 2,
    recommended: true,
  };
  const first: RoomMessage = {
    id: "n1",
    roomId: "o",
    senderKind: "system",
    senderId: null,
    senderName: "",
    content: "가격 개편",
    createdAt: "2026-09-10T00:00:00Z",
    notice,
  };
  const later: RoomMessage = {
    ...first,
    id: "n2",
    createdAt: "2026-09-10T00:01:00Z",
    notice: undefined,
  };
  s = reduceRoomState(s, { type: "message", roomId: "o", message: first });
  s = reduceRoomState(s, { type: "message", roomId: "o", message: later });

  const resolved = {
    ...notice,
    resolved: { boardSlug: "b", tenant: null, taskCount: 2, by: "u1", at: "2026-09-10T00:02:00Z" },
  };
  s = reduceRoomState(s, { type: "message", roomId: "o", message: { ...first, notice: resolved } });

  assert.deepEqual(
    s.messages.o.map((m) => m.id),
    ["n1", "n2"],
    "되쓰인 알림이 새 줄로 쌓이거나 순서를 바꾸면 안 된다",
  );
  assert.deepEqual(s.messages.o[0].notice, resolved, "등록 결과가 새로고침 없이 보여야 한다");
});

test("history replaces that room's messages wholesale", () => {
  let s = reduceRoomState(initialRoomState, { type: "list", rooms: [office], preferRoomId: null });
  const m: RoomMessage = {
    id: "m1",
    roomId: "o",
    senderKind: "user",
    senderId: "u",
    senderName: "단테",
    content: "hi",
    createdAt: "2026-09-10T00:00:00Z",
  };
  s = reduceRoomState(s, { type: "message", roomId: "o", message: m });
  s = reduceRoomState(s, { type: "history", roomId: "o", messages: [] });
  assert.deepEqual(s.messages.o, []);
});

test("created(enter) enters the new room, and deleted goes to the list if it is the current room", () => {
  let s = reduceRoomState(initialRoomState, { type: "list", rooms: [office], preferRoomId: null });
  s = reduceRoomState(s, { type: "created", room: g1, enter: true });
  assert.equal(s.currentRoomId, "g1");
  s = reduceRoomState(s, { type: "deleted", roomId: "g1" });
  assert.equal(s.view, "room");
  assert.equal(s.currentRoomId, "o");
});

test("created(enter=false) only adds to the list and does not change the current room", () => {
  let s = reduceRoomState(initialRoomState, { type: "list", rooms: [office], preferRoomId: null });
  s = reduceRoomState(s, { type: "created", room: g1, enter: false });
  assert.equal(s.currentRoomId, "o");
  assert.equal(s.rooms.length, 2);
});

test("updated swaps the same room in place", () => {
  let s = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: null,
  });
  s = reduceRoomState(s, { type: "updated", room: { ...g1, name: "기획2" }, enter: false });
  assert.equal(s.rooms.length, 2);
  assert.equal(s.rooms.find((r) => r.id === "g1")?.name, "기획2");
});

test("open/compose move the view", () => {
  let s = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: null,
  });
  s = reduceRoomState(s, { type: "compose", presetNpcIds: ["n1"] });
  assert.equal(s.view, "compose");
  assert.deepEqual(s.compose, { presetNpcIds: ["n1"], inviteTo: undefined });
  s = reduceRoomState(s, { type: "open", roomId: "g1" });
  assert.equal(s.view, "room");
  assert.equal(s.currentRoomId, "g1");
  assert.equal(s.compose, undefined, "방으로 들어가면 작성 상태는 버린다");
});

test("lastRoomKey is split per channel", () => {
  assert.equal(lastRoomKey("c1"), "deskrpg.lastRoom.c1");
});

test("remembers the viewerUserId the list carried, and responses without it do not erase it", () => {
  const s1 = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office],
    preferRoomId: null,
    viewerUserId: "u1",
  });
  assert.equal(s1.viewerUserId, "u1");
  const s2 = reduceRoomState(s1, { type: "list", rooms: [office], preferRoomId: null });
  assert.equal(s2.viewerUserId, "u1", "옛 서버 응답이 신원을 지우면 안 된다");
});

test("the list preview keeps a cron result's kind and status so an empty body can be labelled", () => {
  let s = reduceRoomState(initialRoomState, {
    type: "list",
    rooms: [office, g1],
    preferRoomId: null,
  });
  const m: RoomMessage = {
    id: "m2",
    roomId: "o",
    senderKind: "npc",
    senderId: "n",
    senderName: "소피",
    content: "",
    createdAt: "2026-09-11T00:00:00Z",
    notice: { kind: "cron_result", jobId: "j", jobName: "n", npcName: "소피", status: "error" },
  };
  s = reduceRoomState(s, { type: "message", roomId: "o", message: m });
  assert.deepEqual(s.rooms.find((r) => r.id === "o")?.lastMessage?.notice, {
    kind: "cron_result",
    status: "error",
  });
});

const line = (id: string, over: Partial<RoomMessage> = {}): RoomMessage => ({
  id,
  roomId: "g1",
  senderKind: "npc",
  senderId: "npc-1",
  senderName: "소피",
  content: "소식",
  createdAt: "2026-09-26T10:00:00.000Z",
  ...over,
});

function listed(rooms: RoomSummary[]) {
  return reduceRoomState(initialRoomState, {
    type: "list",
    rooms,
    preferRoomId: "o",
    viewerUserId: "me",
  });
}

test("a line nobody is looking at adds one unread; a seen line, my own line or a repeat does not", () => {
  let s = listed([office, { ...g1, unread: 2 }]);
  s = reduceRoomState(s, { type: "message", roomId: "g1", message: line("m1"), seen: false });
  assert.equal(s.rooms.find((r) => r.id === "g1")?.unread, 3);
  s = reduceRoomState(s, { type: "message", roomId: "g1", message: line("m1"), seen: false });
  s = reduceRoomState(s, { type: "message", roomId: "g1", message: line("m2"), seen: true });
  s = reduceRoomState(s, {
    type: "message",
    roomId: "g1",
    message: line("m3", { senderKind: "user", senderId: "me" }),
    seen: false,
  });
  assert.equal(s.rooms.find((r) => r.id === "g1")?.unread, 3);
});

test("activity from a room not open updates its preview and unread count once per line", () => {
  let s = listed([office, g1]);
  s = reduceRoomState(s, { type: "activity", roomId: "g1", message: line("m1") });
  s = reduceRoomState(s, { type: "activity", roomId: "g1", message: line("m1") });
  const room = s.rooms.find((r) => r.id === "g1");
  assert.equal(room?.unread, 1);
  assert.equal(room?.lastMessage?.content, "소식");
  assert.equal(room?.lastMessageAt, "2026-09-26T10:00:00.000Z");
});

test("read clears the count and keeps the point; updates from others keep my read state", () => {
  let s = listed([office, { ...g1, unread: 4, readAt: "2026-09-26T09:00:00.000Z" }]);
  s = reduceRoomState(s, { type: "read", roomId: "g1", readAt: "2026-09-26T10:00:00.000Z" });
  assert.deepEqual(
    (({ unread, readAt }) => ({ unread, readAt }))(s.rooms.find((r) => r.id === "g1")!),
    { unread: 0, readAt: "2026-09-26T10:00:00.000Z" },
  );
  s = reduceRoomState(s, {
    type: "message",
    roomId: "g1",
    message: line("m9"),
    seen: false,
  });
  s = reduceRoomState(s, { type: "updated", room: { ...g1, name: "기획2" }, enter: false });
  const room = s.rooms.find((r) => r.id === "g1");
  assert.equal(room?.name, "기획2");
  assert.equal(room?.unread, 1);
  assert.equal(room?.readAt, "2026-09-26T10:00:00.000Z");
});

test("the unread total sums every room", () => {
  const s = listed([
    { ...office, unread: 2 },
    { ...g1, unread: 3 },
  ]);
  assert.equal(totalRoomUnread(s), 5);
});
