import assert from "node:assert/strict";
import test from "node:test";
import { setupThrowawaySqlite, seedChannelWithProfiles, seedUser } from "@/test-setup/npc-seed";

setupThrowawaySqlite("room-socket-test");

import * as rooms from "@/lib/chat-rooms";
import { registerRoomHandlers } from "./room-socket";

type Emitted = [string, unknown];

function fakeSocket(emitted: Emitted[], id = "s1", cookie?: string) {
  const handlers = new Map<string, (p: unknown) => unknown>();
  const joined = new Set<string>();
  return {
    id,
    joined,
    handshake: { headers: { cookie } },
    data: {} as Record<string, unknown>,
    on(e: string, h: (p: unknown) => unknown) {
      handlers.set(e, h);
    },
    emit(e: string, p: unknown) {
      emitted.push([e, p]);
    },
    join(r: string) {
      joined.add(r);
    },
    leave(r: string) {
      joined.delete(r);
    },
    async trigger(e: string, p: unknown) {
      const h = handlers.get(e);
      assert.ok(h, e);
      await h(p);
    },
  };
}

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

type Seeded = Awaited<ReturnType<typeof seedChannelWithProfiles>>;

function setup(
  opts: {
    allowed?: boolean;
    player?: boolean;
    userId?: string;
    cookie?: string;
    createRoom?: typeof rooms.createRoom;
  } = {},
) {
  const emitted: Emitted[] = [];
  const socket = fakeSocket(emitted, "s1", opts.cookie);
  const io = fakeIo(emitted);
  const players = new Map();
  const woke: { roomId: string; text: string }[] = [];
  const callerContexts: unknown[] = [];
  const callerLocales: unknown[] = [];
  const callerUserIds: unknown[] = [];
  return {
    emitted,
    socket,
    players,
    woke,
    callerContexts,
    callerLocales,
    callerUserIds,
    async register(seeded: Seeded) {
      // Default identity is the channel owner. Given `userId`, registers as that person — for permission branches.
      const actingUserId = opts.userId ?? seeded.userId;
      if (opts.player !== false) {
        players.set("s1", {
          id: "s1",
          userId: actingUserId,
          characterId: "c",
          characterName: "단테",
          appearance: null,
          mapId: seeded.channelId,
          x: 0,
          y: 0,
          direction: "down",
          animation: "idle",
        });
      }
      registerRoomHandlers({
        io: io as never,
        socket: socket as never,
        deps: {
          user: { userId: actingUserId, nickname: "dante" },
          players,
          lastChatTime: new Map(),
          cooldownMs: 2000,
          getParticipationAccess: async () => ({ access: { allowed: opts.allowed ?? true } }),
          rooms: opts.createRoom ? { ...rooms, createRoom: opts.createRoom } : rooms,
          getRuntime: async (_io, room) =>
            ({
              handleHumanMessage: async (
                _s: string,
                text: string,
                _socketId: string,
                _sourceMessageId: string,
                callerContext: unknown,
                callerLocale: unknown,
                callerUserId: unknown,
              ) => {
                woke.push({ roomId: room.id, text });
                callerContexts.push(callerContext);
                callerLocales.push(callerLocale);
                callerUserIds.push(callerUserId);
              },
            }) as never,
          invalidateRuntime: () => {},
        },
      });
    },
  };
}

const ev = (emitted: Emitted[], name: string) =>
  emitted.filter(([e]) => e.startsWith(name)).map(([, p]) => p);

test("room:list returns my rooms including office", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const [res] = ev(t.emitted, "room:list-response") as {
    rooms: { kind: string }[];
    viewerUserId: string;
  }[];
  assert.deepEqual(
    res.rooms.map((r) => r.kind),
    ["office"],
  );
  // This value is the only way the client can tell "rooms I created".
  assert.equal(res.viewerUserId, seeded.userId);
});

test("room:send gives not_open for an unopened room, empty for an empty message, cooldown when cooling down — all as room:error", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  await t.socket.trigger("room:send", { roomId: office.id, message: "hi" });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: office.id, code: "not_open" });
  await t.socket.trigger("room:open", { roomId: office.id });
  assert.ok(t.socket.joined.has(`room-${office.id}`));
  await t.socket.trigger("room:send", { roomId: office.id, message: "   " });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: office.id, code: "empty" });
  await t.socket.trigger("room:send", { roomId: office.id, message: "hi" });
  await t.socket.trigger("room:send", { roomId: office.id, message: "again" });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: office.id, code: "cooldown" });
});

