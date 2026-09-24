/**
 * 게이트웨이 화면 **전체**를 렌더해, 작업이 끝난 뒤의 목록 재조회가 결과 알림을 지우지 않는지 본다.
 *
 * 알림은 자식 컴포넌트의 지역 상태(`PluginVersionLine.inherited`, `WorkerPluginLine.enableState`)에 있다.
 * 재조회가 페이지를 로딩 화면으로 바꾸면 자식이 언마운트돼 알림이 사라진다(2026-09-24 E2E 실측).
 * 컴포넌트 단위 테스트는 부모 없이 렌더해 이 경로를 보지 못하므로 여기서 고정한다.
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

/** `"METHOD path"` → 응답. 함수면 그 경로의 몇 번째 호출인지(0부터)를 받아 답한다. */
function mockFetch(routes: Record<string, Route>) {
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
    // 실제 네트워크처럼 한 박자 늦게 답한다 — 즉시 답하면 React 가 로딩 on/off 를 한 번에 묶어
    // 로딩 화면이 그려지지 않고, 언마운트 결함이 테스트에서 드러나지 않는다.
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

test("플러그인 갱신이 워커 전파를 이어받으면, 목록을 다시 읽은 뒤에도 '계속 켭니다 [끄기]' 가 남고 [끄기] 는 {enabled:false} 를 보낸다", async () => {
  const log = mockFetch({
    "GET /api/gateways": (n) => ({
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
  // 잡 조회는 1.5초 간격이다.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1700));
  });
  await flush();

  assert.ok(
    log.calls.filter((c) => c === "GET /api/gateways").length >= 2,
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

test("[설정에서 켜기] 성공 문구는 목록을 다시 읽은 뒤에도 남는다", async () => {
  const log = mockFetch({
    "GET /api/gateways": (n) => ({
      gateways: [gateway({ workerPropagation: n === 0 ? "disabled" : "enabled" })],
    }),
    "POST /api/gateways/gw-1/plugin/worker-propagation": { propagation: "enabled", results: [] },
  });
  await renderPage();
  await click(host.querySelector('[data-action="worker-propagation-enable"]'));
  await flush();

  assert.ok(
    log.calls.filter((c) => c === "GET /api/gateways").length >= 2,
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
