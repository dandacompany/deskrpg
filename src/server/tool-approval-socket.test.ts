import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";

import { setupThrowawaySqlite, seedChannelWithProfiles } from "@/test-setup/npc-seed";
setupThrowawaySqlite("tool-approval-socket");
import { DEV_JWT_SECRET } from "@/lib/dev-constants";
import { getToolApprovalRegistry, setupSocketHandlers } from "./socket-handlers";

// Socket wiring of live tool approvals: every socket of a user joins `user:<id>` (cards reach all
// tabs), a (re)connecting socket gets the cards still waiting on it, and `tool-approval:decide`
// answers through the registry, which refuses anyone but the approver.

async function fakeSocket(userId: string, id: string) {
  const token = await new SignJWT({ userId, nickname: "Dante" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET || DEV_JWT_SECRET));
  const events: [string, unknown][] = [];
  const joined: string[] = [];
  const handlers = new Map<string, (payload: unknown, ack?: unknown) => Promise<void>>();
  return {
    events,
    joined,
    handlers,
    socket: {
      id,
      data: {} as Record<string, unknown>,
      handshake: { headers: { cookie: `token=${token}` } },
      use: () => {},
      on: (event: string, handler: (payload: unknown, ack?: unknown) => Promise<void>) =>
        handlers.set(event, handler),
      emit: (event: string, payload: unknown) => events.push([event, payload]),
      join: async (room: string) => {
        joined.push(room);
      },
      leave: () => {},
      disconnect: () => {},
    },
  };
}

test("approval cards reach the user's room, reconnecting sockets get pending cards, and only the approver decides", async () => {
  const seed = await seedChannelWithProfiles({ placedActive: 1, displayName: "Sophie" });
  const roomEmits: { room: string; event: string; payload: unknown }[] = [];
  let connect!: (socket: unknown) => Promise<void>;
  const io = {
    on: (_event: string, handler: typeof connect) => {
      connect = handler;
    },
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push({ room, event, payload }),
    }),
    sockets: { sockets: new Map() },
  };
  setupSocketHandlers(io as never);
  const registry = getToolApprovalRegistry()!;

  const first = await fakeSocket(seed.userId, "tab-1");
  await connect(first.socket);
  assert.ok(first.joined.includes(`user:${seed.userId}`));

  const card = {
    key: "run_1:req_1",
    runId: "run_1",
    requestId: "req_1",
    npcId: seed.npcIds[0],
    channelId: seed.channelId,
    context: "dm" as const,
    kind: "command" as const,
    command: "rm -r /tmp/probe",
    description: "recursive delete",
    choices: ["once", "session", "deny"] as ("once" | "session" | "deny")[],
    expiresAt: Date.now() + 60_000,
  };
  registry.add({ ...card, approverUserId: seed.userId, approverName: "Dante" });
  registry.add({
    ...card,
    key: "run_2:req_1",
    runId: "run_2",
    approverUserId: "someone-else",
    approverName: "Other",
  });
  assert.deepEqual(
    roomEmits.filter((e) => e.event === "tool-approval:request").map((e) => e.room),
    [`user:${seed.userId}`, "user:someone-else"],
  );

  // A second tab connecting later gets the card still waiting on this user — and only that one.
  const second = await fakeSocket(seed.userId, "tab-2");
  await connect(second.socket);
  const resent = second.events.filter(([e]) => e === "tool-approval:request").map(([, p]) => p);
  assert.deepEqual(
    resent.map((p) => (p as { key: string }).key),
    ["run_1:req_1"],
  );
  assert.equal("approverUserId" in (resent[0] as object), false);

  // Someone else's card cannot be answered from this user's socket.
  let ack: unknown;
  await second.handlers.get("tool-approval:decide")!(
    { key: "run_2:req_1", choice: "once" },
    (r: unknown) => (ack = r),
  );
  assert.deepEqual(ack, { result: "not_approver" });
  await second.handlers.get("tool-approval:decide")!(
    { key: "run_1:req_1", choice: "always" },
    (r: unknown) => (ack = r),
  );
  assert.deepEqual(ack, { result: "invalid_choice" });

  registry.expireRun("run_1");
  registry.expireRun("run_2");
});
