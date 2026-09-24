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
import ChannelsPage from "./page";

// `/channels` uses `useRouter` — tests have no app router, so plant an empty one.
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: "test",
};

function stubFetch(me: unknown) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/api/characters/me")
      ? { character: me }
      : url.endsWith("/api/groups")
        ? { groups: [] }
        : {
            channels: [
              {
                id: "ch1",
                name: "우리 사무실",
                description: null,
                ownerId: "u1",
                ownerNickname: "나",
                isPublic: true,
                isLocked: false,
                isMember: true,
                inviteCode: null,
                maxPlayers: 10,
                playerCount: 0,
                createdAt: "2026-09-18T00:00:00.000Z",
              },
            ],
            currentUserId: "u1",
          };
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

async function render(me: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(me);
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <AppRouterContext.Provider value={router}>
          <I18nProvider initialLocale="ko">
            <ChannelsPage />
          </I18nProvider>
        </AppRouterContext.Provider>,
      ),
    );
    // Wait until the list and character reads finish and loading clears.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  } finally {
    globalThis.fetch = original;
  }
  return {
    el,
    cleanup: async () => {
      await act(async () => root.unmount());
      el.remove();
    },
  };
}

test("without a character it draws a guide card to my character instead of the channel list", async () => {
  const { el, cleanup } = await render(null);
  try {
    const text = el.textContent ?? "";
    assert.match(text, /먼저 내 캐릭터를 만드세요/);
    assert.doesNotMatch(text, /우리 사무실/, "채널 목록은 가려진다");
    const link = [...el.querySelectorAll("a")].find((a) => a.textContent === "내 캐릭터 만들기");
    assert.ok(link, "내 캐릭터 링크가 있다");
    assert.equal(link.getAttribute("href"), "/characters");
  } finally {
    await cleanup();
  }
});

test("with a character it draws the channel list without the guide card", async () => {
  const { el, cleanup } = await render({ id: "c1", name: "나", bio: null, appearance: {} });
  try {
    const text = el.textContent ?? "";
    assert.doesNotMatch(text, /먼저 내 캐릭터를 만드세요/);
    assert.match(text, /우리 사무실/);
  } finally {
    await cleanup();
  }
});
