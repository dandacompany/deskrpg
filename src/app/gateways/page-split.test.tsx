/**
 * `/gateways` holds the list, the connection wizard and the selected gateway's detail — sharing
 * and diagnostics live on their own pages and are only linked from here.
 */
import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { I18nProvider } from "@/lib/i18n/context";

import GatewayManagementPage from "./page";

const gateway = (over: Record<string, unknown> = {}) => ({
  id: "gw-1",
  displayName: "사무실",
  baseUrl: "http://gw.example",
  isOwner: true,
  pluginStatus: "plugin_ready",
  pluginVersion: "0.19.0",
  workerPluginWarning: null,
  workerPropagation: "enabled",
  ...over,
});

const originalFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement;
let calls: string[] = [];

function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    await new Promise((r) => setTimeout(r, 2));
    const route = routes[key];
    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route ? (route.status ?? 200) : 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
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
  for (let i = 0; i < 20; i += 1) await act(async () => new Promise((r) => setTimeout(r, 2)));
}

test.afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = null;
    host.remove();
  }
  globalThis.fetch = originalFetch;
});

const REPORT = {
  environment: { errors: [], warnings: [], dbTarget: "sqlite" },
  database: { ok: true, target: "sqlite", message: "ok" },
  hostSetup: { wizard: true, hermesInstall: true },
  gateways: [],
};

test("the owner gets a link to the gateway's share page, and no share form on this page", async () => {
  mockFetch({
    "GET /api/gateways?refreshPlugin=1": { body: { gateways: [gateway()] } },
    "GET /api/admin/diagnostics": { status: 404, body: {} },
  });
  await renderPage();
  const link = host.querySelector<HTMLAnchorElement>("[data-gateway-share-link]");
  assert.ok(link, "owner sees the share link");
  assert.equal(link.getAttribute("href"), "/gateways/gw-1/share");
  assert.ok(!host.querySelector("[data-share-login-id]"), "no share form here");
  assert.ok(!calls.includes("GET /api/gateways/gw-1/shares"), "the share list isn't loaded here");
});

test("a shared (not owned) gateway shows no share link", async () => {
  mockFetch({
    "GET /api/gateways?refreshPlugin=1": { body: { gateways: [gateway({ isOwner: false })] } },
    "GET /api/admin/diagnostics": { status: 404, body: {} },
  });
  await renderPage();
  assert.ok(!host.querySelector("[data-gateway-share-link]"));
});

test("an admin gets a link to the diagnostics page, and the report itself isn't on this page", async () => {
  mockFetch({
    "GET /api/gateways?refreshPlugin=1": { body: { gateways: [gateway()] } },
    "GET /api/admin/diagnostics": { body: REPORT },
  });
  await renderPage();
  const link = host.querySelector<HTMLAnchorElement>("[data-gateway-diagnostics-link]");
  assert.ok(link, "admin sees the diagnostics link");
  assert.equal(link.getAttribute("href"), "/gateways/diagnostics");
  assert.ok(!host.querySelector("[data-testid=diagnostics-panel]"), "no report on this page");
});

test("without diagnostics permission there is no diagnostics link", async () => {
  mockFetch({
    "GET /api/gateways?refreshPlugin=1": { body: { gateways: [gateway()] } },
    "GET /api/admin/diagnostics": { status: 404, body: {} },
  });
  await renderPage();
  assert.ok(!host.querySelector("[data-gateway-diagnostics-link]"));
});
