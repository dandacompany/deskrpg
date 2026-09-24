import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import ChatBubble from "./ChatBubble";

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  // The NPC bubble renders markdown, and that renderer translates the download label (`chat.download`).
  await act(async () => root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>));
  return el;
}

test("the other party's bubble puts the avatar on the left — a slot exists even if appearance is unknown", async () => {
  const el = await mount(
    <ChatBubble sender="npc" name="noah" avatar={null}>
      안녕하세요
    </ChatBubble>,
  );
  const avatar = el.querySelector("[data-chat-avatar]");
  assert.ok(avatar, "아바타가 없다");
  assert.equal(avatar.getAttribute("data-chat-avatar"), "shown");
  const bubble = el.querySelector("[data-chat-bubble]")!;
  assert.ok(
    avatar.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING,
    "아바타가 말풍선 앞(왼쪽)에 와야 한다",
  );
});

test("a continued bubble from the same speaker gets an empty slot of the same width instead of an avatar", async () => {
  const el = await mount(
    <ChatBubble sender="npc" name="noah" avatar={null} continued>
      이어서 말합니다
    </ChatBubble>,
  );
  const slot = el.querySelector("[data-chat-avatar]");
  assert.ok(slot, "정렬용 자리가 없다");
  assert.equal(slot.getAttribute("data-chat-avatar"), "spacer");
  assert.equal(slot.querySelector("img, span"), null, "빈 자리에는 아무것도 그리지 않는다");
  assert.equal(el.textContent?.includes("noah"), false, "연속 말풍선은 이름도 되풀이하지 않는다");
});

test("my own bubble has no avatar", async () => {
  const el = await mount(
    <ChatBubble sender="player" avatar={null}>
      내가 보낸 말
    </ChatBubble>,
  );
  assert.equal(el.querySelector("[data-chat-avatar]"), null);
});

test("not passing avatar behaves like before — no avatar slot either", async () => {
  const el = await mount(
    <ChatBubble sender="npc" name="noah">
      예전 호출부
    </ChatBubble>,
  );
  assert.equal(el.querySelector("[data-chat-avatar]"), null);
  assert.ok(el.textContent?.includes("noah"));
});
