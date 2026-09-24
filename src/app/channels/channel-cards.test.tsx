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

type ChannelStub = Record<string, unknown>;

function channel(overrides: ChannelStub): ChannelStub {
  return {
    id: "ch",
    name: "채널",
    description: null,
    ownerId: "u1",
    ownerNickname: "나",
    isPublic: true,
    isLocked: false,
    isMember: true,
    inviteCode: null,
    maxPlayers: 50,
    createdAt: "2026-09-18T00:00:00.000Z",
    environmentId: null,
    memberCount: 0,
    participants: [],
    ...overrides,
  };
}

let channelsBody: ChannelStub[] = [];

function stubFetch(me: unknown) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/api/characters/me")
      ? { character: me }
      : url.endsWith("/api/groups")
        ? { groups: [] }
        : { channels: channelsBody, currentUserId: "u1" };
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

const me = { id: "c1", name: "나", bio: null, appearance: {} };
const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ nickname: `사람${i + 1}`, appearance: null }));

test("channel cards draw a map thumbnail, round avatars and 'N명 참여', and do not use '접속중'", async () => {
  channelsBody = [
    channel({
      id: "tech",
      name: "기술팀",
      environmentId: "tech",
      memberCount: 2,
      participants: people(2),
    }),
  ];
  const { el, cleanup } = await render(me);
  try {
    const card = el.querySelector('[data-channel-id="tech"]')!;
    assert.ok(card, "카드가 있다");
    const img = card.querySelector("img[data-channel-thumbnail]");
    assert.ok(img, "썸네일 이미지가 있다");
    assert.match(
      decodeURIComponent(img.getAttribute("src") ?? ""),
      /environments\/thumbnails\/tech-/,
    );
    assert.equal(card.querySelectorAll("[data-participant-avatar]").length, 2);
    const text = card.textContent ?? "";
    assert.match(text, /2명 참여/);
    assert.doesNotMatch(text, /접속중/);
  } finally {
    await cleanup();
  }
});

test("with more participants than the preview it draws +N, and without a known environment it draws an empty slot instead of the thumbnail", async () => {
  channelsBody = [
    channel({ id: "big", environmentId: null, memberCount: 7, participants: people(5) }),
  ];
  const { el, cleanup } = await render(me);
  try {
    const card = el.querySelector('[data-channel-id="big"]')!;
    assert.equal(card.querySelector("img[data-channel-thumbnail]"), null);
    assert.ok(card.querySelector("[data-channel-thumbnail-placeholder]"));
    assert.equal(card.querySelectorAll("[data-participant-avatar]").length, 5);
    assert.match(card.textContent ?? "", /\+2/);
    assert.match(card.textContent ?? "", /7명 참여/);
  } finally {
    await cleanup();
  }
});
