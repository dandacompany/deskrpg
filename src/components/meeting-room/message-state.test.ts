import assert from "node:assert/strict";
import test from "node:test";

import { appendMeetingMessage } from "./message-state";

test("appendMeetingMessage adds a suffix when the incoming id already exists", () => {
  const existing = [
    {
      id: "msg-1-dev-b",
      sender: "으뉴",
      senderId: "npc-dev-b",
      senderType: "npc" as const,
      content: "first",
      timestamp: 1,
    },
  ];

  const next = appendMeetingMessage(existing, {
    id: "msg-1-dev-b",
    sender: "으뉴",
    senderId: "npc-dev-b",
    senderType: "npc",
    content: "second",
    timestamp: 2,
  });

  assert.notEqual(next, existing);
  assert.equal(next.length, 2);
  assert.equal(next[0]?.id, "msg-1-dev-b");
  assert.equal(next[1]?.id, "msg-1-dev-b-1");
});

test("appendMeetingMessage keeps the most recent 100 messages", () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `msg-${index}`,
    sender: "system",
    senderId: "system",
    senderType: "npc" as const,
    content: String(index),
    timestamp: index,
  }));

  const next = appendMeetingMessage(existing, {
    id: "msg-100",
    sender: "system",
    senderId: "system",
    senderType: "npc",
    content: "100",
    timestamp: 100,
  });

  assert.equal(next.length, 100);
  assert.equal(next[0]?.id, "msg-1");
  assert.equal(next.at(-1)?.id, "msg-100");
});
