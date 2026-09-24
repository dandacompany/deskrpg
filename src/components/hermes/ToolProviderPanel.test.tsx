import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "../../lib/i18n/context";
import ToolProviderPanel, { defaultProviderChoice, isPlainEnvValue } from "./ToolProviderPanel";
import type { ToolProvidersPayload } from "@/lib/hermes/plugin-client-types";

const BASE = "/api/gateways/g/plugin/profiles/noah";
const SECRET = "sk-TYPED-KEY-0123456789";

function payload(overrides: Partial<ToolProvidersPayload> = {}): ToolProvidersPayload {
  return {
    toolset: "tts",
    hasProviders: true,
    activeProvider: null,
    cliCommand: "hermes -p noah tools",
    providers: [
      {
        name: "Microsoft Edge TTS",
        badge: "★ recommended · free",
        tag: "no key",
        envVars: [],
        active: false,
        status: "ready",
        setup: "none",
      },
      {
        name: "OpenAI TTS",
        badge: "paid",
        tag: "voices",
        envVars: [
          {
            key: "VOICE_TOOLS_OPENAI_KEY",
            prompt: "OpenAI API key",
            url: "https://platform.openai.com/api-keys",
            isSet: false,
          },
        ],
        active: false,
        status: "needs_keys",
        setup: "keys",
      },
      {
        name: "Piper",
        badge: "local",
        tag: "local",
        envVars: [],
        active: false,
        status: "needs_setup",
        setup: "cli",
      },
    ],
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };

function stub(routes: { get: () => unknown; put?: () => unknown }) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const body = method === "PUT" ? (routes.put?.() ?? {}) : routes.get();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function mount(onSaved?: (r: { provider: string; ready: boolean }) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <ToolProviderPanel profileBase={BASE} toolset="tts" onSaved={onSaved} />
      </I18nProvider>,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

function radio(host: HTMLElement, name: string) {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (r) => r.value === name,
  )!;
}

function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
}

test("picks what's currently in use first, otherwise the first row the app can select", () => {
  assert.equal(defaultProviderChoice(payload()), "Microsoft Edge TTS");
  assert.equal(defaultProviderChoice(payload({ activeProvider: "OpenAI TTS" })), "OpenAI TTS");
  // Even if the first selectable row needs a key, an already-ready row later in the list is picked instead (observed with web search).
  const web = payload();
  web.providers = [web.providers[1], web.providers[0], web.providers[2]];
  assert.equal(defaultProviderChoice(web), "Microsoft Edge TTS");
});

test("does not mask a URL value", () => {
  assert.equal(isPlainEnvValue("FIRECRAWL_API_URL"), true);
  assert.equal(isPlainEnvValue("SEARXNG_URL"), true);
  assert.equal(isPlainEnvValue("OPENAI_API_KEY"), false);
});

test("a provider that needs a key can only save once entered, the value goes only in the save request, and it's cleared from the screen", async () => {
  const f = stub({
    get: () => payload(),
    put: () => ({ provider: "OpenAI TTS", isSet: { VOICE_TOOLS_OPENAI_KEY: true } }),
  });
  const saved: unknown[] = [];
  const { host, unmount } = await mount((r) => saved.push(r));
  try {
    assert.equal(f.calls[0].url, `${BASE}/toolsets/tts/providers`);
    await act(async () => radio(host, "OpenAI TTS").click());
    const save = button(host, "이 제공자로 설정");
    assert.equal(save.disabled, true, "키 없이 저장할 수 있다");

    const input = host.querySelector<HTMLInputElement>(
      'input[data-env-key="VOICE_TOOLS_OPENAI_KEY"]',
    )!;
    // Markers that keep a password manager from mistaking this for a login (observed in staging 2026-09-19).
    assert.equal(input.type, "password");
    assert.equal(input.getAttribute("autocomplete"), "new-password");
    assert.equal(input.getAttribute("data-bwignore"), "true");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, SECRET);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(button(host, "이 제공자로 설정").disabled, false);
    await act(async () => button(host, "이 제공자로 설정").click());

    const put = f.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.url, `${BASE}/toolsets/tts/provider`);
    assert.deepEqual(put.body, { provider: "OpenAI TTS", env: { VOICE_TOOLS_OPENAI_KEY: SECRET } });
    assert.deepEqual(saved, [{ provider: "OpenAI TTS", ready: true }]);
    assert.equal(host.innerHTML.includes(SECRET), false, "저장한 키가 화면에 남아 있다");
  } finally {
    f.restore();
    await unmount();
  }
});

test("a provider that needs server-side install shows a command instead of save", async () => {
  const f = stub({ get: () => payload() });
  const { host, unmount } = await mount();
  try {
    await act(async () => radio(host, "Piper").click());
    assert.match(host.textContent ?? "", /hermes -p noah tools/);
    assert.equal(button(host, "이 제공자로 설정"), undefined);
  } finally {
    f.restore();
    await unmount();
  }
});

test("shows a translated reason when save is rejected", async () => {
  const f = stub({
    get: () => payload(),
    put: () => ({ errorCode: "provider_needs_cli" }),
  });
  const { host, unmount } = await mount();
  try {
    await act(async () => button(host, "이 제공자로 설정").click());
    assert.match(host.textContent ?? "", /게이트웨이 서버에서 설정해야/);
  } finally {
    f.restore();
    await unmount();
  }
});
