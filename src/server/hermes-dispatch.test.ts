import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { classifyNpcDispatch, deriveHermesContextKey } from "./hermes-dispatch";

describe("classifyNpcDispatch", () => {
  test("routes hermes NPCs to the profile-backed adapter", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "hermes", hermesProfileId: "p1" }), "hermes");
  });

  test("reports unbound when a hermes NPC has no profile", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "hermes", hermesProfileId: null }), "unbound");
  });

  test("reports unbound for migration-marked NPCs", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "unbound", hermesProfileId: null }), "unbound");
  });

  test("leaves CLI adapters on the registry path", () => {
    assert.equal(classifyNpcDispatch({ adapterType: "claude", hermesProfileId: null }), "registry");
  });

  test("leaves openclaw on the legacy gateway path during P1", () => {
    assert.equal(
      classifyNpcDispatch({ adapterType: "openclaw", hermesProfileId: null }),
      "openclaw",
    );
  });
});

describe("deriveHermesContextKey", () => {
  test("strips the session key prefix to recover the dm context", () => {
    assert.equal(deriveHermesContextKey("npc-123-dm-user-456", "npc-123"), "dm-user-456");
  });

  test("strips the session key prefix to recover a task context", () => {
    assert.equal(deriveHermesContextKey("npc-123-task-abc", "npc-123"), "task-abc");
  });

  test("falls back to the full session key when the prefix does not match", () => {
    assert.equal(deriveHermesContextKey("some-other-key", "npc-123"), "some-other-key");
  });
});

describe("hermes run registry", () => {
  test("registers, retrieves, and clears run ids per session key", async () => {
    const { registerHermesRun, getHermesRun, clearHermesRun } = await import("./hermes-dispatch");
    const sessionKey = `test-session-${crypto.randomUUID()}`;

    assert.equal(getHermesRun(sessionKey), undefined);
    registerHermesRun(sessionKey, "run-1");
    assert.equal(getHermesRun(sessionKey), "run-1");
    registerHermesRun(sessionKey, "run-2");
    assert.equal(getHermesRun(sessionKey), "run-2");
    clearHermesRun(sessionKey);
    assert.equal(getHermesRun(sessionKey), undefined);
  });
});

// Session persistence is DB-backed (drizzle over @/db), so these tests exercise it
// against a real temporary SQLite database rather than mocking `db` — matching the
// existing pattern in src/lib/hermes-profiles.test.ts.
const sqlitePath = path.join(os.tmpdir(), `hermes-dispatch-test-${crypto.randomUUID()}.db`);
process.env.DESKRPG_HOME = os.tmpdir();
process.env.SQLITE_PATH = sqlitePath;
for (const ext of ["", "-wal", "-shm"]) {
  process.on("exit", () => fs.rmSync(`${sqlitePath}${ext}`, { force: true }));
}

async function loadDb() {
  return import("@/db");
}

async function seedUser() {
  const { db, users } = await loadDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({
      loginId: `user-${suffix}`,
      nickname: `user-${suffix}`,
      passwordHash: "hash",
    })
    .returning();
  return user;
}

async function seedChannel(ownerId: string) {
  const { db, channels } = await loadDb();
  const [channel] = await db
    .insert(channels)
    .values({
      name: "Test Channel",
      ownerId,
    })
    .returning();
  return channel;
}

async function seedNpc(channelId: string) {
  const { db, npcs, jsonForDb } = await loadDb();
  const [npc] = await db
    .insert(npcs)
    .values({
      channelId,
      name: "Test NPC",
      positionX: 0,
      positionY: 0,
      appearance: jsonForDb({}),
      openclawConfig: jsonForDb({}),
      adapterType: "hermes",
    } as never)
    .returning();
  return npc;
}

describe("hermes session persistence", () => {
  test("returns null when no session has been stored yet", async () => {
    const { getStoredHermesSessionRef } = await import("./hermes-dispatch");
    const user = await seedUser();
    const channel = await seedChannel(user.id);
    const npc = await seedNpc(channel.id);

    const stored = await getStoredHermesSessionRef(npc.id, user.id, "dm-" + user.id);
    assert.equal(stored, null);
  });

  test("round-trips a stored session ref and updates it on a second write", async () => {
    const { getStoredHermesSessionRef, persistHermesSessionRef } =
      await import("./hermes-dispatch");
    const user = await seedUser();
    const channel = await seedChannel(user.id);
    const npc = await seedNpc(channel.id);
    const contextKey = "dm-" + user.id;

    await persistHermesSessionRef(npc.id, user.id, contextKey, "session-1");
    assert.equal(await getStoredHermesSessionRef(npc.id, user.id, contextKey), "session-1");

    await persistHermesSessionRef(npc.id, user.id, contextKey, "session-2");
    assert.equal(await getStoredHermesSessionRef(npc.id, user.id, contextKey), "session-2");
  });
});
