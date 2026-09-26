import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathParamsContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { I18nProvider } from "@/lib/i18n";
import EmployeeDetailPage from "./[name]/page";

// The persona and model editor (the hire wizard in edit mode) is the gateway owner's only — the
// server refuses a shared user's PUT with 403 — so a shared user must not be shown it at all.
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

async function render(isOwner: boolean) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const data =
      url.startsWith("/api/gateways?") || url === "/api/gateways"
        ? {
            gateways: [
              {
                id: "gw-1",
                displayName: "GW",
                isOwner,
                pluginStatus: "plugin_ready",
                pluginCheckedAt: new Date().toISOString(),
              },
            ],
          }
        : url === "/api/gateways/gw-1/profiles"
          ? {
              profiles: [
                {
                  id: "p-1",
                  profileName: "sophie",
                  displayName: "소피",
                  lastValidationStatus: "ok",
                },
              ],
            }
          : url === "/api/gateways/gw-1/test"
            ? { plugin: { status: "plugin_ready" } }
            : url.endsWith("/identity")
              ? { body: "나는 소피다", isDefaultTemplate: false, revision: "r1" }
              : url.endsWith("/config")
                ? {
                    model: "gpt-5",
                    provider: "openai-codex",
                    toolsets: null,
                    reasoning_effort: null,
                  }
                : url.endsWith("/catalog")
                  ? { providers: [], models: {}, reasoningEfforts: [] }
                  : {};
    return { ok: true, status: 200, json: async () => data } as Response;
  }) as typeof fetch;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <PathParamsContext.Provider value={{ name: "sophie" }}>
          <SearchParamsContext.Provider value={new URLSearchParams("gateway=gw-1")}>
            <I18nProvider initialLocale="ko">
              <EmployeeDetailPage />
            </I18nProvider>
          </SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return {
    el,
    cleanup: async () => {
      await act(async () => root.unmount());
      el.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test("a shared user sees the employee but no persona or model editor", async () => {
  const { el, cleanup } = await render(false);
  try {
    const text = el.textContent ?? "";
    assert.match(text, /소피/);
    assert.doesNotMatch(text, /AI 모델/);
    assert.doesNotMatch(text, /인격/);
  } finally {
    await cleanup();
  }
});

test("the gateway owner gets the persona and model editor", async () => {
  const { el, cleanup } = await render(true);
  try {
    const text = el.textContent ?? "";
    assert.match(text, /AI 모델/);
    assert.match(text, /인격/);
  } finally {
    await cleanup();
  }
});
