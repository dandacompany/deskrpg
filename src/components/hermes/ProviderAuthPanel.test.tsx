import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../lib/i18n/context";
import ProviderAuthPanel, { type ProviderAuthPanelProps } from "./ProviderAuthPanel";

const BASE = "/api/gateways/g/plugin/profiles/noah";
const SECRET = "sk-test-SEEDED-secret-value-123456";

type Reply = { status?: number; body: unknown };
type Call = { method: string; url: string; body: string | null };

/**
 * `METHOD URL` (exact match) -> response. If the value is an array, one is popped per call
 * and the last one sticks. Returns a minimal object instead of a real `Response` — so body
 * reads don't rely on internal timers while fake timers are enabled.
 */
function stubFetch(routes: Record<string, Reply | Reply[]>) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const cursors: Record<string, number> = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${String(url)}`;
    calls.push({
      method,
      url: String(url),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const entry = routes[key];
    if (!entry) throw new Error(`unexpected fetch: ${key}`);
    let reply: Reply;
    if (Array.isArray(entry)) {
      const i = cursors[key] ?? 0;
      reply = entry[Math.min(i, entry.length - 1)];
      cursors[key] = i + 1;
    } else {
      reply = entry;
    }
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => reply.body,
    } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    count: (method: string, url: string) =>
      calls.filter((c) => c.method === method && c.url === url).length,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Collects every string that flowed to console — there must be no secret value among them. */
function captureConsole() {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ["log", "warn", "error", "info"] as const) {
    console[k] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore: () => Object.assign(console, saved),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

type Provider = ProviderAuthPanelProps["provider"];

async function mount(provider: Provider, extra: Partial<ProviderAuthPanelProps> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let authenticated = 0;
  const render = (p: Provider, e: Partial<ProviderAuthPanelProps>) =>
    root.render(
      <I18nProvider initialLocale="ko">
        <ProviderAuthPanel
          profileBase={BASE}
          provider={p}
          onAuthenticated={() => {
            authenticated += 1;
          }}
          {...e}
        />
      </I18nProvider>,
    );
  await act(async () => render(provider, extra));
  await flush();
  return {
    host,
    authenticated: () => authenticated,
    rerender: async (p: Provider, e: Partial<ProviderAuthPanelProps> = {}) => {
      await act(async () => render(p, e));
      await flush();
    },
    unmount: () => act(async () => root.unmount()),
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(found, `button "${label}" not found in: ${host.textContent}`);
  return found;
}

function hasButton(host: HTMLElement, label: string) {
  return Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.trim() === label);
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

/** Sets a value on a React-controlled input — goes through the value setter and fires an input event. */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const OPENAI_KEY: Provider = {
  id: "openai",
  name: "OpenAI",
  authenticated: false,
  authType: "api_key",
  envVars: ["OPENAI_API_KEY"],
};
const CODEX: Provider = {
  id: "openai-codex",
  name: "OpenAI Codex",
  authenticated: false,
  authType: "oauth_device",
};
const START = {
  sessionId: "sess-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://auth.openai.com/codex/device",
  expiresIn: 900,
  pollInterval: 1,
};
const PENDING = {
  status: "pending",
  error: null,
  expiresAt: null,
  retryable: null,
  retryAfter: null,
};
const APPROVED = { ...PENDING, status: "approved" };

test("api_key: saves the key via a password input and never shows the value back anywhere", async () => {
  const f = stubFetch({
    [`PUT ${BASE}/provider-keys/openai`]: {
      body: { configured: true, envVar: "OPENAI_API_KEY" },
    },
  });
  const con = captureConsole();
  const view = await mount(OPENAI_KEY);
  try {
    const input = view.host.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.getAttribute("type"), "password");
    // Keeps a password manager from mistaking this field for a login (observed in staging
    // 2026-09-19: Bitwarden offered "update existing login"). "off" is ignored on password inputs.
    assert.equal(input.getAttribute("autocomplete"), "new-password");
    assert.equal(input.getAttribute("data-bwignore"), "true");
    await typeInto(input, SECRET);
    await click(button(view.host, "키 저장"));

    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, "PUT");
    assert.equal(f.calls[0].url, `${BASE}/provider-keys/openai`);
    assert.deepEqual(JSON.parse(f.calls[0].body!), { value: SECRET });
    assert.equal(view.host.querySelector<HTMLInputElement>("input")?.value ?? "", "");
    assert.equal(view.authenticated(), 1);
    assert.ok(!view.host.innerHTML.includes(SECRET));
    assert.ok(!con.lines.some((l) => l.includes(SECRET)));
  } finally {
    await view.unmount();
    con.restore();
    f.restore();
  }
});

test("api_key: the save button is disabled when the value is empty", async () => {
  const f = stubFetch({});
  const view = await mount(OPENAI_KEY);
  try {
    assert.equal(button(view.host, "키 저장").disabled, true);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("oauth_device: login -> code/link -> onAuthenticated fires once when approved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: [{ body: PENDING }, { body: APPROVED }],
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    assert.equal(f.count("POST", `${BASE}/oauth/openai-codex/start`), 1);
    assert.ok(view.host.textContent?.includes("ABCD-1234"));
    const link = view.host.querySelector<HTMLAnchorElement>("a")!;
    assert.equal(link.textContent?.trim(), "인증 페이지 열기");
    assert.equal(link.getAttribute("href"), START.verificationUrl);
    assert.equal(link.getAttribute("target"), "_blank");
    const rel = link.getAttribute("rel") ?? "";
    assert.ok(rel.includes("noopener") && rel.includes("noreferrer"));

    // Polling happens once every pollDelayMs — never overlapping.
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 0);
    await act(async () => t.mock.timers.tick(1999));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 0);
    await act(async () => t.mock.timers.tick(1));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 1);
    assert.equal(view.authenticated(), 0);
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 2);
    assert.equal(view.authenticated(), 1);

    // After approval, no more polling happens, and the ended session is not deleted either.
    await act(async () => t.mock.timers.tick(10_000));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 2);
  } finally {
    await view.unmount();
    f.restore();
  }
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 0);
});

test("oauth_device: never overlaps the next poll even if the response is slow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release: (() => void) | null = null;
  const f = stubFetch({ [`POST ${BASE}/oauth/openai-codex/start`]: { body: START } });
  const inner = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/sessions/sess-1") && (init?.method ?? "GET") === "GET") {
      polls += 1;
      await new Promise<void>((r) => {
        release = r;
      });
      return { ok: true, status: 200, json: async () => PENDING } as unknown as Response;
    }
    return inner(url, init);
  }) as typeof fetch;
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.equal(polls, 1);
    await act(async () => t.mock.timers.tick(20_000));
    await flush();
    assert.equal(polls, 1, "응답 전에는 다음 폴링을 예약하지 않는다");
    await act(async () => release!());
    await flush();
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.equal(polls, 2);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("oauth_device: unmounting while waiting DELETEs the session once, with no further polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: { body: PENDING },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 1);
  } finally {
    await view.unmount();
  }
  await flush();
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
  await act(async () => t.mock.timers.tick(60_000));
  await flush();
  assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 1);
  f.restore();
});

test("oauth_device: the cancel button DELETEs the session once, then returns to the login button", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: { body: PENDING },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    await click(button(view.host, "취소"));
    assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
    assert.ok(hasButton(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(60_000));
    await flush();
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 0);
  } finally {
    await view.unmount();
  }
  // Unmounting doesn't delete a session that's already been canceled.
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
  f.restore();
});

test("oauth_device: on denial, shows the reason and a retry button", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: { body: { ...PENDING, status: "denied" } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.ok(view.host.textContent?.includes("로그인이 거절됐습니다."));
    assert.ok(hasButton(view.host, "다시 시도"));
    assert.equal(view.authenticated(), 0);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("oauth_device: a non-http(s) verification URL is never rendered as a link", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: {
      body: { ...START, verificationUrl: "javascript:alert(1)" },
    },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: { body: PENDING },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    assert.ok(!view.host.querySelector("a"));
    assert.ok(!view.host.innerHTML.includes("javascript:"));
    assert.ok(view.host.textContent?.includes("ABCD-1234"));
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("external: only the command and copy button, no input or login button", async () => {
  const f = stubFetch({});
  const nav = navigator as unknown as Record<string, unknown>;
  const savedClipboard = Object.getOwnPropertyDescriptor(nav, "clipboard");
  Object.defineProperty(nav, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });
  const view = await mount({
    id: "copilot",
    name: "Copilot",
    authenticated: false,
    authType: "external",
    cliCommand: "hermes auth add copilot",
  });
  try {
    assert.ok(view.host.textContent?.includes("hermes auth add copilot"));
    assert.ok(view.host.textContent?.includes("게이트웨이 서버에서 이 명령으로 로그인하세요"));
    assert.ok(hasButton(view.host, "복사"));
    assert.equal(view.host.querySelectorAll("input").length, 0);
    assert.ok(!hasButton(view.host, "로그인"));
    assert.equal(f.calls.length, 0);
  } finally {
    await view.unmount();
    if (savedClipboard) Object.defineProperty(nav, "clipboard", savedClipboard);
    else delete nav.clipboard;
    f.restore();
  }
});

test("renders nothing when authType is absent", async () => {
  const f = stubFetch({});
  const view = await mount({ id: "x", name: "X", authenticated: false });
  try {
    assert.equal(view.host.innerHTML, "");
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("authenticated oauth_device: connected + disconnect -> DELETE then onAuthenticated", async () => {
  const f = stubFetch({ [`DELETE ${BASE}/oauth/openai-codex`]: { body: { ok: true } } });
  const view = await mount({ ...CODEX, authenticated: true });
  try {
    assert.ok(view.host.textContent?.includes("연결됨"));
    assert.ok(!hasButton(view.host, "로그인"));
    await click(button(view.host, "연결 끊기"));
    assert.equal(f.count("DELETE", `${BASE}/oauth/openai-codex`), 1);
    assert.equal(view.authenticated(), 1);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("when disconnect returns ok:false (nothing removed), refetches without overwriting as disconnected", async () => {
  // The plugin returns ok:false when there's nothing to remove from that profile's auth.json — auth can come from an env var or a pool.
  const f = stubFetch({ [`DELETE ${BASE}/oauth/openai-codex`]: { body: { ok: false } } });
  const view = await mount({ ...CODEX, authenticated: true });
  try {
    await click(button(view.host, "연결 끊기"));
    assert.equal(f.count("DELETE", `${BASE}/oauth/openai-codex`), 1);
    assert.equal(view.authenticated(), 1);
    assert.ok(view.host.textContent?.includes("연결됨"));
    assert.ok(hasButton(view.host, "연결 끊기"));
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("authenticated api_key: connected + replace key (input field) + remove key", async () => {
  const f = stubFetch({
    [`DELETE ${BASE}/provider-keys/openai`]: {
      body: { configured: false, removed: ["OPENAI_API_KEY"] },
    },
  });
  const view = await mount({ ...OPENAI_KEY, authenticated: true });
  try {
    assert.ok(view.host.textContent?.includes("연결됨"));
    assert.equal(view.host.querySelectorAll("input").length, 0);
    await click(button(view.host, "키 교체"));
    const input = view.host.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.getAttribute("type"), "password");
    assert.ok(hasButton(view.host, "키 저장"));

    await click(button(view.host, "키 삭제"));
    assert.equal(f.count("DELETE", `${BASE}/provider-keys/openai`), 1);
    assert.equal(view.authenticated(), 1);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("an upstream failure shows a localized message, never the value/token", async () => {
  const f = stubFetch({
    [`PUT ${BASE}/provider-keys/openai`]: {
      status: 403,
      body: { errorCode: "forbidden", error: `nope ${SECRET}` },
    },
    [`POST ${BASE}/oauth/openai-codex/start`]: {
      body: {
        errorCode: "oauth_flow_unsupported",
        error: "raw upstream text",
        upstreamStatus: 400,
      },
    },
  });
  const con = captureConsole();
  const keyView = await mount(OPENAI_KEY);
  const oauthView = await mount(CODEX);
  try {
    await typeInto(keyView.host.querySelector<HTMLInputElement>("input")!, SECRET);
    await click(button(keyView.host, "키 저장"));
    assert.ok(keyView.host.textContent?.includes("이 작업을 수행할 권한이 없습니다"));
    assert.ok(!keyView.host.textContent?.includes(SECRET));
    assert.ok(!keyView.host.innerHTML.includes(SECRET));
    assert.equal(keyView.authenticated(), 0);

    await click(button(oauthView.host, "로그인"));
    assert.ok(
      oauthView.host.textContent?.includes("이 제공자는 앱 안 로그인을 지원하지 않습니다."),
    );
    assert.ok(!oauthView.host.textContent?.includes("raw upstream text"));
    assert.ok(hasButton(oauthView.host, "다시 시도"));
    assert.ok(!con.lines.some((l) => l.includes(SECRET)));
  } finally {
    await keyView.unmount();
    await oauthView.unmount();
    con.restore();
    f.restore();
  }
});

test("when disabled, every button is disabled", async () => {
  const f = stubFetch({});
  const view = await mount({ ...CODEX, authenticated: true }, { disabled: true });
  try {
    assert.equal(button(view.host, "연결 끊기").disabled, true);
  } finally {
    await view.unmount();
    f.restore();
  }
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────

test("changing the provider discards the key being typed — it never leaks to the new endpoint", async () => {
  const f = stubFetch({});
  const view = await mount(OPENAI_KEY);
  try {
    await typeInto(view.host.querySelector<HTMLInputElement>("input")!, SECRET);
    await view.rerender({ ...OPENAI_KEY, id: "anthropic", name: "Anthropic" });
    const input = view.host.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.value, "");
    assert.equal(button(view.host, "키 저장").disabled, true);
    assert.equal(f.calls.length, 0);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("changing the provider while waiting deletes the old session once, returns to idle, and stops polling the old path", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: { body: PENDING },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    assert.ok(view.host.textContent?.includes("ABCD-1234"));
    await view.rerender({ ...CODEX, id: "nous", name: "Nous" });
    assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
    assert.ok(!view.host.textContent?.includes("ABCD-1234"));
    assert.ok(hasButton(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(60_000));
    await flush();
    assert.equal(f.calls.filter((c) => c.method === "GET").length, 0);
  } finally {
    await view.unmount();
  }
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
  f.restore();
});

test("the connected badge follows only the new provider's authenticated value", async () => {
  const f = stubFetch({
    [`PUT ${BASE}/provider-keys/openai`]: { body: { configured: true, envVar: "OPENAI_API_KEY" } },
  });
  const view = await mount(OPENAI_KEY);
  try {
    await typeInto(view.host.querySelector<HTMLInputElement>("input")!, SECRET);
    await click(button(view.host, "키 저장"));
    assert.ok(view.host.textContent?.includes("연결됨"));
    await view.rerender({ ...OPENAI_KEY, id: "anthropic", name: "Anthropic" });
    assert.ok(!view.host.textContent?.includes("연결됨"));
    await view.rerender({ ...OPENAI_KEY, id: "mistral", name: "Mistral", authenticated: true });
    assert.ok(view.host.textContent?.includes("연결됨"));
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("a transient proxy error while polling (timeout/unreachable/upstream_error) never ends the login", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: [
      { body: { errorCode: "timeout", upstreamStatus: null } },
      { body: { errorCode: "unreachable" } },
      { body: { errorCode: "upstream_error", upstreamStatus: 502 } },
      { body: APPROVED },
    ],
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    for (let i = 0; i < 4; i += 1) {
      await act(async () => t.mock.timers.tick(2000));
      await flush();
    }
    assert.equal(f.count("GET", `${BASE}/oauth/openai-codex/sessions/sess-1`), 4);
    assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 0);
    assert.equal(view.authenticated(), 1);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("a different errorCode while polling ends the login and deletes the session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: START },
    [`GET ${BASE}/oauth/openai-codex/sessions/sess-1`]: {
      body: { errorCode: "oauth_session_mismatch" },
    },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    await act(async () => t.mock.timers.tick(2000));
    await flush();
    assert.ok(hasButton(view.host, "다시 시도"));
    assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
  } finally {
    await view.unmount();
    f.restore();
  }
});

test("deletes the session once even when the start response arrives after unmount", async () => {
  const f = stubFetch({ [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } } });
  const inner = globalThis.fetch;
  let release: (() => void) | null = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/oauth/openai-codex/start")) {
      await new Promise<void>((r) => {
        release = r;
      });
      return { ok: true, status: 200, json: async () => START } as unknown as Response;
    }
    return inner(url, init);
  }) as typeof fetch;
  const view = await mount(CODEX);
  await click(button(view.host, "로그인"));
  await view.unmount();
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 0);
  await act(async () => release!());
  await flush();
  assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
  f.restore();
});

test("stops polling after expiry + grace period when network failures keep happening", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = stubFetch({
    [`POST ${BASE}/oauth/openai-codex/start`]: { body: { ...START, expiresIn: 4 } },
    [`DELETE ${BASE}/oauth/sessions/sess-1`]: { body: { ok: true } },
  });
  const inner = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/sessions/sess-1") && (init?.method ?? "GET") === "GET") {
      polls += 1;
      throw new TypeError("network down");
    }
    return inner(url, init);
  }) as typeof fetch;
  const view = await mount(CODEX);
  try {
    await click(button(view.host, "로그인"));
    // Expiry 4s + grace 30s = 34s. Advance a generous 60s in 2s increments.
    for (let i = 0; i < 30; i += 1) {
      await act(async () => t.mock.timers.tick(2000));
      await flush();
    }
    const stoppedAt = polls;
    assert.ok(stoppedAt >= 16 && stoppedAt <= 18, `polls=${stoppedAt}`);
    assert.ok(view.host.textContent?.includes("코드가 만료됐습니다. 다시 시도하세요."));
    assert.equal(f.count("DELETE", `${BASE}/oauth/sessions/sess-1`), 1);
    await act(async () => t.mock.timers.tick(60_000));
    await flush();
    assert.equal(polls, stoppedAt);
  } finally {
    await view.unmount();
    f.restore();
  }
});
