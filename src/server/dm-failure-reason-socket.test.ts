import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";
setupThrowawaySqlite("dm-failure-reason-socket");
import { db, characters, npcs } from "@/db";
import { DEV_JWT_SECRET } from "@/lib/dev-constants";
import type { ChatResponse } from "@/lib/chat-response";
import { HermesError } from "@/lib/hermes/hermes-client";
import { adapterRegistry, setupSocketHandlers } from "./socket-handlers";

// Measured on staging (Hermes 0.21.2) with an expired openai-codex sign-in; the key is masked.
const PROVIDER_TEXT =
  "ChatGPT or Codex Subscription rejected your sign-in, so the model can't be reached. " +
  "Sign in again: `hermes -p sophie auth add openai-codex --type oauth`.\n\n" +
  "Provider said: HTTP 401: Incorrect API key provided: sk-test*****.";

test("a DM the provider rejected fails with its cause and without the provider's text", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.method(console, "error", () => {});
  const seed = await seedChannelWithProfiles({ placedActive: 1, displayName: "Sophie" });
  const [character] = await db
    .insert(characters)
    .values({ userId: seed.userId, name: "Dante", appearance: "{}" })
    .returning();
  const npcId = seed.npcIds[0];
  await db.update(npcs).set({ adapterType: "dm-provider-auth" }).where(eq(npcs.id, npcId));
  adapterRegistry.register({
    type: "dm-provider-auth",
    testConnection: async () => ({ status: "ok" }),
    execute: async () => {
      throw new HermesError("run_failed", PROVIDER_TEXT, 200);
    },
  });

  const events: [string, unknown][] = [];
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const token = await new SignJWT({ userId: seed.userId, nickname: "Dante" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
  const socket = {
    data: {} as Record<string, unknown>,
    use: () => {},
    id: "dm-failure-reason-socket",
    handshake: { headers: { cookie: `token=${token}` } },
    on: (event: string, handler: (payload: unknown) => Promise<void>) => {
      handlers.set(event, handler);
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
  await handlers.get("npc:chat")!({
    npcId,
    characterId: character.id,
    sourceMessageId: "source-1",
    message: "hi",
  });

  const final = events
    .filter(([name]) => name === "npc:response-state")
    .map(([, p]) => (p as { response: ChatResponse }).response)
    .at(-1)!;
  assert.equal(final.status, "failed");
  assert.equal(final.error, "provider_auth_expired");
  const wire = JSON.stringify(events);
  assert.equal(wire.includes("Incorrect API key"), false, "provider text reached the client");
  assert.equal(wire.includes("sk-test"), false, "a key fragment reached the client");
});
