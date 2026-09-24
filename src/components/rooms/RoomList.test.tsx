import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import RoomList from "./RoomList";
import type { RoomSummary } from "@/lib/chat-rooms-policy";

const office: RoomSummary = {
  id: "o",
  kind: "office",
  name: "office",
  replyPolicy: "mention",
  createdBy: "u",
  lastMessageAt: null,
  members: [],
};
const g1: RoomSummary = {
  ...office,
  id: "g1",
  kind: "group",
  name: "기획",
  replyPolicy: "members",
  lastMessageAt: "2026-09-10T00:00:00Z",
  members: [{ kind: "npc", id: "a", name: "소피" }],
  lastMessage: { senderName: "소피", content: "네, 단테 님", createdAt: "2026-09-10T00:00:00Z" },
};

async function mount(node: React.ReactElement): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { root, el };
}

test("office is shown first as 'the whole office', the rest by name and last message", async () => {
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <RoomList rooms={[g1, office]} currentRoomId="o" onOpen={() => {}} onNew={() => {}} />
    </I18nProvider>,
  );
  const items = [...el.querySelectorAll('[role="listitem"]')].map((li) => li.textContent ?? "");
  assert.equal(items.length, 2);
  assert.match(items[0], /오피스 전체/);
  assert.match(items[1], /기획/);
  assert.match(items[1], /네, 단테 님/);
});

test("Clicking an item calls onOpen(roomId), [New Room] calls onNew", async () => {
  const opened: string[] = [];
  let created = 0;
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <RoomList
        rooms={[office, g1]}
        currentRoomId="o"
        onOpen={(id) => opened.push(id)}
        onNew={() => created++}
      />
    </I18nProvider>,
  );
  await act(async () => {
    (el.querySelectorAll('[role="listitem"]')[1] as HTMLElement).click();
  });
  assert.deepEqual(opened, ["g1"]);
  const newBtn = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("새 방"));
  assert.ok(newBtn);
  await act(async () => {
    newBtn!.click();
  });
  assert.equal(created, 1);
});
