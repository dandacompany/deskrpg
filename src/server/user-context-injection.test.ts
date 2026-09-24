import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import {
  setupThrowawaySqlite,
  seedUser,
  seedChannel,
  seedGateway,
  seedHermesProfile,
  seedNpc,
} from "../test-setup/npc-seed";
import oldMap from "../lib/fixtures/official-agency-v2.json";
import { deriveChannelMotionLayout } from "./channel-motion-layout";
import { formatReportFormat } from "../lib/report-format";
setupThrowawaySqlite("user-context-injection");

// Pins, over a real socket, the single "[대화 상대]" line at the head of the body sent to an employee (spec 2026-09-18).
// The value comes from socket.data.userContext, which player:join plants from my character in the DB — this test
// goes through that whole wiring (join → DM/meeting → adapter prompt). Free chat is pinned split between
// room-socket.test (socket→runtime) and open-chat-runtime.test (runtime→prompt).

const deadlineMs = 10_000;
// The report-format rule follows the conversation-partner line — both are at the head of the message; SOUL is untouched.
const EXPECTED_HEADER =
  "[대화 상대] 이름: 곽지호 · 소개: 단테랩스 대표. 존댓말 선호.\n\n" +
  `${formatReportFormat()}\n\n`;

const event = <T>(client: Socket, name: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Timed out: " + name)), deadlineMs);
    client.once(name, (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });

test("the body sent to the gateway from DM/meeting starts with [대화 상대]·[보고 형식]", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, channels, characters, channelMembers, jsonForDb } = await import("../db");
  const { setupSocketHandlers, adapterRegistry } = await import("./socket-handlers");
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");

  const user = await seedUser();
  await db.insert(characters).values({
    userId: user.id,
    name: "곽지호",
    bio: "단테랩스 대표.\n존댓말 선호.",
    appearance: "{}",
  });
  const channel = await seedChannel(user.id);
  const gateway = await seedGateway(user.id);
  const profile = await seedHermesProfile(gateway.id);
  const npc = await seedNpc({
    channelId: channel.id,
    hermesProfileId: profile.id,
    adapterType: "user-context-capture",
    positionX: 2,
    positionY: 2,
  });
  await db
    .update(channels)
    .set({ mapData: jsonForDb(oldMap) })
    .where(eq(channels.id, channel.id));

  const prompts: Array<{ sessionKey: string; prompt: string }> = [];
  let promptArrived: (() => void) | null = null;
  adapterRegistry.register({
    type: "user-context-capture",
    testConnection: async () => ({ status: "ok" }),
    execute: async (options) => {
      prompts.push({ sessionKey: options.sessionKey, prompt: options.prompt });
      promptArrived?.();
      return { response: "네", session: { sessionRef: options.sessionKey } };
    },
  });
  const nextPrompt = () =>
    new Promise<{ sessionKey: string; prompt: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("no adapter prompt")), deadlineMs);
      promptArrived = () => {
        clearTimeout(timeout);
        promptArrived = null;
        resolve(prompts.at(-1)!);
      };
    });

  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const token = await new SignJWT({ userId: user.id, nickname: "dante" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
  const client = connect(`http://127.0.0.1:${address.port}`, {
    extraHeaders: { cookie: `token=${token}` },
    transports: ["websocket"],
    forceNew: true,
  });
  try {
    await event<void>(client, "connect");
    const installed = Date.now() + deadlineMs;
    while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
      assert.ok(Date.now() < installed, "authenticated socket handlers must be installed");
      await new Promise((r) => setTimeout(r, 10));
    }

    // Enter at the meeting space entrance — a spot that meeting:join accepts.
    const entry = deriveChannelMotionLayout({ mapData: oldMap }, [])!.meetingSpace!.entry;
    await db.insert(channelMembers).values({
      channelId: channel.id,
      userId: user.id,
      lastX: entry.x * 32,
      lastY: entry.y * 32,
    });
    const spawned = event<unknown>(client, "player:spawn");
    client.emit("player:join", { mapId: channel.id, x: entry.x * 32, y: entry.y * 32 });
    await spawned;

    // Meeting: the speaker's name and bio are prepended before "speaker: content".
    const admitted = event<unknown>(client, "meeting:state");
    client.emit("meeting:join", { channelId: channel.id });
    await admitted;
    const meetingPrompt = nextPrompt();
    const meetingSentAt = Date.now();
    client.emit("meeting:chat", { channelId: channel.id, message: "회의 시작할게요" });
    const meeting = await meetingPrompt;
    assert.match(meeting.sessionKey, /-meeting-/);
    assert.equal(meeting.prompt, `${EXPECTED_HEADER}곽지호: 회의 시작할게요`);

    // DM: the socket chat cooldown (2s) is shared with the meeting, so send after it.
    await new Promise((r) => setTimeout(r, Math.max(0, meetingSentAt + 2_100 - Date.now())));
    const dmPrompt = nextPrompt();
    client.emit("npc:chat", { npcId: npc.id, message: "안녕하세요", sourceMessageId: "dm-1" });
    const dm = await dmPrompt;
    assert.match(dm.sessionKey, /-dm-/);
    assert.equal(dm.prompt, `${EXPECTED_HEADER}안녕하세요`);
  } finally {
    client.disconnect();
    io.close();
    http.close();
  }
});
