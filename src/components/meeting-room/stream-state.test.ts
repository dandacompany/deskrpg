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

test("When the server provides final text, the bubble is finalized with it instead of the accumulated stream", () => {
  // The delta can accumulate even a retried earlier generation — the meeting record (server's final text)
  // and the screen must match.
  const result = consumeNpcStreamBuffer({
    streams: { oliver: "첫 생성. 둘째 생성." },
    npcId: "oliver",
    fallbackSenderName: "올리버",
    timestamp: 1,
    finalText: "둘째 생성.",
  });
  assert.equal(result.finalizedMessage?.content, "둘째 생성.");
  assert.deepEqual(result.nextStreams, {});
});

test("A bubble is created even when only the final text arrives without chunks", () => {
  const result = consumeNpcStreamBuffer({
    streams: {},
    npcId: "oliver",
    fallbackSenderName: "올리버",
    timestamp: 1,
    finalText: "한 덩어리 응답",
  });
  assert.equal(result.finalizedMessage?.content, "한 덩어리 응답");
});

test("If the final text is empty or not a string, fall back to the accumulated buffer as before", () => {
  for (const finalText of ["", undefined, { x: 1 } as unknown as string]) {
    const result = consumeNpcStreamBuffer({
      streams: { oliver: "누적분" },
      npcId: "oliver",
      fallbackSenderName: "올리버",
      timestamp: 1,
      finalText,
    });
    assert.equal(result.finalizedMessage?.content, "누적분");
  }
});
