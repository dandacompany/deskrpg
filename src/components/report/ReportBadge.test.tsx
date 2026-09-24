import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ReportItem } from "@/game/report-queue";
import { I18nProvider } from "@/lib/i18n";

import ReportBadge from "./ReportBadge";

const report = (messageId: string, npcName: string, cardTitle: string): ReportItem => ({
  messageId,
  npcId: npcName,
  npcName,
  kind: "card_done",
  cardId: `c-${messageId}`,
  boardSlug: "b",
  jobId: null,
  cardTitle,
  summary: "",
  createdAt: "2026-09-21T01:00:00Z",
});

async function mount(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return { el, rerender: (next: React.ReactElement) => act(async () => root.render(next)) };
}

async function click(node: Element | null) {
  assert.ok(node);
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

test("Clicking the badge opens the remaining report list instead of the kanban, and Open hands off just that one report", async () => {
  const opened: string[] = [];
  const recalled: string[] = [];
  const queue = [report("m1", "올리버", "본문 초안"), report("m2", "소피", "최종 검수")];
  const view = (items: ReportItem[]) => (
    <I18nProvider>
      <ReportBadge
        queue={items}
        current={null}
        dismissedIds={new Set(["m2"])}
        onOpen={(item) => opened.push(item.messageId)}
        onRecall={(item) => recalled.push(item.messageId)}
      />
    </I18nProvider>
  );
  const { el, rerender } = await mount(view(queue));
  assert.equal(el.querySelector('[data-testid="report-list"]'), null);
  await click(el.querySelector('[data-testid="report-badge"]'));
  const rows = el.querySelectorAll('[data-testid="report-list-item"]');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent ?? "", /올리버/);
  assert.match(rows[0].textContent ?? "", /본문 초안/);
  // Only a dismissed report has "다시 부르기" (recall).
  assert.equal(rows[0].querySelector('[data-testid="report-list-recall"]'), null);
  await click(rows[1].querySelector('[data-testid="report-list-recall"]'));
  await click(rows[0].querySelector('[data-testid="report-list-open"]'));
  assert.deepEqual(opened, ["m1"]);
  assert.deepEqual(recalled, ["m2"]);

  // If the last report is confirmed while the list stays open, show the empty-list state.
  await rerender(view([]));
  assert.ok(el.querySelector('[data-testid="report-list-empty"]'));
});
