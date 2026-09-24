/**
 * The "me" in `player:join` is decided by the server (spec 2026-09-18, Task 5).
 *
 * The `characterId` the client sends is not trusted — joining with someone else's character id is rejected,
 * and if omitted the server fills it via `getMyCharacter(userId)`. With no character at all, joining is refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { setupThrowawaySqlite, seedUser, seedChannel } from "../test-setup/npc-seed";
import { buildOfficeEnvironment } from "../game/three/office-environments";
import { mapContentRevision } from "../lib/channel-map-revision";
setupThrowawaySqlite("player-join-character");

const socketDeadlineMs = 10_000;
const event = <T>(client: Socket, name: string) =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(name, listener);
      reject(Error("Timed out: " + name));
    }, socketDeadlineMs);
    const listener = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };
    client.once(name, listener);
  });

/** Waits for one terminal event of join — whether success (player:spawn) or rejection. */
const joinOutcome = (client: Socket, payload: unknown) =>
  new Promise<{ name: string; data: unknown }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("join timeout: " + JSON.stringify(payload)));
    }, socketDeadlineMs);
    const listener = (name: string, data: unknown) => {
      if (["player:spawn", "channel:access-denied", "map:refresh", "join-error"].includes(name)) {
        cleanup();
        resolve({ name, data });
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      client.offAny(listener);
    };
    client.onAny(listener);
    client.emit("player:join", payload);
  });

test("player:join does not trust the client's characterId; the server decides my character", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, channels, characters, channelMembers, jsonForDb } = await import("../db");
  const { setupSocketHandlers } = await import("./socket-handlers");
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");

  const userA = await seedUser("alice");
  const userB = await seedUser("bob");
  const userC = await seedUser("nochar");
  const channel = await seedChannel(userA.id);
  const mapData = buildOfficeEnvironment("agency");
  await db
    .update(channels)
    .set({ mapData: jsonForDb(mapData) })
    .where(eq(channels.id, channel.id));
  for (const user of [userA, userB, userC]) {
    await db
      .insert(channelMembers)
      .values({ channelId: channel.id, userId: user.id })
      .onConflictDoNothing();
  }
  const [a1] = await db
    .insert(characters)
    .values({ userId: userA.id, name: "Alice", appearance: jsonForDb({ bodyType: "female" }) })
    .returning();
  const [b1] = await db
    .insert(characters)
    .values({ userId: userB.id, name: "Bob", appearance: jsonForDb({}) })
    .returning();

  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");

  const secret = new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET);
  const tokenFor = (userId: string) =>
    new SignJWT({ userId, nickname: userId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(secret);
  const clients: Socket[] = [];
  const open = async (userId: string) => {
    const client = connect(`http://127.0.0.1:${address.port}`, {
      extraHeaders: { cookie: `token=${await tokenFor(userId)}` },
      transports: ["websocket"],
      forceNew: true,
    });
    clients.push(client);
    await event<void>(client, "connect");
    const deadline = Date.now() + socketDeadlineMs;
    while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
      assert.ok(Date.now() < deadline, "authenticated socket handlers must be installed");
      await new Promise((r) => setTimeout(r, 10));
    }
    return client;
  };
  const base = { mapId: channel.id, mapRevision: mapContentRevision(mapData), x: 496, y: 624 };

  try {
    // 1) Joining with someone else's characterId is rejected — not put in the room.
    const intruder = await open(userA.id);
    const denied = await joinOutcome(intruder, {
      ...base,
      characterId: b1.id,
      characterName: "Bob",
      appearance: {},
    });
    assert.equal(denied.name, "channel:access-denied");
    assert.deepEqual(denied.data, {
      channelId: channel.id,
      action: "player:join",
      reason: "forbidden",
      errorCode: "character_not_yours",
    });
    assert.equal(io.sockets.adapter.rooms.get(channel.id)?.has(intruder.id!) ?? false, false);
    intruder.close();

    // 2) Joining without a characterId, the server fills in my character. Name and appearance are server values too.
    const observer = await open(userB.id);
    assert.equal((await joinOutcome(observer, { ...base })).name, "player:spawn");
    const joined = event<{ characterId: string; characterName: string; appearance: unknown }>(
      observer,
      "player:joined",
    );
    const alice = await open(userA.id);
    assert.equal(
      (await joinOutcome(alice, { ...base, characterName: "Mallory", appearance: { x: 1 } })).name,
      "player:spawn",
    );
    const seen = await joined;
    assert.equal(seen.characterId, a1.id);
    assert.equal(seen.characterName, "Alice");
    // The old appearance (`{ bodyType }`) is also folded into the canonical shape before broadcast (normalizeOfficeAppearance).
    assert.deepEqual(seen.appearance, { officeLookId: "office-nari", bodyType: "female" });

    // 3) With no character at all, joining is refused.
    const nobody = await open(userC.id);
    const missing = await joinOutcome(nobody, { ...base });
    assert.equal(missing.name, "channel:access-denied");
    assert.equal((missing.data as { errorCode: string }).errorCode, "character_missing");
    assert.equal(io.sockets.adapter.rooms.get(channel.id)?.has(nobody.id!) ?? false, false);
  } finally {
    for (const client of clients) client.close();
    io.close();
    http.close();
  }
});
