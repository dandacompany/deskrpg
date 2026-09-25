import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import CronPanel, { type CronEventSource } from "./CronPanel";
import type { CronJobView } from "./cron-api";

const NPCS = [
  { npcId: "npc-a", npcName: "소피" },
  { npcId: "npc-b", npcName: "제인" },
];

function job(overrides: Partial<CronJobView> & { id: string; npcId: string }): CronJobView {
  const npc = NPCS.find((n) => n.npcId === overrides.npcId)!;
  return {
    name: `job ${overrides.id}`,
    prompt: "do the thing",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    schedule_display: "0 9 * * *",
    repeat: true,
    enabled: true,
    state: "scheduled",
    next_run_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    last_run_at: null,
    last_status: null,
    last_error: null,
    deliver: "local",
    skills: [],
    model: null,
    provider: null,
    created_at: "2026-09-14T00:00:00Z",
    npcName: npc.npcName,
    origin: { channelId: "ch1", createdByUserId: "u1" },
    editable: true,
    ...overrides,
  };
}

type Call = { url: string; method: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake fetch that decides the response per URL. Records call history. */
function router(routes: (url: string, method: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return routes(url, method);
  }) as typeof fetch;
  return { calls, handler };
}

class FakeSocket implements CronEventSource {
  handlers = new Map<string, Set<(payload: unknown) => void>>();
  on(event: string, handler: (payload: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  off(event: string, handler: (payload: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
}

async function mount(
  node: React.ReactElement,
  fetchImpl: typeof fetch,
): Promise<{ host: HTMLElement; cleanup: () => Promise<void> }> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>);
  });
  // Run one more tick so the initial fetch finishes.
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = original;
    },
  };
}

const byTestId = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const allByTestId = (host: HTMLElement, id: string) =>
  Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];

async function click(node: Element | null) {
  assert.ok(node, "클릭할 요소가 없다");
  await act(async () => {
    (node as HTMLElement).click();
  });
}

test("timezone label — 'as of' when the response has a timezone, otherwise unknown (R18/E9)", async () => {
  const withTz = router(() => json(200, { jobs: [], timezone: "Asia/Seoul" }));
  const a = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, withTz.handler);
  assert.equal(byTestId(a.host, "cron-tz")?.textContent, "Asia/Seoul 기준");
  await a.cleanup();

  const noTz = router(() => json(200, { jobs: [], timezone: null }));
  const b = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, noTz.handler);
  assert.equal(byTestId(b.host, "cron-tz")?.textContent, "게이트웨이 시간대 미확인");
  await b.cleanup();
});

test("list row — state dot/name/schedule/NPC name/countdown, plus NPC filter and search (R15)", async () => {
  const jobs = [
    job({ id: "j1", npcId: "npc-a", name: "아침 브리핑" }),
    job({ id: "j2", npcId: "npc-b", name: "주간 리포트", state: "paused", prompt: "weekly" }),
  ];
  const r = router(() => json(200, { jobs, timezone: "Asia/Seoul" }));
  const { host, cleanup } = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, r.handler);
  try {
    let rows = allByTestId(host, "cron-row");
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent ?? "", /아침 브리핑/);
    assert.match(rows[0].textContent ?? "", /소피/);
    assert.match(rows[0].textContent ?? "", /0 9 \* \* \*/);
    assert.equal(byTestId(rows[0], "cron-state-dot")?.dataset.state, "scheduled");
    assert.ok(byTestId(rows[0], "cron-state-dot")?.className.includes("bg-success"));
    // 5 minutes out -> relative-time countdown
    assert.match(byTestId(rows[0], "cron-countdown")?.textContent ?? "", /5분/);
    // A paused job shows a status label instead of a countdown
    assert.equal(byTestId(rows[1], "cron-countdown")?.textContent, "멈춤");
    assert.equal(byTestId(rows[1], "cron-state-dot")?.dataset.state, "paused");

    // NPC filter
    const filter = byTestId(host, "cron-filter-npc") as HTMLSelectElement;
    await act(async () => {
      filter.value = "npc-b";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    rows = allByTestId(host, "cron-row");
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent ?? "", /주간 리포트/);

    // Search (also checks the prompt)
    await act(async () => {
      filter.value = "";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const search = byTestId(host, "cron-search") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(search, "weekly");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    rows = allByTestId(host, "cron-row");
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent ?? "", /주간 리포트/);

    // The list fetch hits the channel route once, regardless of filters
    assert.deepEqual(
      r.calls.map((c) => c.url),
      ["/api/channels/ch1/cron/jobs"],
    );
  } finally {
    await cleanup();
  }
});

