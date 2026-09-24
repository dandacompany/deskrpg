import "../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import NpcRoster, { type RosterNpc } from "./NpcRoster";

/**
 * The roster draws not "NPCs on the map" but **every profile the channel employs**.
 * A clocked-in employee always has a spot (a seat number or "standing") — there is no
 * "unassigned seat".
 */
const roster: RosterNpc[] = [
  {
    id: "a",
    name: "소피",
    active: true,
    placed: true,
    seatNumber: 3,
    profile: { ownerUserId: "me" },
  },
  {
    id: "b",
    name: "올리버",
    active: true,
    placed: true,
    seatNumber: null,
    profile: { ownerUserId: "me" },
  },
  {
    id: "c",
    name: "미아",
    active: false,
    placed: true,
    seatNumber: 1,
    profile: { ownerUserId: "someone" },
  },
];

async function mount(node: React.ReactElement): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { root, el };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `"${text}" 버튼을 찾지 못했다`);
  return found as HTMLButtonElement;
}

test("a clocked-in employee shows a seat number or a 'standing' button, and there is no 'unassigned seat'", async () => {
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <NpcRoster
        npcs={roster}
        meetingNpcIds={new Set()}
        isOwner
        currentUserId="me"
        onToggle={() => {}}
        onPlace={() => {}}
        onHire={() => {}}
      />
    </I18nProvider>,
  );
  const text = el.textContent ?? "";
  assert.match(text, /3번 자리/);
  assert.match(text, /서 있음/);
  assert.match(text, /쉬는 중/);
  assert.doesNotMatch(text, /자리 미정/);
});

test("clicking the seat button calls onPlace, and the toggle is disabled while in a meeting", async () => {
  const placed: string[] = [];
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <NpcRoster
        npcs={roster}
        meetingNpcIds={new Set(["a"])}
        isOwner
        currentUserId="me"
        onToggle={() => {}}
        onPlace={(id) => placed.push(id)}
        onHire={() => {}}
      />
    </I18nProvider>,
  );
  await act(async () => buttonByText(el, "서 있음").click());
  assert.deepEqual(placed, ["b"]);
  const toggleA = el.querySelector('[data-testid="toggle-a"]') as HTMLButtonElement;
  assert.equal(toggleA.disabled, true);
  assert.match(toggleA.title, /회의/);
  const toggleB = el.querySelector('[data-testid="toggle-b"]') as HTMLButtonElement;
  assert.equal(toggleB.disabled, false);
});

test("in multi-select mode, starts a group chat with the checked clocked-in NPCs", async () => {
  const started: string[][] = [];
  const { el } = await mount(
    <I18nProvider>
      <NpcRoster
        npcs={roster}
        meetingNpcIds={new Set()}
        isOwner
        currentUserId="me"
        onToggle={() => {}}
        onPlace={() => {}}
        onHire={() => {}}
        onStartGroupChat={(ids) => started.push(ids)}
      />
    </I18nProvider>,
  );
  buttonByText(el, "여러 명 선택").click();
  await act(async () => {});
  const boxes = [
    ...el.querySelectorAll('input[type="checkbox"][data-npc-id]'),
  ] as HTMLInputElement[];
  assert.deepEqual(
    boxes.map((b) => b.dataset.npcId),
    ["a", "b"],
    "쉬는 중(c) 은 후보가 아니다",
  );
  await act(async () => {
    boxes[0].click();
    boxes[1].click();
  });
  buttonByText(el, "그룹 대화 시작").click();
  assert.deepEqual(started, [["a", "b"]]);
});

test("shows the owner for someone else's profile", async () => {
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <NpcRoster
        npcs={roster}
        meetingNpcIds={new Set()}
        isOwner
        currentUserId="me"
        onToggle={() => {}}
        onPlace={() => {}}
        onHire={() => {}}
      />
    </I18nProvider>,
  );
  assert.match(el.textContent ?? "", /공유됨/);
});
