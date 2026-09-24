import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import { eq, sql } from "drizzle-orm";
import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";
setupThrowawaySqlite("chat-response-dm-socket");
import { db, characters, npcs } from "@/db";
import { DEV_JWT_SECRET } from "@/lib/dev-constants";
import type { ChatResponse } from "@/lib/chat-response";
import { adapterRegistry, setupSocketHandlers } from "./socket-handlers";

test("DM socket sends correlated live state, restores history without duplicate IDs, and reports failed persistence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seed = await seedChannelWithProfiles({ placedActive: 1, displayName: "Sophie" });
  const [character] = await db
    .insert(characters)
    .values({ userId: seed.userId, name: "Dante", appearance: "{}" })
    .returning();
  const npcId = seed.npcIds[0];
  await db.update(npcs).set({ adapterType: "ux-test" }).where(eq(npcs.id, npcId));
  let release!: () => void;
  let notify!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    notify = resolve;
  });
  adapterRegistry.register({
    type: "ux-test",
    testConnection: async () => ({ status: "ok" }),
    execute: async (options) => {
      options.onDelta?.("hello");
      notify();
      await gate;
      return { response: "hello world", session: { sessionRef: options.sessionKey } };
    },
  });
  const events: [string, unknown][] = [];
  const payloads = <T>(event: string): T[] =>
    events.filter(([name]) => name === event).map(([, p]) => p as T);
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const token = await new SignJWT({ userId: seed.userId, nickname: "Dante" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
  const middleware: Array<(packet: [string, unknown], next: () => void) => void> = [];
  const socket = {
    data: {} as Record<string, unknown>,
    use: (handler: (packet: [string, unknown], next: () => void) => void) => {
      middleware.push(handler);
    },
    id: "dm-ux-test-socket",
    handshake: { headers: { cookie: `token=${token}` } },
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, async (payload) => {
        let allowed = true;
        for (const guard of middleware) {
          let continued = false;
          guard([event, payload], () => {
            continued = true;
          });
          if (!continued) {
            allowed = false;
            break;
          }
        }
        if (allowed) await handler(payload);
      });
    },
    emit: (event: string, payload: unknown) => {
      events.push([event, payload]);
    },
    join: () => {},
    leave: () => {},
    disconnect: () => {},
  };
  let connect!: (socket: unknown) => Promise<void>;
  const io = {
    on: (_event: string, handler: typeof connect) => {
      connect = handler;
    },
    to: () => ({ emit: socket.emit }),
    sockets: { sockets: new Map([[socket.id, socket]]) },
  };
  setupSocketHandlers(io as never);
  await connect(socket);
  const run = handlers.get("npc:chat")!({
    npcId,
    characterId: character.id,
    sourceMessageId: "source-1",
    message: "hi",
  });
  await ready;
  const beforeFinal = payloads<{ response: ChatResponse }>("npc:response-state").map(
    (p) => p.response,
  );
  release();
  await run;
  assert.deepEqual(
    beforeFinal.map((r) => r.status),
    ["queued", "thinking", "streaming"],
  );
  assert.equal(beforeFinal.at(-1)?.content, "hello");
  const final = payloads<{ response: ChatResponse }>("npc:response-state").at(-1)!.response;
  assert.equal(final.status, "complete");
  assert.equal(final.content, "hello world");
  assert.equal(final.sourceMessageId, "source-1");
  assert.ok(
    payloads<{ responseRequestId: string }>("npc:response").every(
      (p) => p.responseRequestId === final.requestId,
    ),
  );
  // The history owner is my character as settled by player:join (socket.data.myCharacterId). This fake socket
  // does not go through join, so we plant only its result. The characterId sent by the client is ignored.
  socket.data.myCharacterId = character.id;
  await handlers.get("npc:history")!({ npcId });
  const history = payloads<{ messages: { id: string; responseRequestId?: string }[] }>(
    "npc:history",
  ).at(-1)!.messages;
  assert.deepEqual(
    history.map((m: { id: string }) => m.id),
    ["source-1", final.requestId],
  );
  assert.equal(history[1].responseRequestId, final.requestId);
  assert.equal(
    payloads<{ responses: ChatResponse[] }>("npc:response-snapshot").at(-1)!.responses[0].requestId,
    final.requestId,
  );

  // A real SQLite failure must never produce a successful/persisted response state.
  const sqlite = db as unknown as { run(query: import("drizzle-orm").SQL): void };
  const errors = t.mock.method(console, "error", () => {});
  await sqlite.run(
    sql`CREATE TRIGGER reject_ux_reply BEFORE INSERT ON chat_messages WHEN NEW.role = 'npc' BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END`,
  );
  // Reset cooldown without waiting: the handler owns this socket's entry and clears it on disconnect.
  await handlers.get("disconnect")!(undefined);
  await handlers.get("npc:chat")!({
    npcId,
    characterId: character.id,
    sourceMessageId: "source-2",
    message: "second",
  });
  const failed = payloads<{ response: ChatResponse }>("npc:response-state").at(-1)!.response;
  assert.equal(failed.status, "failed");
  assert.equal(failed.sourceMessageId, "source-2");
  assert.equal(failed.messageId, undefined);
  assert.ok(
    errors.mock.calls.some((call) =>
      String(call.arguments[0]).includes("failed to persist message"),
    ),
  );
  await sqlite.run(sql`DROP TRIGGER reject_ux_reply`);
});
