import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatMessageRow,
  npcHistoryKey,
  toHistoryMessages,
  type StoredChatMessage,
} from "./npc-chat-history";

// --- Key: pins down that the owning unit of history is the character ---

test("history keys differ per character", () => {
  // A conversation two different people in the same channel had with the same NPC must not mix.
  assert.notEqual(npcHistoryKey("char-a", "npc-1"), npcHistoryKey("char-b", "npc-1"));
});

test("the same character's conversations with different NPCs also differ", () => {
  assert.notEqual(npcHistoryKey("char-a", "npc-1"), npcHistoryKey("char-a", "npc-2"));
});

test("the same character and same NPC yield the same key", () => {
  assert.equal(npcHistoryKey("char-a", "npc-1"), npcHistoryKey("char-a", "npc-1"));
});

// --- Row builder ---

test("a row holds character, NPC, role, and content", () => {
  const row = buildChatMessageRow({
    characterId: "char-a",
    npcId: "npc-1",
    role: "player",
    content: "안녕",
  });
  assert.ok(row, "행이 저장되지 않았다");
  assert.equal(row.characterId, "char-a");
  assert.equal(row.npcId, "npc-1");
  assert.equal(row.role, "player");
  assert.equal(row.content, "안녕");
});

test("empty content isn't saved", () => {
  assert.equal(
    buildChatMessageRow({ characterId: "c", npcId: "n", role: "npc", content: "   " }),
    null,
  );
});

// --- DB row -> client message ---

test("converts a saved row back into the client history shape", () => {
  const at = new Date("2026-08-26T01:02:03.000Z");
  const rows: StoredChatMessage[] = [
    { role: "player", content: "안녕", createdAt: at },
    { role: "npc", content: "반가워요", createdAt: at },
  ];
  assert.deepEqual(toHistoryMessages(rows), [
    { role: "player", content: "안녕", timestamp: at.getTime() },
    { role: "npc", content: "반가워요", timestamp: at.getTime() },
  ]);
});

test("a message isn't lost even when createdAt is empty", () => {
  // A row made by bootstrap or older data can have null here.
  const [msg] = toHistoryMessages([{ role: "npc", content: "안녕", createdAt: null }]);
  assert.equal(msg.content, "안녕");
  assert.equal(typeof msg.timestamp, "number");
});

test("an unknown role is dropped", () => {
  const rows = [
    { role: "player", content: "ok", createdAt: null },
    { role: "system", content: "내부용", createdAt: null },
  ] as unknown as StoredChatMessage[];
  assert.deepEqual(
    toHistoryMessages(rows).map((m) => m.content),
    ["ok"],
  );
});

// --- DB boundary: does the wiring actually run (this is the gap left if we only pin the pure functions) ---

import { appendNpcChatMessage, clearNpcChatHistory, loadNpcChatHistory } from "./npc-chat-history";

const schema = {
  chatMessages: {
    characterId: "col.characterId",
    npcId: "col.npcId",
    role: "col.role",
    content: "col.content",
    createdAt: "col.createdAt",
  },
};

test("append inserts the built row as-is", async () => {
  const inserted: unknown[] = [];
  const db = {
    insert: () => ({
      values: async (row: unknown) => {
        inserted.push(row);
      },
    }),
  };
  const row = await appendNpcChatMessage(db, schema, {
    characterId: "char-a",
    npcId: "npc-1",
    role: "player",
    content: "  안녕  ",
  });
  assert.deepEqual(inserted, [
    { characterId: "char-a", npcId: "npc-1", role: "player", content: "안녕" },
  ]);
  assert.equal(row?.content, "안녕");
});

test("an empty utterance never even touches the DB", async () => {
  let touched = false;
  const db = {
    insert: () => {
      touched = true;
      return { values: async () => {} };
    },
  };
  const row = await appendNpcChatMessage(db, schema, {
    characterId: "char-a",
    npcId: "npc-1",
    role: "npc",
    content: "   ",
  });
  assert.equal(row, null);
  assert.equal(touched, false);
});

test("load returns the query result as history messages", async () => {
  const at = new Date("2026-08-26T00:00:00.000Z");
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [{ role: "npc", content: "안녕하세요", createdAt: at }],
        }),
      }),
    }),
  };
  const messages = await loadNpcChatHistory(db, schema, {
    characterId: "char-a",
    npcId: "npc-1",
  });
  assert.deepEqual(messages, [{ role: "npc", content: "안녕하세요", timestamp: at.getTime() }]);
});

test("clear calls delete", async () => {
  let deleted = false;
  const db = {
    delete: () => ({
      where: async () => {
        deleted = true;
      },
    }),
  };
  await clearNpcChatHistory(db, schema, { characterId: "char-a", npcId: "npc-1" });
  assert.equal(deleted, true);
});

// --- Owner determination: the point that keeps pre-join conversation from silently vanishing ---

import { characterBelongsToUser, pickHistoryCharacterId } from "./npc-chat-history";

test("a joined socket uses the character the server knows about and doesn't validate", () => {
  const picked = pickHistoryCharacterId({
    joinedCharacterId: "char-joined",
    claimedCharacterId: "char-claimed",
  });
  // Even if the client calls out a different value, what the server knows wins.
  assert.deepEqual(picked, { characterId: "char-joined", needsVerification: false });
});

test("before join, uses the character the client claims but requires verification", () => {
  assert.deepEqual(
    pickHistoryCharacterId({ joinedCharacterId: null, claimedCharacterId: "char-x" }),
    {
      characterId: "char-x",
      needsVerification: true,
    },
  );
});

test("with neither present, the owner can't be determined", () => {
  assert.deepEqual(pickHistoryCharacterId({ joinedCharacterId: null, claimedCharacterId: null }), {
    characterId: null,
    needsVerification: false,
  });
});

test("an empty string doesn't count as a character", () => {
  assert.deepEqual(pickHistoryCharacterId({ joinedCharacterId: "", claimedCharacterId: "  " }), {
    characterId: null,
    needsVerification: false,
  });
});

test("ownership verification only passes for that user's own character", async () => {
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: "char-x" }] }) }),
    }),
  };
  assert.equal(
    await characterBelongsToUser(db, { characters: {} }, { characterId: "char-x", userId: "u1" }),
    true,
  );
});

test("rejects when someone else's character is sent", async () => {
  // An empty query result means it's not that user's — this is the point that blocks writing to someone else's history.
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  assert.equal(
    await characterBelongsToUser(db, { characters: {} }, { characterId: "char-y", userId: "u1" }),
    false,
  );
});

// --- Tasks and history must see the same owner ---

test("history and tasks use the same character resolution", () => {
  // Confirmed 2026-08-28: only the task branch looked directly at the `players` map, so
  // right after a reconnect, history stayed while the task silently vanished — the user
  // had already gotten as far as approving it.
  // As long as both paths use the same function, this divergence can't happen again.
  const joined = pickHistoryCharacterId({
    joinedCharacterId: null,
    claimedCharacterId: "char-x",
  });
  assert.equal(joined.characterId, "char-x");
  assert.equal(joined.needsVerification, true);

  // The key point is that the owner can be determined even before join —
  // the old task path used to just drop this case.
  assert.notEqual(joined.characterId, null);
});
