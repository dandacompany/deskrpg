import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import type { DmThreadEntry } from "@/lib/dm-threads";
import WorkspaceNavigator, { type NavigatorNpc } from "./WorkspaceNavigator";

const rooms: RoomSummary[] = [
  {
    id: "office",
    kind: "office",
    name: "출판사",
    replyPolicy: "mention",
    createdBy: "owner",
    lastMessageAt: null,
    members: [],
  },
  {
    id: "design",
    kind: "group",
    name: "디자인 리뷰",
    replyPolicy: "members",
    createdBy: "owner",
    lastMessageAt: "2026-09-14T01:00:00Z",
    members: [{ kind: "npc", id: "sophie", name: "소피" }],
  },
];

const npcs: NavigatorNpc[] = [
  {
    id: "sophie",
    name: "소피",
    active: true,
    placed: true,
    motion: "waiting",
    calledByViewer: true,
    response: "thinking",
  },
  {
    id: "leo",
    name: "레오",
    active: false,
    placed: true,
    motion: "resting",
    calledByViewer: false,
  },
  {
    id: "mina",
    name: "미나",
    active: true,
    placed: false,
    motion: "unplaced",
    calledByViewer: false,
  },
];

async function mount(
  isOwner = true,
  customNpcs: NavigatorNpc[] = npcs,
  dmThreads: DmThreadEntry[] = [],
) {
  const selected: string[] = [];
  const actions: string[] = [];
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="ko">
        <WorkspaceNavigator
          workspaceName="출판사"
          rooms={rooms}
          currentRoomId="office"
          players={[{ id: "u2", name: "은채", online: true, self: false }]}
          npcs={customNpcs}
          isOwner={isOwner}
          onSelectRoom={(id) => selected.push(`room:${id}`)}
          dmThreads={dmThreads}
          onSelectDm={(id) => selected.push(`dm:${id}`)}
          onSelectNpc={(id) => selected.push(`npc:${id}`)}
          onSelectPlayer={(id) => selected.push(`player:${id}`)}
          onCompose={() => actions.push("compose")}
          onNpcAction={(id, action) => actions.push(`${id}:${action}`)}
        />
      </I18nProvider>,
    );
  });
  return { element, selected, actions };
}

function button(element: HTMLElement, name: string) {
  const found = [...element.querySelectorAll("button")].find((node) =>
    (node.getAttribute("aria-label") ?? node.textContent ?? "").includes(name),
  );
  assert.ok(found, `button containing ${name}`);
  return found as HTMLButtonElement;
}

test("rooms, online users and every NPC employment state remain discoverable", async () => {
  const { element, selected } = await mount();
  assert.match(element.textContent ?? "", /오피스 전체/);
  assert.match(element.textContent ?? "", /디자인 리뷰/);
  assert.match(element.textContent ?? "", /소피[\s\S]*대기/);
  assert.match(element.textContent ?? "", /레오[\s\S]*쉬는 중/);
  assert.match(element.textContent ?? "", /미나[\s\S]*서 있음/);

  await act(async () => button(element, "디자인 리뷰").click());
  await act(async () => button(element, "은채").click());
  await act(async () => button(element, "소피").click());
  assert.deepEqual(selected, ["room:design", "player:u2", "npc:sophie"]);
});

test("NPC overflow actions follow motion state and owner permissions", async () => {
  const owner = await mount(true);
  await act(async () => button(owner.element, "소피 관리").click());
  assert.ok(button(owner.element, "복귀"));
  assert.ok(button(owner.element, "자리 이동"));
  assert.ok(button(owner.element, "프로필 설정"));
  assert.ok(button(owner.element, "대화 초기화"));
  assert.ok(button(owner.element, "퇴근"));
  await act(async () => button(owner.element, "복귀").click());
  assert.deepEqual(owner.actions, ["sophie:return"]);

  const member = await mount(false);
  await act(async () => button(member.element, "소피 관리").click());
  assert.equal(
    [...member.element.querySelectorAll("button")].some((node) =>
      node.textContent?.includes("자리 이동"),
    ),
    false,
  );
  assert.ok(button(member.element, "대화 초기화"));
});

test("seat number shows in the roster detail, standing when unseated, resting hides the seat", async () => {
  const seatedAvailable: NavigatorNpc = {
    id: "iris",
    name: "아이리스",
    active: true,
    placed: true,
    motion: "idle",
    calledByViewer: false,
    seatNumber: 3,
  };
  const standingActive: NavigatorNpc = {
    id: "noah",
    name: "노아",
    active: true,
    placed: true,
    motion: "idle",
    calledByViewer: false,
    seatNumber: null,
  };
  const dormantSeated: NavigatorNpc = {
    id: "dana",
    name: "다나",
    active: false,
    placed: true,
    motion: "resting",
    calledByViewer: false,
    seatNumber: 1,
  };

  const { element } = await mount(true, [seatedAvailable, standingActive, dormantSeated]);
  assert.match(element.textContent ?? "", /아이리스[\s\S]*3번 자리 · /);
  assert.match(element.textContent ?? "", /노아[\s\S]*서 있음/);
  const dormantSection = element.textContent ?? "";
  const danaIndex = dormantSection.indexOf("다나");
  assert.match(dormantSection.slice(danaIndex, danaIndex + 40), /쉬는 중/);
  assert.ok(!dormantSection.slice(danaIndex, danaIndex + 40).includes("번 자리"));
});

