import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import MyCharacterForm from "./MyCharacterForm";

type Call = { url: string; method: string; body?: unknown };

function stubFetch(calls: Call[], me: unknown) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = url.endsWith("/api/characters/me")
      ? { character: me }
      : { character: { id: "c1", name: "나", bio: null } };
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

async function mount(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return { root, el };
}

test("registration form without a character, edit form with one — it is one screen", async () => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  try {
    globalThis.fetch = stubFetch(calls, null);
    let m = await mount(
      <I18nProvider initialLocale="ko">
        <MyCharacterForm />
      </I18nProvider>,
    );
    assert.match(m.el.textContent ?? "", /내 캐릭터 만들기/);
    assert.doesNotMatch(m.el.textContent ?? "", /새 캐릭터 만들기/);
    await act(async () => m.root.unmount());
    m.el.remove();

    globalThis.fetch = stubFetch(calls, {
      id: "c1",
      name: "나",
      bio: "소개",
      appearance: { officeLookId: "look-1", bodyType: "male" },
    });
    m = await mount(
      <I18nProvider initialLocale="ko">
        <MyCharacterForm />
      </I18nProvider>,
    );
    assert.match(m.el.textContent ?? "", /저장/);
    const bio = [...m.el.querySelectorAll("textarea")].find((t) => t.value === "소개");
    assert.ok(bio, "소개 칸이 기존 값으로 채워져야 한다");
    await act(async () => m.root.unmount());
    m.el.remove();
  } finally {
    globalThis.fetch = original;
  }
});

test("saving sends bio with PATCH", async () => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  try {
    globalThis.fetch = stubFetch(calls, {
      id: "c1",
      name: "나",
      bio: null,
      appearance: { officeLookId: "look-1", bodyType: "male" },
    });
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <MyCharacterForm />
      </I18nProvider>,
    );
    const bio = el.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(bio, "단테랩스 대표");
      bio.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "저장")!;
    await act(async () => save.click());
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/api/characters/c1"));
    assert.ok(patch, "PATCH 가 나가지 않았다");
    assert.equal((patch!.body as { bio: string }).bio, "단테랩스 대표");
    await act(async () => root.unmount());
    el.remove();
  } finally {
    globalThis.fetch = original;
  }
});