test("single-NPC mode — fetches by npcId and has no NPC filter", async () => {
  const r = router(() => json(200, { jobs: [job({ id: "j1", npcId: "npc-a" })], timezone: null }));
  const { host, cleanup } = await mount(
    <CronPanel channelId="ch1" npcs={NPCS} npc={NPCS[0]} />,
    r.handler,
  );
  try {
    assert.equal(r.calls[0].url, "/api/channels/ch1/cron/jobs?npcId=npc-a");
    assert.equal(byTestId(host, "cron-filter-npc"), null);
    assert.equal(allByTestId(host, "cron-row").length, 1);
  } finally {
    await cleanup();
  }
});

test("when editable=false all action buttons are disabled and the reason is shown (R16)", async () => {
  const jobs = [
    job({
      id: "other",
      npcId: "npc-a",
      editable: false,
      origin: { channelId: "ch9", createdByUserId: null },
    }),
    job({ id: "ext", npcId: "npc-a", editable: false, origin: null }),
  ];
  const r = router(() => json(200, { jobs, timezone: "Asia/Seoul" }));
  const { host, cleanup } = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, r.handler);
  try {
    await click(allByTestId(host, "cron-row")[0].querySelector("button"));
    for (const id of [
      "cron-action-edit",
      "cron-action-pause",
      "cron-action-run",
      "cron-action-delete",
    ]) {
      const btn = byTestId(host, id) as HTMLButtonElement;
      assert.equal(btn.disabled, true, id);
      assert.match(btn.title, /다른 오피스/);
    }
    assert.match(byTestId(host, "cron-readonly-reason")?.textContent ?? "", /다른 오피스에서 만든/);

    // Clicking a disabled button sends no request.
    await click(byTestId(host, "cron-action-run"));
    assert.equal(r.calls.filter((c) => c.method === "POST").length, 0);

    await click(allByTestId(host, "cron-row")[1].querySelector("button"));
    assert.match(byTestId(host, "cron-readonly-reason")?.textContent ?? "", /DeskRPG 밖/);
  } finally {
    await cleanup();
  }
});

test("428 plugin_upgrade_required -> update notice and install command (R31)", async () => {
  const r = router(() =>
    json(428, { code: "plugin_upgrade_required", message: "old", minVersion: "0.6.0" }),
  );
  const { host, cleanup } = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, r.handler);
  try {
    const notice = byTestId(host, "cron-error-upgrade");
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /플러그인 업데이트 필요/);
    assert.match(notice.textContent ?? "", /0\.6\.0/);
    assert.match(
      notice.textContent ?? "",
      /hermes plugins install https:\/\/github\.com\/dandacompany\/deskrpg-hermes-plugin && hermes plugins enable deskrpg/,
    );
    assert.equal(byTestId(host, "cron-error-gateway"), null);
  } finally {
    await cleanup();
  }
});

test("409 gateway_not_bound -> gateway connection notice, other errors pass code/message through (R32)", async () => {
  const a = router(() => json(409, { code: "gateway_not_bound", message: "no gw" }));
  const first = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, a.handler);
  assert.match(byTestId(first.host, "cron-error-gateway")?.textContent ?? "", /게이트웨이/);
  await first.cleanup();

  const b = router(() => json(502, { code: "unreachable", message: "boom boom" }));
  const second = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, b.handler);
  assert.match(
    byTestId(second.host, "cron-error-other")?.textContent ?? "",
    /unreachable: boom boom/,
  );
  await second.cleanup();
});

