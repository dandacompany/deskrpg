import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { setupThrowawaySqlite, seedChannelWithProfiles, seedUser } from "@/test-setup/npc-seed";
setupThrowawaySqlite("dm-cancel-socket");
import { db, characters, npcs } from "@/db";
import { DEV_JWT_SECRET } from "@/lib/dev-constants";
import type { ChatResponse } from "@/lib/chat-response";
import { adapterRegistry, setupSocketHandlers } from "./socket-handlers";

// The stop button: npc:cancel-response ends the requester's own DM, stops the backend run, and
// leaves no NPC reply behind. Nobody else can stop it.

async function tokenFor(userId: string) {
  return new SignJWT({ userId, nickname: "tester" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
}

function harness() {
  const broadcasts: [string, unknown][] = [];
  let connect!: (socket: unknown) => Promise<void>;
  const sockets = new Map<string, unknown>();
  const io = {
    on: (_event: string, handler: typeof connect) => {
      connect = handler;
    },
    to: () => ({ emit: (event: string, payload: unknown) => broadcasts.push([event, payload]) }),
    sockets: { sockets },
  };
  setupSocketHandlers(io as never);
  const open = async (id: string, userId: string) => {
    const handlers = new Map<string, (payload: unknown) => Promise<void>>();
    const socket = {
      data: {} as Record<string, unknown>,
      use: () => {},
      id,
      handshake: { headers: { cookie: `token=${await tokenFor(userId)}` } },
      on: (event: string, handler: (payload: unknown) => Promise<void>) =>
        handlers.set(event, handler),
      emit: (event: string, payload: unknown) => broadcasts.push([event, payload]),
      join: () => {},
      leave: () => {},
      disconnect: () => {},
    };
    sockets.set(id, socket);
    await connect(socket);
    return (event: string, payload: unknown) => handlers.get(event)!(payload);
  };
  const states = () =>
    broadcasts
      .filter(([name]) => name === "npc:response-state")
      .map(([, p]) => (p as { response: ChatResponse }).response);
  return { open, states, broadcasts };
}

test("the requester can stop a running DM; another user cannot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const seed = await seedChannelWithProfiles({ placedActive: 1, displayName: "Sophie" });
  const [character] = await db
    .insert(characters)
    .values({ userId: seed.userId, name: "Dante", appearance: "{}" })
    .returning();
  const npcId = seed.npcIds[0];
  await db.update(npcs).set({ adapterType: "cancel-test" }).where(eq(npcs.id, npcId));
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborts = 0;
  adapterRegistry.register({
    type: "cancel-test",
    testConnection: async () => ({ status: "ok" }),
    execute: async (options) => {
      options.onDelta?.("half an");
      started();
      return new Promise<never>(() => {});
    },
    abort: async () => {
      aborts += 1;
    },
  });

  const h = harness();
  const owner = await h.open("owner-socket", seed.userId);
  const stranger = await h.open("stranger-socket", (await seedUser("stranger")).id);
  const run = owner("npc:chat", {
    npcId,
    characterId: character.id,
    sourceMessageId: "source-1",
    message: "write a long report",
  });
  await running;
  const requestId = h.states().at(-1)!.requestId;

  await stranger("npc:cancel-response", { npcId, requestId, characterId: character.id });
  assert.equal(h.states().at(-1)!.status, "streaming", "another user cannot stop it");
  assert.equal(aborts, 0);

  await owner("npc:cancel-response", { npcId, requestId, characterId: character.id });
  await run;
  const final = h.states().at(-1)!;
  assert.equal(final.status, "cancelled");
  assert.equal(final.requestId, requestId);
  assert.equal(aborts, 1, "the backend run is stopped");
  assert.ok(
    !h.broadcasts.some(([name]) => name === "npc:response-complete"),
    "a stopped reply is not finished as an answer",
  );
});

test("a malformed cancel is ignored", async () => {
  const seed = await seedChannelWithProfiles({ placedActive: 1 });
  const h = harness();
  const owner = await h.open("owner-2", seed.userId);
  await owner("npc:cancel-response", null);
  await owner("npc:cancel-response", { npcId: seed.npcIds[0], requestId: 42 });
  assert.deepEqual(h.states(), []);
});
