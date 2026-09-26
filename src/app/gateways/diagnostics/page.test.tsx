import "../../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import GatewayDiagnosticsPage from "./page";

const REPORT = {
  environment: { errors: [], warnings: [], dbTarget: "sqlite" },
  database: { ok: true, target: "sqlite", message: "ok" },
  hostSetup: { wizard: true, hermesInstall: true },
  gateways: [],
};

async function mount(status: number) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(status === 200 ? REPORT : {}), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <GatewayDiagnosticsPage />
      </I18nProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("an admin gets the diagnostics already expanded, with a way back", async () => {
  const f = await mount(200);
  const panel = f.host.querySelector<HTMLDetailsElement>("[data-testid=diagnostics-panel]");
  assert.ok(panel, "diagnostics are shown");
  assert.equal(panel.open, true, "a page of its own opens the report instead of hiding it");
  assert.equal(f.host.querySelector("[data-back-to-gateways]")?.getAttribute("href"), "/gateways");
  await f.cleanup();
});

test("anyone else sees only the way back — the page doesn't reveal the admin report", async () => {
  const f = await mount(404);
  assert.ok(!f.host.querySelector("[data-testid=diagnostics-panel]"));
  assert.ok(f.host.querySelector("[data-back-to-gateways]"));
  await f.cleanup();
});