test("room:send success is store + room broadcast + runtime call; forbidden without channel permission", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  await t.socket.trigger("room:open", { roomId: office.id });
  await t.socket.trigger("room:send", { roomId: office.id, message: "@[소피] 안녕" });
  const [msg] = ev(t.emitted, `room:message@room-${office.id}`) as {
    message: { content: string; senderName: string };
  }[];
  assert.equal(msg.message.content, "@[소피] 안녕");
  assert.equal(msg.message.senderName, "단테");
  assert.deepEqual(t.woke, [{ roomId: office.id, text: "@[소피] 안녕" }]);
  assert.equal((await rooms.recentRoomMessages(office.id, 5, null)).length, 1);
  const t2 = setup({ allowed: false });
  await t2.register(seeded);
  await t2.socket.trigger("room:open", { roomId: office.id });
  assert.deepEqual(ev(t2.emitted, "room:error").at(-1), { roomId: office.id, code: "forbidden" });
});

test("room:send passes the caller's name and bio planted by player:join to the runtime", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  t.socket.data.userContext = { name: "곽지호", bio: "단테랩스 대표" };
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  await t.socket.trigger("room:open", { roomId: office.id });
  await t.socket.trigger("room:send", { roomId: office.id, message: "@[소피] 안녕" });
  assert.deepEqual(t.callerContexts, [{ name: "곽지호", bio: "단테랩스 대표" }]);
});

test("room:send passes the sender's language cookie to the runtime, and null without one", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  const withCookie = setup({ cookie: "other=1; deskrpg-locale=ja" });
  await withCookie.register(seeded);
  await withCookie.socket.trigger("room:open", { roomId: office.id });
  await withCookie.socket.trigger("room:send", { roomId: office.id, message: "@[소피] hi" });
  assert.deepEqual(withCookie.callerLocales, ["ja"]);

  const without = setup();
  await without.register(seeded);
  await without.socket.trigger("room:open", { roomId: office.id });
  await without.socket.trigger("room:send", { roomId: office.id, message: "@[소피] hi" });
  assert.deepEqual(without.callerLocales, [null]);
  // The sender's user id rides along — a tool approval the NPC asks for during the turn goes to them.
  assert.deepEqual(without.callerUserIds, [seeded.userId]);
});

test("room:create passes the creator's language so an unnamed room gets a name in it", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const seen: unknown[] = [];
  const t = setup({
    cookie: "deskrpg-locale=zh",
    createRoom: async (args) => {
      seen.push(args.locale);
      return rooms.createRoom(args);
    },
  });
  await t.register(seeded);
  await t.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "",
    npcIds: [seeded.npcIds[0]],
    userIds: [],
  });
  assert.deepEqual(seen, ["zh"]);
});

test("a socket not in players gets not_joined", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup({ player: false });
  await t.register(seeded);
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  await t.socket.trigger("room:open", { roomId: office.id });
  await t.socket.trigger("room:send", { roomId: office.id, message: "hi" });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: office.id, code: "not_joined" });
});

test("room:create adds the creator as a member and emits room:created, and room:send in a group room wakes the runtime", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 2 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "기획",
    npcIds: [seeded.npcIds[0]],
    userIds: [],
  });
  const [created] = ev(t.emitted, "room:created") as {
    room: { id: string; kind: string; members: { kind: string }[] };
  }[];
  assert.equal(created.room.kind, "group");
  assert.deepEqual(created.room.members.map((m) => m.kind).sort(), ["npc", "user"]);
  await t.socket.trigger("room:open", { roomId: created.room.id });
  await t.socket.trigger("room:send", { roomId: created.room.id, message: "다들 어때" });
  assert.equal(t.woke.at(-1)?.roomId, created.room.id);
});