test("the owner menu keeps the move-seat action and drops the removed place action", async () => {
  const owner = await mount(true);
  await act(async () => button(owner.element, "소피 관리").click());
  assert.ok(button(owner.element, "자리 이동"));
  const labels = [...owner.element.querySelectorAll("[role='menuitem']")].map(
    (node) => node.textContent ?? "",
  );
  assert.equal(
    labels.some((label) => label.includes("자리 지정")),
    false,
  );
});

// This card's flaw: the history stays, but **without an entry point in the list**, continuing
// the conversation required finding and clicking that staff member on the map again. The list
// should get a row, and that row should be the path to opening the DM.
const dmThreads: DmThreadEntry[] = [
  {
    npcId: "sophie",
    npcName: "소피",
    active: true,
    lastMessage: { role: "npc", content: "표지 시안 올렸어요" },
    lastAt: Date.parse("2026-09-19T05:00:00Z"),
  },
  {
    npcId: "leo",
    npcName: "레오",
    active: false,
    lastMessage: { role: "player", content: "내일 이야기해요" },
    lastAt: Date.parse("2026-09-18T05:00:00Z"),
  },
];

test("a DM with a staff member stays as a row in the conversation list, and that row reopens it", async () => {
  const { element, selected } = await mount(true, npcs, dmThreads);
  const text = element.textContent ?? "";
  assert.match(text, /소피[\s\S]*표지 시안 올렸어요/);
  // When I'm the sender, the preview also shows "나:" — the same rule as the room list.
  assert.match(text, /나: 내일 이야기해요/);

  await act(async () => button(element, "소피 대화").click());
  assert.deepEqual(selected, ["dm:sophie"]);
});

test("a clocked-out staff member's conversation also stays in the list — it just shows resting", async () => {
  const { element } = await mount(true, npcs, dmThreads);
  const row = [...element.querySelectorAll("button")].find((node) =>
    (node.getAttribute("aria-label") ?? "").includes("레오 대화"),
  );
  assert.ok(row, "퇴근한 직원의 DM 줄이 없다");
  assert.match(row.textContent ?? "", /쉬는 중/);
});

test("no conversation history means no DM row", async () => {
  const { element } = await mount(true, npcs, []);
  const rows = [...element.querySelectorAll("button")].filter((node) =>
    /\S 대화$/.test(node.getAttribute("aria-label") ?? ""),
  );
  assert.deepEqual(rows, []);
});

test("an employee row lists every state that applies, and an idle one still reads available", async () => {
  const busy: NavigatorNpc = {
    id: "iris",
    name: "아이리스",
    active: true,
    placed: true,
    motion: "idle",
    calledByViewer: false,
    seatNumber: 3,
    states: ["awaiting_approval", "stopped_after_failures", "working"],
    workingCount: 2,
  };
  const idle: NavigatorNpc = {
    id: "noah",
    name: "노아",
    active: true,
    placed: true,
    motion: "idle",
    calledByViewer: false,
    seatNumber: 4,
    states: [],
  };
  const unknown: NavigatorNpc = {
    id: "mina",
    name: "미나",
    active: true,
    placed: true,
    motion: "idle",
    calledByViewer: false,
    seatNumber: 5,
    states: ["unknown"],
  };

  const { element } = await mount(true, [busy, idle, unknown]);
  const text = element.textContent ?? "";
  assert.match(text, /아이리스[\s\S]*3번 자리 · 승인 대기 · 반복 실패로 멈춤 · 작업 중 2/);
  assert.match(text, /노아[\s\S]*4번 자리 · 대화 가능/);
  assert.match(text, /미나[\s\S]*5번 자리 · 상태 확인 불가/);
});

test("a moving or waiting employee still shows every state after where they are", async () => {
  const waiting: NavigatorNpc = {
    id: "sophie",
    name: "소피",
    active: true,
    placed: true,
    motion: "waiting",
    calledByViewer: true,
    seatNumber: null,
    states: ["stopped_after_failures"],
  };
  const moving: NavigatorNpc = {
    id: "oliver",
    name: "올리버",
    active: true,
    placed: true,
    motion: "moving",
    calledByViewer: false,
    seatNumber: null,
    states: ["unknown"],
  };
  const { element } = await mount(true, [waiting, moving]);
  const text = element.textContent ?? "";
  assert.match(text, /소피[\s\S]*서 있음 · 내 호출에 대기 · 반복 실패로 멈춤/);
  assert.match(text, /올리버[\s\S]*서 있음 · 이동 중 · 상태 확인 불가/);
});
