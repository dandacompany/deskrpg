import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider, type Locale } from "@/lib/i18n";
import type { RoomNotice } from "@/lib/chat-rooms-policy";
import CardProposalNotice from "./CardProposalNotice";

// Whether buttons show is decided solely by `notice.resolved` — an error never removes the buttons.

type Proposal = Extract<RoomNotice, { kind: "card_proposal" }>;

const base: Proposal = {
  kind: "card_proposal",
  proposalId: "p1",
  title: "주간 보고 정리",
  summary: "금요일마다 모은다",
  npcId: "npc-1",
  npcName: "소피",
};

const LOCALES: Locale[] = ["ko", "en", "ja", "zh"];

async function render(
  node: React.ReactElement,
  locale: Locale = "ko",
): Promise<{ host: HTMLElement; cleanup: () => Promise<void> }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("before resolution there are two buttons — register and handle here", async () => {
  const { host, cleanup } = await render(
    <CardProposalNotice notice={base} onResolve={() => {}} pending={false} error={null} />,
  );
  const buttons = host.querySelectorAll("button");
  assert.equal(buttons.length, 2);
  assert.match(host.textContent!, /주간 보고 정리/);
  assert.match(host.textContent!, /금요일마다 모은다/);
  await cleanup();
});

test("each button reports its choice as-is", async () => {
  const picked: string[] = [];
  const { host, cleanup } = await render(
    <CardProposalNotice
      notice={base}
      onResolve={(choice) => picked.push(choice)}
      pending={false}
      error={null}
    />,
  );
  const buttons = Array.from(host.querySelectorAll("button"));
  await act(async () => {
    buttons[0].click();
    buttons[1].click();
  });
  assert.deepEqual(picked, ["card", "inline"]);
  await cleanup();
});

test("while pending, buttons are disabled but not removed", async () => {
  const { host, cleanup } = await render(
    <CardProposalNotice notice={base} onResolve={() => {}} pending error={null} />,
  );
  const buttons = Array.from(host.querySelectorAll("button"));
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => b.disabled));
  await cleanup();
});

test("after resolution there are no buttons and the result is shown", async () => {
  const notice: Proposal = {
    ...base,
    resolved: { choice: "card", by: "u1", at: "2026-09-21T00:00:00Z", taskId: "t1" },
  };
  const { host, cleanup } = await render(
    <CardProposalNotice notice={notice} onResolve={() => {}} pending={false} error={null} />,
  );
  assert.equal(host.querySelectorAll("button").length, 0);
  assert.match(host.textContent!, /t1/);
  await cleanup();
});

test("when resolved via handle-here, the result shows even without a taskId", async () => {
  const notice: Proposal = {
    ...base,
    resolved: { choice: "inline", by: "u1", at: "2026-09-21T00:00:00Z" },
  };
  const { host, cleanup } = await render(
    <CardProposalNotice notice={notice} onResolve={() => {}} pending={false} error={null} />,
  );
  assert.equal(host.querySelectorAll("button").length, 0);
  const line = host.querySelector("[data-testid='card-proposal-resolved']");
  assert.ok(line && line.textContent && line.textContent.trim().length > 0);
  await cleanup();
});

test("when there is an error, it shows the reason and keeps the buttons", async () => {
  const { host, cleanup } = await render(
    <CardProposalNotice
      notice={base}
      onResolve={() => {}}
      pending={false}
      error="plugin_required"
    />,
  );
  assert.equal(host.querySelectorAll("button").length, 2);
  assert.match(host.textContent!, /plugin/i);
  await cleanup();
});

test("all four locales show button labels in their own language", async () => {
  const seen = new Set<string>();
  for (const locale of LOCALES) {
    const { host, cleanup } = await render(
      <CardProposalNotice notice={base} onResolve={() => {}} pending={false} error={null} />,
      locale,
    );
    const labels = Array.from(host.querySelectorAll("button"))
      .map((b) => b.textContent ?? "")
      .join("|");
    assert.doesNotMatch(labels, /notice\.cardProposal/);
    seen.add(labels);
    await cleanup();
  }
  assert.equal(seen.size, LOCALES.length);
});

test("an already-resolved proposal (409) explains what to do instead of the raw code, and buttons remain", async () => {
  for (const locale of LOCALES) {
    const { host, cleanup } = await render(
      <CardProposalNotice
        notice={base}
        onResolve={() => {}}
        pending={false}
        error="already_resolved"
      />,
      locale,
    );
    // If the buttons disappeared, the user would have no way to act.
    assert.equal(host.querySelectorAll("button").length, 2);
    const line = host.querySelector("[data-testid='card-proposal-error']");
    assert.ok(line);
    // Neither the raw code nor a leaked translation key should show.
    assert.doesNotMatch(line.textContent!, /already_resolved/);
    assert.doesNotMatch(line.textContent!, /notice\.cardProposal/);
    await cleanup();
  }
});

test("the acceptance condition shows with a label, kept separate from the body", async () => {
  const notice: Proposal = { ...base, body: "청구서를 모은다", acceptance: "표로 정리" };
  for (const locale of LOCALES) {
    const { host, cleanup } = await render(
      <CardProposalNotice notice={notice} onResolve={() => {}} pending={false} error={null} />,
      locale,
    );
    const line = host.querySelector("[data-testid='card-proposal-acceptance']");
    assert.ok(line, `${locale}: 완료 조건 줄이 없다`);
    assert.match(line.textContent!, /표로 정리/);
    // It doesn't get mixed into the same line as the body.
    assert.doesNotMatch(line.textContent!, /청구서를 모은다/);
    // The label attaches in the viewer's own language — no translation key leaks.
    assert.doesNotMatch(line.textContent!, /notice\.cardProposal/);
    assert.ok(line.textContent!.replace("표로 정리", "").trim().length > 0);
    await cleanup();
  }
});

test("when the screen can't handle it, it states the reason — not just disabled buttons", async () => {
  for (const locale of LOCALES) {
    const { host, cleanup } = await render(
      <CardProposalNotice
        notice={base}
        onResolve={() => {}}
        pending={false}
        unavailable
        error={null}
      />,
      locale,
    );
    const line = host.querySelector("[data-testid='card-proposal-unavailable']");
    assert.ok(line, `${locale}: 이유 줄이 없다 — 비활성 버튼만 남으면 로딩처럼 보인다`);
    assert.doesNotMatch(line.textContent!, /notice\.cardProposal/);
    assert.ok(line.textContent!.trim().length > 0);
    // The buttons don't disappear — they remain, just disabled.
    const buttons = [...host.querySelectorAll("button")];
    assert.equal(buttons.length, 2);
    assert.ok(
      buttons.every((b) => (b as HTMLButtonElement).disabled),
      `${locale}: 처리 불가인데 버튼이 눌린다`,
    );
    await cleanup();
  }
});

test("pending and unavailable are different states — no reason line while a request is in flight", async () => {
  const { host, cleanup } = await render(
    <CardProposalNotice notice={base} onResolve={() => {}} pending error={null} />,
  );
  assert.equal(host.querySelector("[data-testid='card-proposal-unavailable']"), null);
  assert.ok(
    [...host.querySelectorAll("button")].every((b) => (b as HTMLButtonElement).disabled),
    "요청 중에는 버튼이 비활성이어야 한다",
  );
  await cleanup();
});
