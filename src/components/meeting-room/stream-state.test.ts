import assert from "node:assert/strict";
import test from "node:test";

import { consumeNpcStreamBuffer } from "./stream-state";

test("consumeNpcStreamBuffer returns a finalized message and removes the stream", () => {
  const result = consumeNpcStreamBuffer({
    streams: { "npc-1": "hello world" },
    npcId: "npc-1",
    fallbackSenderName: "으뉴",
    timestamp: 123,
  });

  assert.deepEqual(result.nextStreams, {});
  assert.deepEqual(result.finalizedMessage, {
    id: "msg-123-npc-1",
    sender: "으뉴",
    senderId: "npc-npc-1",
    senderType: "npc",
    content: "hello world",
    timestamp: 123,
  });
});

test("consumeNpcStreamBuffer returns no message when the buffer is empty", () => {
  const result = consumeNpcStreamBuffer({
    streams: {},
    npcId: "npc-1",
    fallbackSenderName: "으뉴",
    timestamp: 123,
  });

  assert.deepEqual(result.nextStreams, {});
  assert.equal(result.finalizedMessage, null);
});
