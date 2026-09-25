import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import CronModal from "./CronModal";
import type { CronJobView } from "./cron-api";

// R15 entry: the modal shell opened by the header button. Contains the panel; backdrop/ESC/close button call onClose.
// R30 "open history": if initialJobId is set, opens with that job selected on the run-history tab.

const NPCS = [{ npcId: "npc-a", npcName: "소피" }];

function job(id: string, name: string): CronJobView {
  return {
    id,
    npcId: "npc-a",
    npcName: "소피",
    name,
    prompt: "do",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    schedule_display: "0 9 * * *",
    repeat: true,
    enabled: true,
    state: "scheduled",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    deliver: "local",
    skills: [],
    model: null,
    provider: null,
    created_at: "2026-09-14T00:00:00Z",
    origin: { channelId: "ch1", createdByUserId: "u1" },
    editable: true,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

async function mount(node: React.ReactElement) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (/\/runs\b/.test(url))
      return json({
        runs: [
          {
            id: "run-1",
            started_at: "2026-09-14T09:00:00Z",
            ended_at: "2026-09-14T09:01:00Z",
            status: "ok",
            summary: "done",
            result_text: "결과",
          },
        ],
        limit: 20,
      });
    return json({
      jobs: [job("j1", "아침 브리핑"), job("j2", "주간 리포트")],
      timezone: "Asia/Seoul",
    });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = original;
    },
  };
}

const q = (host: HTMLElement, sel: string) => host.querySelector(sel) as HTMLElement | null;

test("cron modal — contains the panel; backdrop click/ESC/close button call onClose", async () => {
  let closed = 0;
  const { host, cleanup } = await mount(
    <CronModal channelId="ch1" npcs={NPCS} onClose={() => (closed += 1)} />,
  );
  try {
    assert.ok(q(host, '[role="dialog"]'), "대화상자가 없다");
    assert.ok(q(host, '[data-testid="cron-panel"]'), "CronPanel 이 마운트되지 않았다");
    assert.equal(host.querySelectorAll('[data-testid="cron-row"]').length, 2);

    // Clicking inside the dialog doesn't close it.
    await act(async () => q(host, '[role="dialog"]')!.click());
    assert.equal(closed, 0);
    // Clicking the backdrop closes it.
    await act(async () => q(host, '[data-testid="cron-modal-backdrop"]')!.click());
    assert.equal(closed, 1);
    // ESC also closes it.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    assert.equal(closed, 2);
    // The close button in the panel header (appears because onClose was passed).
    const closeBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "닫기",
    );
    assert.ok(closeBtn, "패널 닫기 버튼이 없다");
    await act(async () => closeBtn!.click());
    assert.equal(closed, 3);
  } finally {
    await cleanup();
  }
});

test("initialJobId — opens on the run-history tab with that job selected (R30 open history)", async () => {
  const { host, calls, cleanup } = await mount(
    <CronModal channelId="ch1" npcs={NPCS} initialJobId="j2" onClose={() => {}} />,
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    const pressed = Array.from(host.querySelectorAll('[data-testid="cron-row"] button')).find(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    assert.ok(pressed, "선택된 행이 없다");
    assert.match(pressed!.textContent ?? "", /주간 리포트/);
    assert.ok(q(host, '[data-testid="cron-detail"]'), "상세가 열리지 않았다");
    assert.ok(
      calls.some((url) => /\/jobs\/j2\/runs\b/.test(url)),
      `이력 탭이 아니라서 runs 를 읽지 않았다 — ${calls.join(", ")}`,
    );
    assert.ok(q(host, '[data-testid="cron-run"]'), "이력 행이 그려지지 않았다");
    assert.equal(q(host, '[data-testid="cron-deleted-notice"]'), null);
  } finally {
    await cleanup();
  }
});

test("initialJobId of a deleted cron says it was deleted instead of an unexplained list", async () => {
  const { host, calls, cleanup } = await mount(
    <CronModal channelId="ch1" npcs={NPCS} initialJobId="gone" onClose={() => {}} />,
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    const notice = q(host, '[data-testid="cron-deleted-notice"]');
    assert.ok(notice, "no deleted notice");
    assert.match(notice!.textContent ?? "", /삭제/);
    // The remaining crons are still listed, none selected, and no history is requested for the missing id.
    assert.equal(host.querySelectorAll('[data-testid="cron-row"]').length, 2);
    assert.equal(host.querySelector('[data-testid="cron-row"] button[aria-pressed="true"]'), null);
    assert.ok(!calls.some((url) => /\/jobs\/gone\/runs\b/.test(url)), calls.join(", "));
  } finally {
    await cleanup();
  }
});
