import assert from "node:assert/strict";
import test from "node:test";

import { setupThrowawaySqlite, seedUser, seedChannel } from "@/test-setup/npc-seed";
import type { RoomNotice } from "@/lib/chat-rooms-policy";

// A private notice (`audience`) — today `approval_blocked` — is read and sent only to that user. Pinned here on
// the real database: the room history, the room-list preview, and the socket broadcast. A null viewer (an NPC
// transcript) sees none.
setupThrowawaySqlite("room-audience-test");

function blockedFor(audience: string): RoomNotice {
  return {
    kind: "approval_blocked",
    audience,
    npcId: "npc-1",
    npcName: "Sophie",
    source: "cron",
    blockKind: "command",
    tool: "terminal",
    jobId: "job-1",
    command: "rm -r /tmp/probe",
    patternKey: "recursive delete",
  };
}

async function office() {
  const { ensureOfficeRoom, appendRoomMessage } = await import("./chat-rooms");
  const owner = await seedUser("aud-owner");
  const requester = await seedUser("aud-requester");
  const channel = await seedChannel(owner.id);
  const room = await ensureOfficeRoom(channel.id, owner.id);
  const say = (content: string, notice?: RoomNotice) =>
    appendRoomMessage({
      roomId: room.id,
      senderKind: "system",
      senderId: null,
      senderName: "Sophie",
      content,
      notice: notice ?? null,
    });
  return { owner, requester, channel, room, say };
}

test("room history leaves out another user's private notice", async () => {
  const { recentRoomMessages } = await import("./chat-rooms");
  const { owner, requester, room, say } = await office();
  await say("hello");
  await say("blocked", blockedFor(requester.id));
  await say("after");

  const mine = await recentRoomMessages(room.id, 10, requester.id);
  assert.deepEqual(
    mine.map((m) => m.content),
    ["hello", "blocked", "after"],
  );
  const theirs = await recentRoomMessages(room.id, 10, owner.id);
  assert.deepEqual(
    theirs.map((m) => m.content),
    ["hello", "after"],
  );
  const npc = await recentRoomMessages(room.id, 10, null);
  assert.deepEqual(
    npc.map((m) => m.content),
    ["hello", "after"],
  );
});

test("the room-list preview never shows another user's private notice", async () => {
  const { listRoomsForUser } = await import("./chat-rooms");
  const { owner, requester, channel, say } = await office();
  await say("visible to all");
  await say("blocked", blockedFor(requester.id));

  const forOwner = (await listRoomsForUser(channel.id, owner.id)).find((r) => r.kind === "office");
  assert.equal(forOwner?.lastMessage?.content, "visible to all");
  const forRequester = (await listRoomsForUser(channel.id, requester.id)).find(
    (r) => r.kind === "office",
  );
  assert.equal(forRequester?.lastMessage?.content, "blocked");
});

test("a LIKE wildcard in the viewer id does not reveal someone else's notice", async () => {
  const { recentRoomMessages } = await import("./chat-rooms");
  const { room, say } = await office();
  await say("blocked", blockedFor("userX1"));
  // `_` matches any character in SQL LIKE — the exact check after the query keeps it out.
  assert.deepEqual(await recentRoomMessages(room.id, 10, "user_1"), []);
  assert.equal((await recentRoomMessages(room.id, 10, "userX1")).length, 1);
});

test("broadcast sends a private notice to the audience's sockets only, other messages to the room", async () => {
  const { broadcastRoomMessage } = await import("@/server/room-broadcast");
  const sent: { to: string; event: string }[] = [];
  const io = { to: (to: string) => ({ emit: (event: string) => sent.push({ to, event }) }) };
  const base = {
    id: "m",
    roomId: "r1",
    senderKind: "system" as const,
    senderId: null,
    senderName: "",
    content: "",
    createdAt: new Date().toISOString(),
  };
  broadcastRoomMessage(io, "r1", { ...base, notice: blockedFor("u-9") });
  broadcastRoomMessage(io, "r1", { ...base, notice: null });
  assert.deepEqual(sent, [
    { to: "user:u-9", event: "room:message" },
    { to: "room-r1", event: "room:message" },
  ]);
});

test("room:message is emitted only through the audience-aware broadcast", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "../..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const src = readFileSync(path.join(root, rel), "utf8");
        if (
          /emit\(\s*"room:message"/.test(src) &&
          rel !== path.join("src", "server", "room-broadcast.ts")
        )
          offenders.push(rel);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
