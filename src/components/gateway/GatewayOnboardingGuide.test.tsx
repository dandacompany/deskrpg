import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

import { I18nProvider } from "@/lib/i18n";
import GatewayOnboardingGuide from "./GatewayOnboardingGuide";

// This screen uses `useRouter` inside `quickStart` — tests have no app router, so plant a stub one.
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

async function render() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <AppRouterContext.Provider value={router}>
        <I18nProvider initialLocale="ko">
          <GatewayOnboardingGuide />
        </I18nProvider>
      </AppRouterContext.Provider>,
    );
  });
  return { el, root };
}

test("the first screen shows only the intro and the action button expanded", async () => {
  const { el, root } = await render();
  const text = el.textContent ?? "";

  // Stays visible
  assert.match(text, /런타임을 내장하지 않습니다/);
  assert.match(text, /빠른 시작/);

  // Stays collapsed — the command is inside details so it's hidden until opened.
  const details = el.querySelector("details");
  assert.ok(details, "수동 설치 영역이 details 가 아니다");
  assert.equal(details!.hasAttribute("open"), false);

  await act(async () => root.unmount());
  el.remove();
});

test("the owner-key warning is dropped from the guide card", async () => {
  const { el, root } = await render();
  // This warning moved to where the key is entered (the wizard) — leaving it here would go unread.
  assert.ok(!(el.textContent ?? "").includes("API_SERVER_KEY"));
  await act(async () => root.unmount());
  el.remove();
});
