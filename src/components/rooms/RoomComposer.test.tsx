import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import RoomComposer from "./RoomComposer";

const npcs = [
  { id: "a", name: "소피" },
  { id: "b", name: "올리버" },
];
const people = [{ id: "u2", name: "제인", online: true }];

async function mount(node: React.ReactElement): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { root, el };
}

const submitBtn = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "만들기",
  ) as HTMLButtonElement;

test("Create button is disabled and a hint is shown when no NPC is picked", async () => {
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <RoomComposer
        mode="create"
        npcCandidates={npcs}
        userCandidates={people}
        presetNpcIds={[]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </I18nProvider>,
  );
  assert.equal(submitBtn(el).disabled, true);
  assert.match(el.textContent ?? "", /직원을 한 명 이상 고르세요/);
});

test("presetNpcIds are pre-checked, and submitting gives {name, npcIds, userIds}", async () => {
  const got: unknown[] = [];
  const { el } = await mount(
    <I18nProvider initialLocale="ko">
      <RoomComposer
        mode="create"
        npcCandidates={npcs}
        userCandidates={people}
        presetNpcIds={["a"]}
        onSubmit={(a) => got.push(a)}
        onCancel={() => {}}
      />
    </I18nProvider>,
  );
  const boxA = el.querySelector('input[type="checkbox"][data-npc-id="a"]') as HTMLInputElement;
  const boxB = el.querySelector('input[type="checkbox"][data-npc-id="b"]') as HTMLInputElement;
  const boxU = el.querySelector('input[type="checkbox"][data-user-id="u2"]') as HTMLInputElement;
  assert.equal(boxA.checked, true);
  await act(async () => {
    boxB.click();
    boxU.click();
  });
  const name = el.querySelector("input[type=text]") as HTMLInputElement;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(name, "유튜브 기획");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(submitBtn(el).disabled, false);
  await act(async () => {
    submitBtn(el).click();
  });
  assert.deepEqual(got, [{ name: "유튜브 기획", npcIds: ["a", "b"], userIds: ["u2"] }]);
});