test("room:created's requestId comes back only to the requesting socket — invitees don't get it", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const invitee = await seedUser("room-invitee");
  const t = setup();
  await t.register(seeded);
  // The invitee's socket. `socketIdsForUsers` picks the target sockets from this list.
  t.players.set("s2", {
    id: "s2",
    userId: invitee.id,
    characterId: "c2",
    characterName: "손님",
    appearance: null,
    mapId: seeded.channelId,
    x: 0,
    y: 0,
    direction: "down",
    animation: "idle",
  });

  await t.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "기획",
    npcIds: [seeded.npcIds[0]],
    userIds: [invitee.id],
    requestId: "r1",
  });

  // `ev` filters by prefix and catches up to `room:created@s2` — here the two branches must be told apart.
  const mine = t.emitted.filter(([e]) => e === "room:created").map(([, p]) => p);
  const theirs = t.emitted.filter(([e]) => e === "room:created@s2").map(([, p]) => p);
  assert.deepEqual(
    mine.map((p) => (p as { requestId?: string }).requestId),
    ["r1"],
  );
  assert.equal(theirs.length, 1, "초대된 사람도 방이 생긴 것을 알아야 한다");
  assert.equal(
    (theirs[0] as { requestId?: string }).requestId,
    undefined,
    "남의 표를 받으면 그 사람 화면이 남의 방으로 끌려 들어간다",
  );
});

test("an unusable requestId is ignored — creates just the room without a ticket", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "기획",
    npcIds: [seeded.npcIds[0]],
    userIds: [],
    requestId: "x".repeat(65),
  });
  const [created] = t.emitted.filter(([e]) => e === "room:created").map(([, p]) => p);
  assert.equal((created as { requestId?: string }).requestId, undefined);
  assert.ok((created as { room: { id: string } }).room.id, "방은 정상으로 만들어진다");
});

test("room:delete is creator-only, office is invalid", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  await t.socket.trigger("room:delete", { roomId: office.id });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: office.id, code: "invalid" });
});

test("room:rename is creator-only — even a member can't rename someone else's room", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const owner = setup();
  await owner.register(seeded);
  await owner.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "기획",
    npcIds: [seeded.npcIds[0]],
    userIds: [],
  });
  const [created] = ev(owner.emitted, "room:created") as { room: { id: string } }[];

  // A second person who is a user member of the same room but not its creator.
  const other = await seedUser("room-member");
  await rooms.addMembers(created.room.id, seeded.userId, [], [other.id]);
  const guest = setup({ userId: other.id });
  await guest.register(seeded);
  await guest.socket.trigger("room:rename", { roomId: created.room.id, name: "가로채기" });
  assert.deepEqual(ev(guest.emitted, "room:error").at(-1), {
    roomId: created.room.id,
    code: "forbidden",
  });
  assert.equal((await rooms.getRoom(created.room.id))?.name, "기획", "이름이 바뀌면 안 된다");

  await owner.socket.trigger("room:rename", { roomId: created.room.id, name: "기획 2팀" });
  const [updated] = ev(owner.emitted, `room:updated@room-${created.room.id}`) as {
    room: { name: string };
  }[];
  assert.equal(updated.room.name, "기획 2팀");
  assert.equal((await rooms.getRoom(created.room.id))?.name, "기획 2팀");
});

test("room:open returns only the latest 60 lines — older lines are cut off", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  const office = await rooms.ensureOfficeRoom(seeded.channelId, seeded.userId);
  // No sleep. Message ids are UUIDv7, so even when pushed in within the same millisecond
  // the `(created_at, id)` ordering returns them in insertion order.
  for (let i = 0; i <= 60; i += 1) {
    await rooms.appendRoomMessage({
      roomId: office.id,
      senderKind: "user",
      senderId: seeded.userId,
      senderName: "단테",
      content: `m${i}`,
    });
  }
  await t.socket.trigger("room:open", { roomId: office.id });
  const [history] = ev(t.emitted, "room:history") as { messages: { content: string }[] }[];
  assert.equal(history.messages.length, 60);
  assert.equal(history.messages[0].content, "m1", "가장 오래된 m0 가 잘린다");
  assert.equal(history.messages.at(-1)?.content, "m60", "오래된 순으로 온다");
});

test("office list remains available to an authorized visitor before asynchronous player join completes", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const visitor = await seedUser("room-visitor");
  const t = setup({ userId: visitor.id, player: false });
  await t.register(seeded);
  assert.equal(t.players.size, 0, "room listing authorization does not depend on map placement");
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const [res] = ev(t.emitted, "room:list-response") as {
    rooms: { kind: string; createdBy: string }[];
  }[];
  const officeSummary = res.rooms.find((r) => r.kind === "office");
  assert.ok(officeSummary, "office 방이 목록에 있어야 한다");
  assert.equal(officeSummary.createdBy, seeded.userId);
  assert.notEqual(officeSummary.createdBy, visitor.id);
});

