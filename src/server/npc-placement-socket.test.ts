import { NextRequest } from "next/server";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { setupThrowawaySqlite, seedChannelWithProfiles, authHeaders } from "../test-setup/npc-seed";
import { buildOfficeEnvironment } from "../game/three/office-environments";
setupThrowawaySqlite("npc-placement-socket");

// A hire made without a socket (a REST route, another browser) reaches a map already open in the
// channel: every newly seated employee arrives as npc:updated { npc } with its seat.

async function signToken(userId: string) {
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");
  return new SignJWT({ userId, nickname: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
}

test("hiring into a channel shows the new employees on a map that is already open", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, characters, jsonForDb } = await import("../db");
  const { setupSocketHandlers } = await import("./socket-handlers");
  const { hireGatewayProfilesIntoChannel } = await import("../lib/npc-roster");
  const { channelId, userId, gatewayId } = await seedChannelWithProfiles({
    profiles: 2,
    mapData: buildOfficeEnvironment("executive"),
  });
  const [character] = await db
    .insert(characters)
    .values({ userId, name: "Viewer", appearance: jsonForDb({ officeLookId: "office-tae" }) })
    .returning();
  const { GET } = await import("../app/api/channels/[id]/route");
  const bootstrap = await GET(
    new NextRequest(`http://localhost/api/channels/${channelId}`, { headers: authHeaders(userId) }),
    { params: Promise.resolve({ id: channelId }) },
  );
  const mapRevision: string = (await bootstrap.json()).channel.mapRevision;

  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const client: Socket = connect(`http://127.0.0.1:${address.port}`, {
    extraHeaders: { cookie: `token=${await signToken(userId)}` },
    transports: ["websocket"],
    forceNew: true,
  });
  try {
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const deadline = Date.now() + 10_000;
    while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
      assert.ok(Date.now() < deadline, "authenticated socket handlers must be installed");
      await new Promise((r) => setTimeout(r, 10));
    }
    const spawned = new Promise((resolve) => client.once("player:spawn", resolve));
    client.emit("player:join", {
      mapId: channelId,
      mapRevision,
      characterId: character.id,
      x: 496,
      y: 624,
    });
    await spawned;

    const updates: Array<{ npc: { id: string; positionX: number | null; active: boolean } }> = [];
    const twoArrived = new Promise<void>((resolve) =>
      client.on("npc:updated", (payload) => {
        updates.push(payload);
        if (updates.length === 2) resolve();
      }),
    );
    await hireGatewayProfilesIntoChannel(channelId, gatewayId);
    await Promise.race([
      twoArrived,
      new Promise((_, reject) => setTimeout(() => reject(Error("no npc:updated")), 5_000)),
    ]);

    assert.equal(new Set(updates.map((u) => u.npc.id)).size, 2);
    assert.ok(updates.every((u) => u.npc.active && u.npc.positionX !== null));
  } finally {
    client.close();
    await new Promise<void>((r) => io.close(() => r()));
    if (http.listening) await new Promise<void>((r) => http.close(() => r()));
  }
});
