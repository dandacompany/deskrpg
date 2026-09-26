import assert from "node:assert/strict";
import test from "node:test";

import type { ChatResponse } from "@/lib/chat-response";
import {
  npcPresentationPhases,
  npcResponseFailures,
  initialChatResponseState,
  reconcileNpcResponseMessages,
  reduceChatResponseState,
  responsesForScope,
  upsertLegacyNpcChunk,
  visibleResponseReplies,
} from "./chat-response-state";
import type { NpcChatMessage } from "@/components/NpcDialog";

function response(
  overrides: Partial<ChatResponse> & Pick<ChatResponse, "requestId">,
): ChatResponse {
  return {
    sourceMessageId: "source-1",
    npcId: "npc-1",
    npcName: "Sophie",
    status: "thinking",
    content: "",
    updatedAt: 1,
    ...overrides,
  };
}

test("interleaved NPC updates retain each request and cumulative content replaces", () => {
  let state = initialChatResponseState;
  state = reduceChatResponseState(state, {
    type: "state",
    scope: "room",
    scopeId: "room-1",
    response: response({ requestId: "r1", content: "hel", status: "streaming" }),
  });
  state = reduceChatResponseState(state, {
    type: "state",
    scope: "room",
    scopeId: "room-1",
    response: response({ requestId: "r2", npcId: "npc-2", npcName: "Mina" }),
  });
  state = reduceChatResponseState(state, {
    type: "state",
    scope: "room",
    scopeId: "room-1",
    response: response({ requestId: "r1", content: "hello", status: "streaming", updatedAt: 3 }),
  });

  assert.deepEqual(
    responsesForScope(state, "room", "room-1").map(({ requestId, content }) => [
      requestId,
      content,
    ]),
    [
      ["r1", "hello"],
      ["r2", ""],
    ],
  );
});

test("snapshot replaces only its scope and disconnect removes active animation", () => {
  let state = reduceChatResponseState(initialChatResponseState, {
    type: "snapshot",
    scope: "npc",
    scopeId: "npc-1",
    responses: [
      response({ requestId: "active" }),
      response({ requestId: "done", status: "complete" }),
    ],
  });
  state = reduceChatResponseState(state, {
    type: "snapshot",
    scope: "npc",
    scopeId: "npc-2",
    responses: [response({ requestId: "other", npcId: "npc-2" })],
  });
  state = reduceChatResponseState(state, {
    type: "snapshot",
    scope: "npc",
    scopeId: "npc-1",
    responses: [response({ requestId: "replacement", status: "streaming", content: "new" })],
  });
  assert.deepEqual(
    responsesForScope(state, "npc", "npc-1").map((item) => item.requestId),
    ["replacement"],
  );
  assert.deepEqual(
    responsesForScope(state, "npc", "npc-2").map((item) => item.requestId),
    ["other"],
  );

  state = reduceChatResponseState(state, { type: "disconnect" });
  assert.deepEqual(responsesForScope(state, "npc", "npc-1"), []);
  assert.deepEqual(responsesForScope(state, "npc", "npc-2"), []);
});

test("final room message and tracked DM history suppress fallback replies without duplicates", () => {
  const records = [
    response({
      requestId: "room-final",
      status: "complete",
      content: "room answer",
      messageId: "m-9",
    }),
    response({
      requestId: "dm-final",
      status: "complete",
      content: "dm answer",
      sourceMessageId: "dm-source",
    }),
    response({ requestId: "failed", status: "failed", error: "Timed out" }),
  ];

  assert.deepEqual(
    visibleResponseReplies(records, { persistedMessageIds: new Set(["m-9"]) }).map(
      (item) => item.requestId,
    ),
    ["dm-final", "failed"],
  );
  assert.deepEqual(
    visibleResponseReplies(records, { responseRequestIds: new Set(["dm-final"]) }).map(
      (item) => item.requestId,
    ),
    ["room-final", "failed"],
  );
});

test("DM snapshot inserts a tracked reply after its source without moving it below newer human messages", () => {
  const messages: NpcChatMessage[] = [
    { id: "human-1", role: "player", content: "first" },
    { id: "human-2", role: "player", content: "second" },
  ];
  const reconciled = reconcileNpcResponseMessages(messages, [
    response({
      requestId: "reply-1",
      sourceMessageId: "human-1",
      status: "complete",
      content: "answer",
    }),
  ]);

  assert.deepEqual(
    reconciled.map((message) => message.id),
    ["human-1", "reply-1", "human-2"],
  );
  assert.equal(
    reconcileNpcResponseMessages(reconciled, [response({ requestId: "reply-1" })]).length,
    3,
  );
});

