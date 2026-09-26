import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import type { DmThreadEntry } from "@/lib/dm-threads";
import WorkspaceNavigator from "./WorkspaceNavigator";

const base: RoomSummary = {
  id: "office",
  kind: "office",
  name: "office",
  replyPolicy: "mention",
  createdBy: "owner",
  lastMessageAt: null,
  members: [],
};

const dm = (npcId: string, unread: number): DmThreadEntry => ({
  npcId,
  npcName: npcId === "sophie" ? "소피" : "레오",
  active: true,
  lastMessage: { role: "npc", content: "완료했어요" },
  lastAt: 1,
  unread,
});

async function mount(rooms: RoomSummary[], currentRoomId: string, dmThreads: DmThreadEntry[] = []) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <WorkspaceNavigator
          workspaceName="w"
          rooms={rooms}
          currentRoomId={currentRoomId}
          players={[]}
          npcs={[]}
          isOwner
          onSelectRoom={() => {}}
          dmThreads={dmThreads}
          onSelectDm={() => {}}
          onSelectNpc={() => {}}
          onSelectPlayer={() => {}}
          onCompose={() => {}}
          onNpcAction={() => {}}
        />
      </I18nProvider>,
    );
  });
  return element;
}

const badge = (element: HTMLElement, id: string) =>
  element.querySelector(`[data-unread-badge="${id}"]`)?.textContent ?? null;

test("rooms and DMs with unread lines show a count; the open room shows none", async () => {
  const element = await mount(
    [
      { ...base, unread: 5 },
      { ...base, id: "design", kind: "group", name: "디자인", unread: 3 },
      { ...base, id: "quiet", kind: "group", name: "조용", unread: 0 },
    ],
    "office",
    [dm("sophie", 2), dm("leo", 0)],
  );
  assert.equal(badge(element, "office"), null, "the room on screen is being read");
  assert.equal(badge(element, "design"), "3");
  assert.equal(badge(element, "quiet"), null);
  assert.equal(badge(element, "dm-sophie"), "2");
  assert.equal(badge(element, "dm-leo"), null);
  const design = [...element.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("디자인"),
  );
  assert.match(design?.getAttribute("aria-label") ?? "", /읽지 않은 메시지 3개/);
});

test("the conversations heading shows the total, and large counts are capped", async () => {
  const element = await mount(
    [base, { ...base, id: "design", kind: "group", name: "디자인", unread: 120 }],
    "office",
    [dm("sophie", 2)],
  );
  assert.equal(badge(element, "design"), "99+");
  assert.equal(element.querySelector("[data-unread-total]")?.textContent, "99+");
  const none = await mount([base], "office");
  assert.equal(Boolean(none.querySelector("[data-unread-total]")), false);
});
