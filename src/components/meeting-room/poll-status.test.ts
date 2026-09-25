import test from "node:test";
import assert from "node:assert/strict";

import { formatPollRaises, formatPollPasses } from "./poll-status";

test("formatPollRaises renders names from object payloads", () => {
  assert.deepEqual(
    formatPollRaises([
      { name: "으뉴", reason: "idea" },
      { name: "마틴", reason: "follow-up" },
    ]),
    ["으뉴", "마틴"],
  );
});

test("formatPollRaises preserves legacy string payloads", () => {
  assert.deepEqual(formatPollRaises(["으뉴", "마틴"]), ["으뉴", "마틴"]);
});

test("pass votes resolve NPC IDs to display names without exposing unknown UUIDs", () => {
  const npcs = [
    { id: "a-uuid", name: "소피" },
    { id: "b-uuid", name: "마틴" },
  ];
  assert.deepEqual(formatPollPasses(["a-uuid", "마틴", "unknown-uuid"], npcs, "알 수 없는 NPC"), [
    "소피",
    "마틴",
    "알 수 없는 NPC",
  ]);
  assert.deepEqual(formatPollPasses(undefined, npcs, "Unknown NPC"), []);
});

test("the poll status line never shows the server's raw status value", async () => {
  const { pollStatusNoteKey } = await import("./poll-status");
  // "polling" is what the heading already says — repeating it untranslated was the staging bug.
  assert.equal(pollStatusNoteKey("polling"), null);
  assert.equal(pollStatusNoteKey(undefined), null);
  assert.equal(pollStatusNoteKey(""), null);
  // A status a newer server adds gets a generic phrase, not its English code.
  assert.equal(pollStatusNoteKey("tallying"), "meeting.pollStatus.other");
  assert.equal(pollStatusNoteKey(42), null);
});
