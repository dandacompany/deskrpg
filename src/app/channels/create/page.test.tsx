import "../../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { I18nProvider } from "@/lib/i18n";
import CreateChannelPage from "./page";

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};
const gateways = [
  { id: "gw-1", displayName: "First", baseUrl: "https://first.example" },
  { id: "gw-2", displayName: "Second", baseUrl: "https://second.example" },
];

async function render(query: string) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const data =
      url === "/api/gateways"
        ? { gateways }
        : url === "/api/groups"
          ? { groups: [{ id: "group-1", name: "Group", canCreateChannel: true, role: "owner" }] }
          : { channel: { id: "channel-1" } };
    return { ok: true, json: async () => data } as Response;
  }) as typeof fetch;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <SearchParamsContext.Provider value={new URLSearchParams(query)}>
          <I18nProvider initialLocale="ko">
            <CreateChannelPage />
          </I18nProvider>
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    el,
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      el.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

test("authorized gateway prefill connects the created office and warns if removed", async () => {
  const { el, calls, cleanup } = await render("gatewayId=gw-2");
  try {
    const select = [...el.querySelectorAll("select")].find((element) =>
      [...element.options].some((option) => option.value === "gw-2"),
    );
    assert.ok(select);
    assert.equal(select.value, "gw-2");
    assert.doesNotMatch(el.textContent ?? "", /AI 게이트웨이를 연결하지 않으면/);
    const name = el.querySelector<HTMLInputElement>('input[maxlength="100"]');
    assert.ok(name);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(name, "Office");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      el.querySelector<HTMLFormElement>("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(calls.find((call) => call.url === "/api/channels")?.body?.gatewayConfig, {
      gatewayId: "gw-2",
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")?.set;
      setter?.call(select, "gw-1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(select.value, "gw-1", "user selection must survive the query prefill");
    const custom = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("직접"),
    );
    assert.ok(custom);
    await act(async () => custom.click());
    assert.match(el.textContent ?? "", /AI 게이트웨이를 연결하지 않으면/);
  } finally {
    await cleanup();
  }
});

test("unknown gateway query is ignored", async () => {
  const { el, cleanup } = await render("gatewayId=unknown");
  try {
    assert.match(el.textContent ?? "", /AI 게이트웨이를 연결하지 않으면/);
    assert.ok(!el.querySelector<HTMLSelectElement>('select option[value="unknown"]'));
  } finally {
    await cleanup();
  }
});
