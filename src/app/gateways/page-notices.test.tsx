/**
 * Render the **whole** gateway screen and check that the list reload after an operation does not erase the result notices.
 *
 * The notices live in child components' local state (`PluginVersionLine.inherited`, `WorkerPluginLine.enableState`).
 * If the reload turns the page into the loading screen, the children unmount and the notices vanish (2026-09-24 E2E measurement).
 * Component unit tests render without the parent and cannot see this path, so it is pinned here.
 */
import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { I18nProvider } from "@/lib/i18n/context";

import GatewayManagementPage from "./page";

type Json = Record<string, unknown>;
type Route = Json | ((call: number) => Json);

const gateway = (over: Json = {}) => ({
  id: "gw-1",
  displayName: "사무실",
  baseUrl: "http://gw.example",
  isOwner: true,
  canEditCredentials: true,
  pluginStatus: "plugin_ready",
  pluginVersion: "0.16.0",
  workerPluginWarning: null,
  workerPropagation: "enabled",
  ...over,
});

/**
 * `"METHOD path"` → response. If a function, it receives which call of that path it is (from 0) and answers.
 * `delays` is extra delay per path — if a function, it receives the call index.
 */
function mockFetch(
  routes: Record<string, Route>,
  delays: Record<string, (call: number) => number> = {},
) {
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    if (typeof init?.body === "string") (bodies[key] ??= []).push(JSON.parse(init.body));
    const route = routes[key];
    const n = counts[key] ?? 0;
    counts[key] = n + 1;
    const extra = delays[key]?.(n) ?? 0;
    if (extra > 0) await new Promise((r) => setTimeout(r, extra));
    // Answer one beat late like a real network — answering immediately lets React batch loading on/off into one,
    // the loading screen is never drawn, and the unmount defect does not show in the test.
    await new Promise((r) => setTimeout(r, 5));
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    const body = typeof route === "function" ? route(n) : route;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, bodies };
}

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement;

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}

async function renderPage() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const r = root;
  await act(async () => {
    r.render(
      <SearchParamsContext.Provider value={new URLSearchParams("gateway=gw-1")}>
        <I18nProvider initialLocale="ko">
          <GatewayManagementPage />
        </I18nProvider>
      </SearchParamsContext.Provider>,
    );
  });
  await flush();
}

async function click(el: Element | null | undefined) {
  assert.ok(el, "누를 요소가 없다");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const buttonByText = (text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

test.afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
    host.remove();
  }
  globalThis.fetch = originalFetch;
});

test("after a plugin update inherits worker propagation, '계속 켭니다 [끄기]' stays even after the list reloads, and [끄기] sends {enabled:false}", async () => {
  const log = mockFetch({
    "GET /api/gateways?refreshPlugin=1": (n) => ({
      gateways: [gateway({ pluginVersion: n === 0 ? "0.1.0" : "0.16.0" })],
    }),
    "POST /api/gateways/gw-1/plugin/update": { jobId: "job-1" },
    "GET /api/gateways/setup?job=job-1": {
      job: { status: "succeeded", steps: ["done"], workerPropagationInherited: true },
    },
    "POST /api/gateways/gw-1/plugin/worker-propagation": { propagation: "disabled" },
  });
  await renderPage();
  await click(buttonByText("지금 갱신") ?? host.querySelector("[data-plugin-version] ~ button"));
  // Job polling runs every 1.5 seconds.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1700));
  });
  await flush();

  assert.ok(
    log.calls.filter((c) => c === "GET /api/gateways?refreshPlugin=1").length >= 2,
    "갱신 뒤 목록을 다시 읽지 않았다",
  );
  const notice = host.querySelector("[data-worker-propagation-inherited]");
  assert.ok(notice, "재조회 뒤 '계속 켭니다' 알림이 사라졌다");
  assert.match(notice.textContent ?? "", /계속 켭니다/);

  await click([...notice.querySelectorAll("button")].find((b) => b.textContent === "끄기"));
  await flush();
  assert.deepEqual(log.bodies["POST /api/gateways/gw-1/plugin/worker-propagation"], [
    { enabled: false },
  ]);
  assert.match(
    host.querySelector("[data-worker-propagation-inherited]")?.textContent ?? "",
    /워커 적용을 껐습니다/,
  );
});

test("the [설정에서 켜기] success text stays even after the list reloads", async () => {
  const log = mockFetch({
    "GET /api/gateways?refreshPlugin=1": (n) => ({
      gateways: [gateway({ workerPropagation: n === 0 ? "disabled" : "enabled" })],
    }),
    "POST /api/gateways/gw-1/plugin/worker-propagation": { propagation: "enabled", results: [] },
  });
  await renderPage();
  await click(host.querySelector('[data-action="worker-propagation-enable"]'));
  await flush();

  assert.ok(
    log.calls.filter((c) => c === "GET /api/gateways?refreshPlugin=1").length >= 2,
    "켠 뒤 목록을 다시 읽지 않았다",
  );
  assert.deepEqual(log.bodies["POST /api/gateways/gw-1/plugin/worker-propagation"], [
    { enabled: true },
  ]);
  assert.ok(
    host.querySelector('[data-worker-propagation-result="enabled"]'),
    "재조회 뒤 켜기 성공 문구가 사라졌다",
  );
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

test("a slow reload shows '새로 읽는 중' without erasing the notices, and removes it when done", async () => {
  mockFetch(
    {
      "GET /api/gateways?refreshPlugin=1": (n) => ({
        gateways: [gateway({ workerPropagation: n === 0 ? "disabled" : "enabled" })],
      }),
      "POST /api/gateways/gw-1/plugin/worker-propagation": { propagation: "enabled", results: [] },
    },
    { "GET /api/gateways?refreshPlugin=1": (n) => (n === 0 ? 0 : 600) },
  );
  await renderPage();
  assert.ok(!host.querySelector("[data-gateways-refreshing]"), "첫 화면에 표시가 있다");
  await click(host.querySelector('[data-action="worker-propagation-enable"]'));
  await wait(450);
  const status = host.querySelector("[data-gateways-refreshing]");
  assert.ok(status, "느린 재조회인데 '새로 읽는 중' 이 없다");
  assert.equal(status.getAttribute("role"), "status");
  assert.match(status.textContent ?? "", /새로 읽는 중/);
  assert.ok(
    host.querySelector('[data-worker-propagation-result="enabled"]'),
    "재조회 중에 알림이 사라졌다",
  );
  await wait(300);
  await flush();
  assert.ok(!host.querySelector("[data-gateways-refreshing]"), "끝났는데 표시가 남았다");
  assert.ok(host.querySelector('[data-worker-propagation-result="enabled"]'));
});

test("a fast reload does not flash '새로 읽는 중'", async () => {
  const seen: boolean[] = [];
  mockFetch({
    "GET /api/gateways?refreshPlugin=1": (n) => ({
      gateways: [gateway({ workerPropagation: n === 0 ? "disabled" : "enabled" })],
    }),
    "POST /api/gateways/gw-1/plugin/worker-propagation": { propagation: "enabled", results: [] },
  });
  await renderPage();
  const observer = new MutationObserver(() => {
    seen.push(host.querySelector("[data-gateways-refreshing]") !== null);
  });
  observer.observe(host, { childList: true, subtree: true });
  await click(host.querySelector('[data-action="worker-propagation-enable"]'));
  await flush();
  await wait(400);
  observer.disconnect();
  assert.equal(seen.includes(true), false, "짧은 재조회에 표시가 깜빡였다");
});