test("run now — a 202 response only toasts, no refetch (R19)", async () => {
  const jobs = [job({ id: "j1", npcId: "npc-a", name: "브리핑" })];
  const toasts: string[] = [];
  const r = router((url) => {
    if (url.endsWith("/run")) return json(202, { accepted: true });
    return json(200, { jobs, timezone: "Asia/Seoul" });
  });
  const { host, cleanup } = await mount(
    <CronPanel channelId="ch1" npcs={NPCS} onToast={(m) => toasts.push(m)} />,
    r.handler,
  );
  try {
    await click(allByTestId(host, "cron-row")[0].querySelector("button"));
    await click(byTestId(host, "cron-action-run"));
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /브리핑/);
    assert.deepEqual(
      r.calls.map((c) => `${c.method} ${c.url}`),
      ["GET /api/channels/ch1/cron/jobs", "POST /api/channels/ch1/cron/jobs/j1/run"],
    );
  } finally {
    await cleanup();
  }
});

test("pause refetches after success, and a cron:event socket event also refetches (R26)", async () => {
  const jobs = [job({ id: "j1", npcId: "npc-a" })];
  const r = router((url) => {
    if (url.endsWith("/pause")) return json(200, { job: jobs[0] });
    return json(200, { jobs, timezone: "Asia/Seoul" });
  });
  const socket = new FakeSocket();
  const { host, cleanup } = await mount(
    <CronPanel channelId="ch1" npcs={NPCS} socket={socket} />,
    r.handler,
  );
  try {
    assert.equal(socket.handlers.get("cron:event")?.size, 1);
    await click(allByTestId(host, "cron-row")[0].querySelector("button"));
    await click(byTestId(host, "cron-action-pause"));
    assert.deepEqual(
      r.calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET /api/channels/ch1/cron/jobs",
        "POST /api/channels/ch1/cron/jobs/j1/pause",
        "GET /api/channels/ch1/cron/jobs",
      ],
    );

    await act(async () => {
      socket.emit("cron:event", { channelId: "ch1", event: { kind: "cron.run.finished" } });
    });
    assert.equal(r.calls.filter((c) => c.method === "GET").length, 3);

    // Events from other channels are ignored.
    await act(async () => {
      socket.emit("cron:event", { channelId: "other", event: {} });
    });
    assert.equal(r.calls.filter((c) => c.method === "GET").length, 3);
  } finally {
    await cleanup();
  }
  assert.equal(socket.handlers.get("cron:event")?.size, 0, "언마운트 시 구독 해제");
});

test("the run-history tab calls /runs", async () => {
  const jobs = [job({ id: "j1", npcId: "npc-a" })];
  const r = router((url) => {
    if (url.includes("/runs"))
      return json(200, {
        runs: [
          {
            id: "r1",
            started_at: "2026-09-14T00:00:00Z",
            ended_at: null,
            status: "ok",
            summary: "잘 됐어요",
            result_text: "",
          },
        ],
        limit: 20,
      });
    return json(200, { jobs, timezone: "Asia/Seoul" });
  });
  const { host, cleanup } = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, r.handler);
  try {
    await click(allByTestId(host, "cron-row")[0].querySelector("button"));
    await click(byTestId(host, "cron-tab-runs"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.ok(
      r.calls.some((c) => c.url === "/api/channels/ch1/cron/jobs/j1/runs?npcId=npc-a&limit=20"),
    );
    const runs = allByTestId(host, "cron-run");
    assert.equal(runs.length, 1);
    assert.match(runs[0].textContent ?? "", /잘 됐어요/);
  } finally {
    await cleanup();
  }
});

test("a partial NPC fetch failure (errors) shows a warning while keeping the list alive", async () => {
  const r = router(() =>
    json(200, {
      jobs: [job({ id: "j1", npcId: "npc-a" })],
      timezone: "Asia/Seoul",
      errors: [{ npcId: "npc-b", code: "timeout", message: "slow" }],
    }),
  );
  const { host, cleanup } = await mount(<CronPanel channelId="ch1" npcs={NPCS} />, r.handler);
  try {
    assert.equal(allByTestId(host, "cron-row").length, 1);
    const partial = byTestId(host, "cron-partial-errors");
    assert.match(partial?.textContent ?? "", /1개 NPC/);
    assert.match(partial?.textContent ?? "", /제인 — timeout: slow/);
  } finally {
    await cleanup();
  }
});
