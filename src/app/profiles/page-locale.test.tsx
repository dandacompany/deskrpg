import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { I18nProvider, type Locale } from "@/lib/i18n";
import ProfilesPage from "./page";

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

type GatewaysResponse = { ok: boolean; data: unknown };

async function render(locale: Locale, gateways: GatewaysResponse) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const { ok, data } =
      url === "/api/gateways" ? gateways : { ok: true, data: { profiles: [], npcs: [] } };
    return { ok, json: async () => data } as Response;
  }) as typeof fetch;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <SearchParamsContext.Provider value={new URLSearchParams("")}>
          <I18nProvider initialLocale={locale}>
            <ProfilesPage />
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
    cleanup: async () => {
      await act(async () => root.unmount());
      el.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

const twoGateways = {
  ok: true,
  data: {
    gateways: [
      { id: "gw-1", displayName: "First", isOwner: true },
      { id: "gw-2", displayName: "Second", isOwner: false },
    ],
  },
};

test("the employees page shows no Korean to a Japanese viewer", async () => {
  const { el, cleanup } = await render("ja", twoGateways);
  try {
    const text = el.textContent ?? "";
    assert.ok(text.includes("社員"), text);
    assert.ok(text.includes("接続済みのゲートウェイ"), text);
    assert.doesNotMatch(text, /[가-힣]/);
    const labels = [...el.querySelectorAll("[aria-label]")].map((node) =>
      node.getAttribute("aria-label"),
    );
    for (const label of labels) assert.doesNotMatch(String(label), /[가-힣]/);
  } finally {
    await cleanup();
  }
});

test("the empty and error states are translated for a Chinese viewer", async () => {
  const empty = await render("zh", { ok: true, data: { gateways: [] } });
  try {
    const text = empty.el.textContent ?? "";
    assert.ok(text.includes("请先连接网关"), text);
    assert.doesNotMatch(text, /[가-힣]/);
  } finally {
    await empty.cleanup();
  }
  const failed = await render("zh", { ok: false, data: { error: "boom" } });
  try {
    const text = failed.el.textContent ?? "";
    assert.ok(text.includes("无法加载网关"), text);
    assert.ok(text.includes("重试"), text);
  } finally {
    await failed.cleanup();
  }
});

test("Korean viewers see the same Korean wording as before", async () => {
  const { el, cleanup } = await render("ko", twoGateways);
  try {
    const text = el.textContent ?? "";
    assert.ok(text.includes("직원 한 명이 Hermes 프로필 하나입니다."), text);
    assert.ok(text.includes("연결된 게이트웨이"), text);
    assert.ok(text.includes("이 게이트웨이의 프로필과 NPC 외형을 관리합니다."), text);
  } finally {
    await cleanup();
  }
});
