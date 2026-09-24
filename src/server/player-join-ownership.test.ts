import { NextRequest } from "next/server";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { setupThrowawaySqlite, seedUser, seedChannel, authHeaders } from "../test-setup/npc-seed";
import { buildOfficeEnvironment } from "../game/three/office-environments";
setupThrowawaySqlite("player-join-ownership");

// player:join must not trust the characterId the client sends as-is —
// it must check in the DB that the character belongs to this user, and read name and appearance from the DB too.

const socketDeadlineMs = 10_000;
const JOIN_OUTCOMES = ["player:spawn", "channel:access-denied", "map:refresh", "join-error"];

type JoinOutcome = { name: string; payload: unknown };

const joinOutcome = (client: Socket, payload: unknown) =>
  new Promise<JoinOutcome>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Error("join timeout: " + JSON.stringify(payload)));
    }, socketDeadlineMs);
    const listener = (name: string, data: unknown) => {
      if (JOIN_OUTCOMES.includes(name)) {
        cleanup();
        resolve({ name, payload: data });
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      client.offAny(listener);
    };
    client.onAny(listener);
    client.emit("player:join", payload);
  });

async function signToken(userId: string) {
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");
  return new SignJWT({ userId, nickname: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
}

async function seedCharacter(userId: string, name: string, officeLookId: string) {
  const { db, characters, jsonForDb } = await import("../db");
  const [character] = await db
    .insert(characters)
    .values({ userId, name, appearance: jsonForDb({ officeLookId }) })
    .returning();
  return character;
}

async function startHarness() {
  const { db, channels, channelMembers, jsonForDb } = await import("../db");
  const { setupSocketHandlers } = await import("./socket-handlers");
  const owner = await seedUser("owner");
  const other = await seedUser("other");
  const channel = await seedChannel(owner.id);
  await db
    .update(channels)
    .set({ mapData: jsonForDb(buildOfficeEnvironment("agency")) })
    .where(eq(channels.id, channel.id));
  await db.insert(channelMembers).values({ channelId: channel.id, userId: other.id });

  const { GET } = await import("../app/api/channels/[id]/route");
  const bootstrap = await GET(
    new NextRequest(`http://localhost/api/channels/${channel.id}`, {
      headers: authHeaders(owner.id),
    }),
    { params: Promise.resolve({ id: channel.id }) },
  );
  assert.equal(bootstrap.status, 200);
  const mapRevision: string = (await bootstrap.json()).channel.mapRevision;

  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");

  const clients: Socket[] = [];
  const open = async (userId: string) => {
    const client = connect(`http://127.0.0.1:${address.port}`, {
      extraHeaders: { cookie: `token=${await signToken(userId)}` },
      transports: ["websocket"],
      forceNew: true,
    });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const deadline = Date.now() + socketDeadlineMs;
    while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
      assert.ok(Date.now() < deadline, "authenticated socket handlers must be installed");
      await new Promise((r) => setTimeout(r, 10));
    }
    return client;
  };
  const joinPayload = (characterId: string, extra: Record<string, unknown> = {}) => ({
    mapId: channel.id,
    mapRevision,
    characterId,
    characterName: "Client Supplied",
    appearance: { officeLookId: "office-do" },
    x: 496,
    y: 624,
    ...extra,
  });
  const close = async () => {
    clients.forEach((c) => c.close());
    await new Promise<void>((r) => io.close(() => r()));
    if (http.listening) await new Promise<void>((r) => http.close(() => r()));
  };
  return { io, owner, other, channel, open, joinPayload, close };
}

test("player:join as another user's character is denied without kicking the user's live session", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await startHarness();
  try {
    const ownCharacter = await seedCharacter(h.owner.id, "Owner Hero", "office-tae");
    const foreignCharacter = await seedCharacter(h.other.id, "Other Hero", "office-seo");

    const observer = await h.open(h.other.id);
    assert.equal(
      (await joinOutcome(observer, h.joinPayload(foreignCharacter.id))).name,
      "player:spawn",
    );
    // Count whether a rejection broadcast happened only after the first session's normal broadcast reached the observer.
    const firstJoined = new Promise((resolve) => observer.once("player:joined", resolve));
    const first = await h.open(h.owner.id);
    assert.equal((await joinOutcome(first, h.joinPayload(ownCharacter.id))).name, "player:spawn");
    await firstJoined;

    let kicked = false;
    first.on("session:kicked", () => {
      kicked = true;
    });
    const observerSawJoin: unknown[] = [];
    observer.on("player:joined", (p) => observerSawJoin.push(p));
    const second = await h.open(h.owner.id);
    const denied = await joinOutcome(
      second,
      h.joinPayload(foreignCharacter.id, { characterName: "Other Hero" }),
    );
    assert.equal(denied.name, "channel:access-denied");
    assert.deepEqual(denied.payload, {
      channelId: h.channel.id,
      action: "player:join",
      reason: "forbidden",
      errorCode: "character_not_yours",
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      h.io.sockets.adapter.rooms.get(h.channel.id)?.has(second.id!) ?? false,
      false,
      "denied socket must not enter the channel room",
    );
    assert.deepEqual(observerSawJoin, [], "denied join must not be broadcast");
    assert.equal(kicked, false, "denied join must not kick the user's live session");
    assert.equal(first.connected, true);
  } finally {
    await h.close();
  }
});

test("player:join with the user's own character succeeds and broadcasts the DB name/appearance", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await startHarness();
  try {
    const ownCharacter = await seedCharacter(h.owner.id, "Owner Hero", "office-tae");
    const observerCharacter = await seedCharacter(h.other.id, "Other Hero", "office-seo");
    const observer = await h.open(h.other.id);
    assert.equal(
      (await joinOutcome(observer, h.joinPayload(observerCharacter.id))).name,
      "player:spawn",
    );

    const joinedByOthers = new Promise<Record<string, unknown>>((resolve) =>
      observer.once("player:joined", resolve),
    );
    const client = await h.open(h.owner.id);
    assert.equal(
      (
        await joinOutcome(
          client,
          h.joinPayload(ownCharacter.id, {
            characterName: "Impostor Name",
            appearance: { officeLookId: "office-min" },
          }),
        )
      ).name,
      "player:spawn",
    );
    const broadcast = await joinedByOthers;
    assert.equal(broadcast.characterId, ownCharacter.id);
    assert.equal(broadcast.characterName, "Owner Hero", "name must come from the DB row");
    assert.equal(
      (broadcast.appearance as { officeLookId?: string }).officeLookId,
      "office-tae",
      "appearance must come from the DB row",
    );
  } finally {
    await h.close();
  }
});