test("response chunk updates retain admission order and terminal history is bounded without dropping active work", () => {
  let state = initialChatResponseState;
  state = reduceChatResponseState(state, {
    type: "snapshot",
    scope: "room",
    scopeId: "room",
    responses: [
      response({ requestId: "first", updatedAt: 1 }),
      response({ requestId: "second", updatedAt: 2 }),
    ],
  });
  state = reduceChatResponseState(state, {
    type: "state",
    scope: "room",
    scopeId: "room",
    response: response({
      requestId: "first",
      updatedAt: 99,
      status: "streaming",
      content: "updated",
    }),
  });
  assert.deepEqual(
    responsesForScope(state, "room", "room").map((item) => item.requestId),
    ["first", "second"],
  );

  state = reduceChatResponseState(state, {
    type: "snapshot",
    scope: "npc",
    scopeId: "npc",
    responses: [
      response({ requestId: "active", status: "thinking" }),
      ...Array.from({ length: 105 }, (_, index) =>
        response({ requestId: `done-${index}`, status: "complete", updatedAt: index + 2 }),
      ),
    ],
  });
  const bounded = responsesForScope(state, "npc", "npc");
  assert.equal(bounded.length, 101);
  assert.equal(bounded[0].requestId, "active");
  assert.equal(
    bounded.some((item) => item.requestId === "done-0"),
    false,
  );
});

test("a fresh untracked legacy chunk appends instead of overwriting the previous completed NPC answer", () => {
  const messages: NpcChatMessage[] = [{ role: "npc", content: "old answer" }];
  assert.deepEqual(
    upsertLegacyNpcChunk(messages, "error", false).map((message) => message.content),
    ["old answer", "error"],
  );
  assert.deepEqual(
    upsertLegacyNpcChunk(messages, "continued", true).map((message) => message.content),
    ["continued"],
  );
});

test("an empty authoritative snapshot removes cancelled transient rows after a local reset", () => {
  const cancelled = response({ requestId: "cancelled", status: "cancelled", content: "partial" });
  const recreated = reconcileNpcResponseMessages([], [cancelled]);
  assert.equal(recreated.length, 1);
  assert.equal(recreated[0].responseTransient, true);
  assert.deepEqual(reconcileNpcResponseMessages(recreated, [], { replaceTransient: true }), []);
});

test("a complete tracked reply becomes persistent and survives later empty snapshots", () => {
  const complete = response({ requestId: "complete", status: "complete", content: "final" });
  const messages = reconcileNpcResponseMessages([], [complete]);
  assert.equal(messages[0].responseTransient, false);
  assert.deepEqual(
    reconcileNpcResponseMessages(messages, [], { replaceTransient: true }),
    messages,
  );
});

test("map phases merge concurrent requests and discard stale duplicate active records", () => {
  const phases = npcPresentationPhases({
    rooms: {
      room: [
        response({ requestId: "a", status: "thinking", updatedAt: 1 }),
        response({ requestId: "b", status: "queued" }),
      ],
    },
    npcs: { npc: [response({ requestId: "a", status: "complete", updatedAt: 2 })] },
  });
  assert.deepEqual(phases, { "npc-1": "queued" });
  assert.deepEqual(
    npcPresentationPhases({
      rooms: {
        room: [
          response({ requestId: "a", status: "streaming" }),
          response({ requestId: "b", status: "thinking" }),
        ],
      },
      npcs: {},
    }),
    { "npc-1": "streaming" },
  );
  assert.deepEqual(
    npcPresentationPhases(
      reduceChatResponseState(
        { rooms: { room: [response({ requestId: "a" })] }, npcs: {} },
        { type: "disconnect" },
      ),
    ),
    {},
  );
});

test("an employee is marked failed only while their latest response is the failed one", () => {
  let state = initialChatResponseState;
  const put = (over: Partial<ChatResponse> & Pick<ChatResponse, "requestId">) => {
    state = reduceChatResponseState(state, {
      type: "state",
      scope: "npc",
      scopeId: over.npcId ?? "npc-1",
      response: response(over),
    });
  };
  put({ requestId: "r1", status: "failed", updatedAt: 1 });
  put({ requestId: "r2", npcId: "npc-2", status: "complete", updatedAt: 1 });
  assert.deepEqual([...npcResponseFailures(state)], ["npc-1"]);

  // Trying again replaces the failure as the latest response.
  put({ requestId: "r3", status: "queued", updatedAt: 2 });
  assert.deepEqual([...npcResponseFailures(state)], []);
});
