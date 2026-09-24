import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDmThreadEntries,
  needsCallBeforeDmSend,
  summarizeDmThreads,
  type DmThreadRow,
} from "./dm-threads";

const at = (iso: string) => new Date(iso);

test("only the last message per employee remains", () => {
  const rows: DmThreadRow[] = [
    { npcId: "n1", role: "player", content: "안녕", createdAt: at("2026-09-01T00:00:00Z") },
    { npcId: "n1", role: "npc", content: "반가워요", createdAt: at("2026-09-01T00:00:10Z") },
  ];
  const threads = summarizeDmThreads(rows);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].lastMessage, { role: "npc", content: "반가워요" });
  assert.equal(threads[0].lastAt, at("2026-09-01T00:00:10Z").getTime());
});

test("the most recent conversation comes first", () => {
  const threads = summarizeDmThreads([
    { npcId: "old", role: "npc", content: "어제", createdAt: at("2026-09-01T00:00:00Z") },
    { npcId: "new", role: "npc", content: "오늘", createdAt: at("2026-09-02T00:00:00Z") },
  ]);
  assert.deepEqual(
    threads.map((thread) => thread.npcId),
    ["new", "old"],
  );
});

test("an employee with no conversation gets no row at all", () => {
  assert.deepEqual(summarizeDmThreads([]), []);
});

test("empty messages and unknown roles don't pollute the list", () => {
  const threads = summarizeDmThreads([
    { npcId: "n1", role: "player", content: "안녕", createdAt: at("2026-09-01T00:00:00Z") },
    { npcId: "n1", role: "system", content: "내부 기록", createdAt: at("2026-09-01T00:01:00Z") },
    { npcId: "n1", role: "npc", content: "   ", createdAt: at("2026-09-01T00:02:00Z") },
  ]);
  assert.deepEqual(threads[0].lastMessage, { role: "player", content: "안녕" });
});

test("a row with no timestamp is not dropped", () => {
  const threads = summarizeDmThreads([
    { npcId: "n1", role: "player", content: "안녕", createdAt: null },
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].lastAt, 0);
});

test("a clocked-out employee's conversation stays as inactive — hiding it would remove the entry point again", () => {
  const entries = buildDmThreadEntries(
    summarizeDmThreads([
      {
        npcId: "n1",
        role: "npc",
        content: "다녀오겠습니다",
        createdAt: at("2026-09-01T00:00:00Z"),
      },
    ]),
    [{ id: "n1", name: "noah", active: false }],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].npcName, "noah");
  assert.equal(entries[0].active, false);
});

test("conversations with an employee not on the roster (deleted) are excluded from the list", () => {
  const entries = buildDmThreadEntries(
    summarizeDmThreads([
      { npcId: "gone", role: "npc", content: "…", createdAt: at("2026-09-01T00:00:00Z") },
    ]),
    [{ id: "n1", name: "noah", active: true }],
  );
  assert.deepEqual(entries, []);
});

test("does not call again if already nearby or on the way", () => {
  assert.equal(needsCallBeforeDmSend("waiting"), false);
  assert.equal(needsCallBeforeDmSend("moving-to-player"), false);
});

test("calls at send time if at their desk or status is unknown", () => {
  assert.equal(needsCallBeforeDmSend(undefined), true);
  assert.equal(needsCallBeforeDmSend(null), true);
  assert.equal(needsCallBeforeDmSend("idle"), true);
  assert.equal(needsCallBeforeDmSend("returning"), true);
});

// dev1 review question: `loadDmThreads` reads a character's DMs **without any channel
// filter**. The only thing that filters out rows for employees of other channels is this
// comparison — the roster (`rosterNpcs`) comes in per channel via
// `/api/npcs?channelId=…&roster=1`, and any npcId not in it produces no row.
// This is mechanically the same code path as the "deleted employee" test above, but we
// name it as its own case — without a name, someone will later have to re-investigate
// "where does channel isolation happen".
test("a conversation with an employee from another channel doesn't leak into the current channel's list", () => {
  const threads = summarizeDmThreads([
    { npcId: "here", role: "npc", content: "이 채널", createdAt: at("2026-09-01T00:00:00Z") },
    {
      npcId: "elsewhere",
      role: "npc",
      content: "다른 채널",
      createdAt: at("2026-09-02T00:00:00Z"),
    },
  ]);
  // Sorted newest-first, so the other channel's row comes first — but it still must not survive into the list.
  assert.deepEqual(
    threads.map((thread) => thread.npcId),
    ["elsewhere", "here"],
  );
  const entries = buildDmThreadEntries(threads, [{ id: "here", name: "noah", active: true }]);
  assert.deepEqual(
    entries.map((entry) => entry.npcId),
    ["here"],
  );
});