test("without a channel, room:list creates no rooms and returns not_found", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: "00000000-0000-0000-0000-000000000000" });
  assert.deepEqual(ev(t.emitted, "room:error").at(-1), { roomId: null, code: "not_found" });
  assert.deepEqual(ev(t.emitted, "room:list-response"), []);
});

// ── The office room always listens ───────────────────────────────────────────────────────────────
//
// Automation notices (card review, blocked, done, cron failure) are broadcast to the office room. Previously
// the broadcast went only to sockets that did `room:open`, and moving rooms left via `room:close` — so users
// viewing a DM or another group room, or with the panel collapsed, didn't get notices **until they came back
// to that room**. The reporting feature meant to "notify users who only watch the map" missed exactly those users.

const officeRoomId = (emitted: Emitted[]) =>
  (ev(emitted, "room:list-response") as { rooms: { id: string; kind: string }[] }[])
    .at(-1)!
    .rooms.find((room) => room.kind === "office")!.id;

test("room:list alone listens to office room broadcasts — even without opening the room", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const officeId = officeRoomId(t.emitted);
  assert.ok(
    [...t.socket.joined].some((room) => room.includes(officeId)),
    `사무실 방의 소켓 룸에 들어가 있어야 한다: ${[...t.socket.joined]}`,
  );
});

test("room:list also sends the office room's recent lines — notices piled up before connecting show on the badge", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const officeId = officeRoomId(t.emitted);
  await rooms.appendRoomMessage({
    roomId: officeId,
    senderKind: "npc",
    senderId: "npc-1",
    senderName: "소피",
    content: "접속 전에 온 알림",
  });
  t.emitted.length = 0;
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const histories = ev(t.emitted, "room:history") as {
    roomId: string;
    messages: { content: string }[];
  }[];
  const office = histories.find((history) => history.roomId === officeId);
  assert.ok(office, "사무실 방의 room:history 가 와야 한다");
  assert.ok(office.messages.some((message) => message.content === "접속 전에 온 알림"));
});

test("moving to another room (room:close) keeps listening to the office room — but can't send to an unopened room", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  const officeId = officeRoomId(t.emitted);
  await t.socket.trigger("room:open", { roomId: officeId });
  await t.socket.trigger("room:close", { roomId: officeId });
  assert.ok(
    [...t.socket.joined].some((room) => room.includes(officeId)),
    "사무실 방을 닫아도 방송은 계속 받아야 한다",
  );
  // Listening and sending are different — sending to a closed room is still not_open.
  t.emitted.length = 0;
  await t.socket.trigger("room:send", { roomId: officeId, message: "닫힌 방에 보내기" });
  assert.deepEqual(
    (ev(t.emitted, "room:error") as { code: string }[]).map((error) => error.code),
    ["not_open"],
  );
});

test("group rooms are as before — closing stops broadcasts", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup();
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  await t.socket.trigger("room:create", {
    channelId: seeded.channelId,
    name: "기획",
    npcIds: [seeded.npcIds[0]],
    userIds: [],
  });
  const group = (ev(t.emitted, "room:created") as { room: { id: string } }[]).at(-1)!.room;
  await t.socket.trigger("room:open", { roomId: group.id });
  assert.ok([...t.socket.joined].some((room) => room.includes(group.id)));
  await t.socket.trigger("room:close", { roomId: group.id });
  assert.equal(
    [...t.socket.joined].some((room) => room.includes(group.id)),
    false,
    "그룹 방은 닫으면 떠난다",
  );
});

test("without channel permission, a socket can't join the office room", async () => {
  const seeded = await seedChannelWithProfiles({ placedActive: 1 });
  const t = setup({ allowed: false });
  await t.register(seeded);
  await t.socket.trigger("room:list", { channelId: seeded.channelId });
  assert.equal(t.socket.joined.size, 0, "권한 없는 소켓은 어떤 방에도 들어가지 않는다");
  assert.equal(ev(t.emitted, "room:history").length, 0, "히스토리도 새지 않는다");
});
