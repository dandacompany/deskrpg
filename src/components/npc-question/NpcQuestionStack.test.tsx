import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";

import NpcQuestionStack from "./NpcQuestionStack";

function fakeSocket(reply: unknown = { result: "answered" }) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const sent: unknown[] = [];
  return {
    sent,
    fire(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    socket: {
      on(event: string, h: (payload: unknown) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(h);
      },
      off(event: string, h: (payload: unknown) => void) {
        handlers.get(event)?.delete(h);
      },
      emit(event: string, payload: unknown, ack?: (r: unknown) => void) {
        sent.push([event, payload]);
        ack?.(reply);
      },
    },
  };
}

const QUESTION = {
  id: "q1",
  npcId: "npc-1",
  npcName: "Noah",
  question: "어떤 형식으로 만들까요?",
  choices: ["요약", "표"],
  allowOther: false,
  createdAt: "2026-09-26T00:00:00.000Z",
};

async function render(socket: ReturnType<typeof fakeSocket>, npcId = "npc-1") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <NpcQuestionStack socket={socket.socket} npcId={npcId} />
      </I18nProvider>,
    );
  });
  return {
    host,
    fire: (event: string, payload: unknown) => act(async () => socket.fire(event, payload)),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("a question for this NPC shows its card and a choice answers over the socket", async () => {
  const s = fakeSocket();
  const f = await render(s);
  await f.fire("npc:question", { npcId: "npc-1", question: QUESTION });
  assert.match(f.host.textContent ?? "", /어떤 형식으로 만들까요\?/);
  const button = [...f.host.querySelectorAll("button")].find((b) => b.textContent === "표");
  assert.ok(button);
  await act(async () => button.click());
  assert.deepEqual(s.sent, [["npc:answer", { npcId: "npc-1", questionId: "q1", response: "표" }]]);
  assert.match(f.host.textContent ?? "", /답함: 표/);
  await f.cleanup();
});

test("another NPC's question is not shown here", async () => {
  const s = fakeSocket();
  const f = await render(s, "npc-2");
  await f.fire("npc:question", { npcId: "npc-1", question: QUESTION });
  assert.ok(!f.host.querySelector("[data-npc-question]"));
  await f.cleanup();
});

test("an answer from elsewhere marks the card answered; a closed run closes it", async () => {
  const s = fakeSocket();
  const f = await render(s);
  await f.fire("npc:question", { npcId: "npc-1", question: QUESTION });
  await f.fire("npc:question", { npcId: "npc-1", question: { ...QUESTION, id: "q2" } });
  await f.fire("npc:question-answered", { npcId: "npc-1", questionId: "q1", response: "요약" });
  await f.fire("npc:questions-closed", { npcId: "npc-1", questionIds: ["q1", "q2"] });
  const cards = [...f.host.querySelectorAll("[data-npc-question]")].map((c) => c.textContent ?? "");
  assert.equal(cards.length, 2);
  assert.match(cards[0], /답함: 요약/);
  assert.match(cards[1], /대화가 끝났어요/);
  await f.cleanup();
});
