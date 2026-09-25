import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { MeetingOutcome } from "@/lib/meeting-outcome";
import type { OutcomeRegistration } from "@/lib/meeting-outcome-draft";

import MeetingOutcomePanel, { type MeetingOutcomePanelProps } from "./MeetingOutcomePanel";

const outcome: MeetingOutcome = {
  decisions: ["A안 채택"],
  followUps: [
    {
      title: "경쟁사 가격 조사",
      summary: "세 곳을 본다",
      acceptance: null,
      assigneeNpcId: "npc-1",
      assigneeName: "소피",
      after: [],
    },
    {
      title: "초안 작성",
      summary: null,
      acceptance: null,
      assigneeNpcId: null,
      assigneeName: "리나",
      after: [0],
    },
  ],
  project: { recommended: true, name: "가격 개편", reason: "세 단계로 이어진다" },
};

const npcs = [
  { id: "npc-1", name: "소피" },
  { id: "npc-2", name: "노아" },
];

async function mount(props: Partial<MeetingOutcomePanelProps>): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <MeetingOutcomePanel
          outcome={outcome}
          summaryStatus="ok"
          npcs={npcs}
          canRegister
          registerSupported
          registered={null}
          onRegister={async () => {}}
          onRetrySummary={async () => {}}
          {...props}
        />
      </I18nProvider>,
    ),
  );
  return el;
}

test("renders decisions and follow-ups, and suggests bundling into a project when recommended", async () => {
  const el = await mount({});
  assert.match(el.textContent ?? "", /A안 채택/);
  assert.equal(el.querySelectorAll("[data-outcome-item]").length, 2);
  assert.ok(el.querySelector("[data-outcome-recommended]"));
  assert.equal(
    (el.querySelector("[data-outcome-subproject]") as HTMLInputElement).value,
    "가격 개편",
  );
});

test("does not render the register suggestion when there are no follow-ups", async () => {
  const el = await mount({ outcome: { ...outcome, followUps: [] } });
  assert.ok(!el.querySelector("[data-outcome-register]"));
  assert.ok(!el.querySelector("[data-outcome-item]"));
  // Decisions are still shown.
  assert.match(el.textContent ?? "", /A안 채택/);
});

test("leaves an assignee unassigned when it doesn't resolve to a participant, but shows the name the model wrote", async () => {
  const el = await mount({});
  const second = el.querySelectorAll("[data-outcome-item]")[1];
  assert.equal((second.querySelector("select") as HTMLSelectElement).value, "");
  assert.match(second.textContent ?? "", /리나/);
});

test("passes only the selected items when register is clicked", async () => {
  let sent: OutcomeRegistration | null = null;
  const el = await mount({
    onRegister: async (body) => {
      sent = body;
    },
  });
  const firstCheckbox = el.querySelector(
    "[data-outcome-item] input[type=checkbox]",
  ) as HTMLInputElement;
  await act(async () => firstCheckbox.click());
  await act(async () => (el.querySelector("[data-outcome-register]") as HTMLElement).click());
  assert.deepEqual(sent, {
    tenant: { slug: "가격-개편", name: "가격 개편" },
    // Since item 0 was dropped, item 1's `after` is cleared too.
    items: [{ index: 1, title: "초안 작성", npcId: null, after: [] }],
  });
});

test("locks the register button when nothing is selected", async () => {
  const el = await mount({});
  for (const box of el.querySelectorAll("[data-outcome-item] input[type=checkbox]"))
    await act(async () => (box as HTMLInputElement).click());
  assert.equal((el.querySelector("[data-outcome-register]") as HTMLButtonElement).disabled, true);
});

test("a registration failure stays on screen while the button remains", async () => {
  const el = await mount({
    onRegister: async () => {
      throw new Error("board_ensure_failed");
    },
  });
  await act(async () => (el.querySelector("[data-outcome-register]") as HTMLElement).click());
  assert.match(el.querySelector("[data-outcome-error]")?.textContent ?? "", /board_ensure_failed/);
  assert.ok(el.querySelector("[data-outcome-register]"));
});

test("an already-registered meeting renders the result instead of the button", async () => {
  const el = await mount({
    registered: { boardSlug: "b", tenant: "가격-개편", taskIds: ["t1", "t2"] },
  });
  assert.ok(!el.querySelector("[data-outcome-register]"));
  assert.match(el.querySelector("[data-outcome-registered]")?.textContent ?? "", /2/);
});

test("when the summary fails, it says so and offers a retry", async () => {
  let retried = 0;
  const el = await mount({
    outcome: null,
    summaryStatus: "failed",
    onRetrySummary: async () => {
      retried++;
    },
  });
  const retry = el.querySelector("[data-outcome-retry]") as HTMLElement;
  assert.ok(retry, "다시 시도 버튼이 없다");
  await act(async () => retry.click());
  assert.equal(retried, 1);
});

test("without register permission, the draft is shown but there is no register button", async () => {
  const el = await mount({ canRegister: false });
  assert.equal(el.querySelectorAll("[data-outcome-item]").length, 2);
  assert.ok(!el.querySelector("[data-outcome-register]"));
});

test("when the plugin can't create pending-approval cards, it renders an upgrade notice instead of the button and locks the draft", async () => {
  const el = await mount({ registerSupported: false });
  assert.ok(!el.querySelector("[data-outcome-register]"));
  assert.match(el.querySelector("[data-outcome-upgrade]")?.textContent ?? "", /0\.11\.0/);
  assert.equal(el.querySelectorAll("[data-outcome-item]").length, 2);
  const firstCheckbox = el.querySelector("[data-outcome-item] input[type=checkbox]");
  assert.equal((firstCheckbox as HTMLInputElement).disabled, true);
});
