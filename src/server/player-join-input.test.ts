import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { SignJWT } from "jose";
import { setupThrowawaySqlite, seedUser } from "../test-setup/npc-seed";
setupThrowawaySqlite("player-join-input");

// A malformed player:join payload gets an explicit denial before any query runs. On PostgreSQL a
// non-uuid id would make the channel lookup throw, and the join would hang with no answer.

async function signToken(userId: string) {
  const { DEV_JWT_SECRET } = await import("../lib/dev-constants");
  return new SignJWT({ userId, nickname: "test" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
}

async function startHarness() {
  const { setupSocketHandlers } = await import("./socket-handlers");
  const user = await seedUser("joiner");
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  setupSocketHandlers(io);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const client = connect(`http://127.0.0.1:${address.port}`, {
    extraHeaders: { cookie: `token=${await signToken(user.id)}` },
    transports: ["websocket"],
    forceNew: true,
  });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  const deadline = Date.now() + 10_000;
  while (!io.sockets.sockets.get(client.id!)?.listenerCount("player:join")) {
    assert.ok(Date.now() < deadline, "authenticated socket handlers must be installed");
    await new Promise((r) => setTimeout(r, 10));
  }
  const close = async () => {
    client.close();
    await new Promise<void>((r) => io.close(() => r()));
    if (http.listening) await new Promise<void>((r) => http.close(() => r()));
  };
  return { client, close };
}

const denial = (client: Socket, ...args: unknown[]) =>
  new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("no answer to player:join")), 5_000);
    client.once("channel:access-denied", (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
    client.emit("player:join", ...args);
  });

for (const [name, args, channelId] of [
  ["a null payload", [null], null],
  ["no payload", [], null],
  ["a non-uuid mapId", [{ mapId: "not-a-uuid", x: 0, y: 0 }], "not-a-uuid"],
  ["a numeric mapId", [{ mapId: 42, x: 0, y: 0 }], null],
] as const) {
  test(`player:join with ${name} is denied instead of left unanswered`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = await startHarness();
    try {
      assert.deepEqual(await denial(h.client, ...args), {
        channelId,
        action: "player:join",
        reason: "forbidden",
        errorCode: "invalid_request_body",
      });
    } finally {
      await h.close();
    }
  });
}
