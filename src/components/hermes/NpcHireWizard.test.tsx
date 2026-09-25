import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import NpcHireWizard from "./NpcHireWizard";

/**
 * Why this file exists: `handleSaveConfig` was holding a stale closure that dropped
 * `reasoning_effort` from the PUT body, yet the screen still showed "Saved" and all 959
 * tests in `npm run test` were green. There wasn't a single test rendering the component
 * (it was only caught in staging).
 *
 * The `exhaustive-deps` rule blocks that **class** of bug, so this file checks only what
 * the rule can't see — what the save button actually sends.
 */

type FetchCall = { url: string; method: string; body: unknown };

function stubFetch(calls: FetchCall[], routes: Record<string, unknown>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const payload = key ? routes[key] : {};
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  };
}

async function mount(node: React.ReactElement): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(node);
  });
  return { root, el };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `"${text}" 버튼을 찾지 못했다`);
  return found as HTMLButtonElement;
}

test("saving config carries the selected reasoning_effort in the PUT body", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls, {
    "/config": { model: "gpt-5", provider: "openai-codex", toolsets: null, reasoning_effort: null },
    "/catalog": {
      providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: true }],
      models: { "openai-codex": ["gpt-5"] },
      reasoningEfforts: ["low", "medium", "high"],
    },
    "/identity": { isDefaultTemplate: true, soul: "" },
  }) as typeof fetch;

  try {
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <NpcHireWizard
          gatewayId="gw-1"
          pluginStatus="plugin_ready"
          localDiscovery={false}
          existingProfiles={["oliver"]}
          initialProfile="oliver"
          onDone={() => {}}
        />
      </I18nProvider>,
    );

    // Move to step 3 config
    const configTab = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("④"));
    assert.ok(configTab, "③ AI 모델 탭을 찾지 못했다");
    await act(async () => {
      configTab.click();
    });
    assert.equal(
      [...el.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("오피스 만들기")),
      false,
      "기존 직원은 출근 채널 수가 알려지지 않았으므로 오피스 생성 안내를 보이지 않는다",
    );

    const effortSelect = [...el.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "high"),
    );
    assert.ok(effortSelect, "추론 강도 셀렉트가 렌더되지 않았다 — 카탈로그 배선이 끊겼다");

    await act(async () => {
      effortSelect.value = "high";
      effortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    calls.length = 0;
    await act(async () => {
      buttonByText(el, "저장").click();
    });

    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/config"));
    assert.ok(put, "설정 PUT 이 나가지 않았다");
    assert.equal(
      (put.body as Record<string, unknown>).reasoning_effort,
      "high",
      "고른 effort 가 본문에서 사라졌다 — 오래된 클로저가 다시 생겼다",
    );

    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to free-text input instead of a dropdown when the catalog can't be fetched", async () => {
  // Without this fallback, the screen would make it **impossible to specify a model at all**
  // when the gateway can't return the list. This wiring can't be seen by pure-function tests,
  // so it's pinned down here.
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: undefined });
    if (url.includes("/catalog")) {
      return {
        ok: false,
        status: 502,
        headers: new Map() as unknown as Headers,
        json: async () => ({ errorCode: "upstream_error" }),
        text: async () => '{"errorCode":"upstream_error"}',
      } as unknown as Response;
    }
    const payload = url.includes("/config")
      ? { model: "gpt-5", provider: "openai-codex", toolsets: null, reasoning_effort: null }
      : { isDefaultTemplate: true, soul: "" };
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <NpcHireWizard
          gatewayId="gw-1"
          pluginStatus="plugin_ready"
          localDiscovery={false}
          existingProfiles={["oliver"]}
          initialProfile="oliver"
          onDone={() => {}}
        />
      </I18nProvider>,
    );

    const configTab = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("④"));
    assert.ok(configTab, "③ AI 모델 탭을 찾지 못했다");
    await act(async () => {
      configTab.click();
    });

    assert.ok(
      calls.some((c) => c.url.includes("/catalog")),
      "카탈로그를 요청하지도 않았다",
    );
    assert.equal(
      el.querySelectorAll("select").length,
      0,
      "카탈로그가 실패했는데 드롭다운이 남아 있다 — 고를 수 없는 빈 목록이 된다",
    );
    assert.ok(
      el.querySelectorAll('input[type="text"]').length >= 2,
      "직접 입력으로 떨어지지 않았다 — 모델을 지정할 방법이 사라진다",
    );

    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the config step guides to this employee's dashboard login, and confirming login refetches the list", async () => {
  // Hermes logs in per NPC (profile). A subscription logged in as default can't be used by a
  // new employee, and without guidance the user is stuck at "not authenticated" or only finds
  // out after a conversation fails
  // (observed 2026-09-17 on the Hostinger VPS: No Codex credentials stored).
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls, {
    "/config": { model: null, provider: null, toolsets: null, reasoning_effort: null },
    "/catalog": {
      providers: [{ id: "openai-codex", name: "OpenAI Codex", authenticated: false }],
      models: {},
      reasoningEfforts: ["low"],
    },
    "/identity": { isDefaultTemplate: true, soul: "" },
  }) as typeof fetch;

  try {
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <NpcHireWizard
          gatewayId="gw-1"
          pluginStatus="plugin_ready"
          localDiscovery={false}
          existingProfiles={["oliver"]}
          initialProfile="oliver"
          dashboardUrl="https://dash.example.com"
          onDone={() => {}}
        />
      </I18nProvider>,
    );

    const configTab = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("④"));
    assert.ok(configTab, "③ AI 모델 탭을 찾지 못했다");
    await act(async () => {
      configTab.click();
    });

    const link = el.querySelector<HTMLAnchorElement>(
      'a[href="https://dash.example.com/env?profile=oliver"]',
    );
    assert.ok(link, "이 직원의 대시보드 로그인 링크가 없다");
    assert.equal(link.target, "_blank");
    assert.match(el.textContent ?? "", /직원마다/, "직원마다 따로 로그인한다는 설명이 없다");

    const before = calls.filter((c) => c.url.includes("/catalog")).length;
    await act(async () => {
      buttonByText(el, "로그인 확인").click();
    });
    const after = calls.filter((c) => c.url.includes("/catalog")).length;
    assert.equal(after, before + 1, "로그인 확인이 카탈로그를 다시 받지 않았다");

    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("without a dashboard URL, says to switch profiles and log in instead of showing a link", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(calls, {
    "/config": { model: null, provider: null, toolsets: null, reasoning_effort: null },
    "/catalog": { providers: [], models: {}, reasoningEfforts: [] },
    "/identity": { isDefaultTemplate: true, soul: "" },
  }) as typeof fetch;

  try {
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <NpcHireWizard
          gatewayId="gw-1"
          pluginStatus="plugin_ready"
          localDiscovery={false}
          existingProfiles={["oliver"]}
          initialProfile="oliver"
          onDone={() => {}}
        />
      </I18nProvider>,
    );
    const configTab = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("④"));
    assert.ok(configTab);
    await act(async () => {
      configTab.click();
    });
    assert.ok(!el.querySelector('a[href*="/env?profile="]'));
    assert.match(el.textContent ?? "", /oliver/);
    assert.ok(buttonByText(el, "로그인 확인"));

    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const PROFILE_ROUTES = (attendedChannels: number) => ({
  // Put the more specific path first — stubFetch picks the first matching key via `includes`.
  "/identity": { isDefaultTemplate: true, body: "", revision: "r0" },
  "/config": { model: null, provider: null, toolsets: null, reasoning_effort: null },
  "/catalog": { providers: [], models: {}, reasoningEfforts: [] },
  "/toolsets": {
    platform: "api_server",
    toolsets: [
      { name: "web", label: "Web", description: "검색", enabled: true, configured: true },
      { name: "tts", label: "TTS", description: "음성", enabled: false, configured: true },
    ],
  },
  "/skills": { skills: [] },
  "/plugin/profiles": { name: "mia", keyIssued: true, keyStored: true, attendedChannels },
});

function tabByNumber(el: HTMLElement, mark: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith(mark));
}

async function createProfile(el: HTMLElement) {
  const nameInput = [...el.querySelectorAll("input")].find((i) =>
    i.placeholder?.includes("새 프로필 이름"),
  );
  assert.ok(nameInput, "프로필 이름 입력칸을 찾지 못했다");
  await act(async () => {
    setInputValue(nameInput, "mia");
  });
  await act(async () => {
    buttonByText(el, "프로필 만들기").click();
  });
}

async function createAndOpenModel(el: HTMLElement) {
  await createProfile(el);
  const modelTab = tabByNumber(el, "④");
  assert.ok(modelTab, "③ 탭을 찾지 못했다");
  await act(async () => {
    modelTab.click();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function wizardWith(
  routes: Record<string, unknown>,
  calls: FetchCall[],
  onProfileCreated?: (n: string) => void,
  onDone: (result?: { profileName: string }) => void = () => {},
  cloneDefaultProfile = false,
) {
  globalThis.fetch = stubFetch(calls, routes) as typeof fetch;
  return (
    <I18nProvider initialLocale="ko">
      <NpcHireWizard
        gatewayId="gw-1"
        pluginStatus="plugin_ready"
        localDiscovery={false}
        existingProfiles={[]}
        onProfileCreated={onProfileCreated}
        cloneDefaultProfile={cloneDefaultProfile}
        onDone={onDone}
      />
    </I18nProvider>
  );
}

test("steps are 1 profile 2 identity 3 appearance 4 AI model, with no link button for the old placement step", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(1), calls));
    const tabs = [...el.querySelectorAll("button")]
      .map((b) => b.textContent ?? "")
      .filter((text) => /^[①②③④]/.test(text));
    assert.deepEqual(tabs, ["① 프로필", "② 인격", "③ 외형", "④ AI 모델"]);
    await createAndOpenModel(el);
    const text = el.textContent ?? "";
    for (const gone of ["완성형 외형 선택하기", "채널로 이동", "마법사 닫기"]) {
      assert.equal(text.includes(gone), false, `"${gone}" 가 남아 있다`);
    }
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shows a linked office-creation link only when the new employee has no office to attend", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const count of [0, 1]) {
      const { root, el } = await mount(wizardWith(PROFILE_ROUTES(count), []));
      await createAndOpenModel(el);
      const link = [...el.querySelectorAll("a")].find((anchor) =>
        anchor.textContent?.includes("오피스 만들기"),
      );
      if (count === 0) {
        assert.equal(link?.getAttribute("href"), "/channels/create?gatewayId=gw-1");
      } else {
        assert.equal(link, undefined);
      }
      assert.ok(buttonByText(el, "완료"));
      await act(async () => root.unmount());
      el.remove();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("before a profile is created, steps 2/3/4 are locked and the reason only shows as the 'Next' button's tooltip", async () => {
  // Observed in staging 2026-09-18: on a new profile, clicking step 2 showed "can't read the
  // identity file so the editor won't open," and step 3 fell back to free-text input instead
  // of a model list.
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(1), calls));
    assert.equal(tabByNumber(el, "②")?.disabled, true, "② 가 잠기지 않았다");
    assert.equal(tabByNumber(el, "③")?.disabled, true, "③ 이 잠기지 않았다");
    assert.equal(tabByNumber(el, "④")?.disabled, true, "④ 가 잠기지 않았다");
    const text = el.textContent ?? "";
    // Not spelled out like a tutorial — the reason lives only in the locked "Next" button's tooltip (2026-09-20).
    assert.equal(text.includes("먼저 ① 에서 프로필을 만드세요"), false);
    assert.equal(text.includes("인격 파일을 읽을 수 없어"), false);
    const next = el.querySelector<HTMLButtonElement>('[data-step-nav="next"]');
    assert.equal(next?.disabled, true, "잠긴 다음 단계인데 '다음' 이 눌린다");
    assert.match(next?.title ?? "", /먼저 ① 에서 프로필을 만드세요/);
    assert.equal(
      el.querySelector<HTMLButtonElement>('[data-step-nav="back"]')?.disabled,
      true,
      "첫 단계인데 '이전' 이 눌린다",
    );

    await createProfile(el);
    assert.equal(tabByNumber(el, "②")?.disabled, false, "프로필을 만든 뒤에도 ② 가 잠겨 있다");
    assert.equal(tabByNumber(el, "④")?.disabled, false, "프로필을 만든 뒤에도 ③ 이 잠겨 있다");
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not say 'attended' when there's no attached channel", async () => {
  // Claiming attendance with no channel leaves the user stuck looking for the employee in an
  // attendance roster that doesn't exist
  // (observed on the Hostinger VPS 2026-09-17).
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(0), calls));
    await createAndOpenModel(el);
    const text = el.textContent ?? "";
    assert.equal(/출근했습니다/.test(text), false, "출근하지 않았는데 출근했다고 말한다");
    assert.match(text, /오피스에 연결하면/, "다음에 무엇을 해야 하는지 안내가 없다");
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("announces attendance results in one line when there's an attached channel", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(2), calls));
    await createAndOpenModel(el);
    assert.match(el.textContent ?? "", /오피스 2곳에 출근했습니다/);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finishing step 3 ends the wizard and passes along that employee's name", async () => {
  const calls: FetchCall[] = [];
  const done: Array<{ profileName: string } | undefined> = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(
      wizardWith(PROFILE_ROUTES(1), calls, undefined, (r) => done.push(r)),
    );
    await createAndOpenModel(el);
    await act(async () => {
      buttonByText(el, "완료").click();
    });
    assert.deepEqual(done, [{ profileName: "mia" }]);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notifies the outer list as soon as a profile is created", async () => {
  // Without notifying, the profile list below stays on "no profiles registered" until the
  // wizard closes, making the just-created employee look like it vanished.
  const calls: FetchCall[] = [];
  const created: string[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(
      wizardWith(PROFILE_ROUTES(0), calls, (name) => created.push(name)),
    );
    await createProfile(el);
    assert.deepEqual(created, ["mia"]);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("step 2 for a just-created profile opens an empty editor right away — it doesn't ask to overwrite", async () => {
  // Observed locally 2026-09-18: for a new profile (SOUL.md = Hermes default template,
  // isDefaultTemplate: true), step 2 asked "an identity already exists. What would you like
  // to do?" Step 1's serving check only stored the identity response it received without
  // deciding an edit mode, so step 2 neither re-read it nor re-decided.
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(1), calls));
    await createProfile(el);
    await act(async () => {
      tabByNumber(el, "②")!.click();
    });
    const text = el.textContent ?? "";
    assert.equal(
      text.includes("이미 작성된 인격이 있습니다"),
      false,
      "새 프로필인데 덮어쓸지 묻는다",
    );
    assert.ok(el.querySelector("textarea"), "인격 편집기가 열리지 않았다");
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only asks to clone the new profile from the default profile when the plugin supports cloning", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const clone of [true, false]) {
      const calls: FetchCall[] = [];
      const { root, el } = await mount(
        wizardWith(PROFILE_ROUTES(1), calls, undefined, () => {}, clone),
      );
      await createProfile(el);
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/plugin/profiles"));
      assert.ok(post, "프로필 생성 요청이 없다");
      assert.deepEqual(
        post.body,
        clone ? { name: "mia", cloneFrom: "default" } : { name: "mia" },
        clone ? "복제를 요청하지 않았다" : "구버전 플러그인에 모르는 필드를 보냈다",
      );
      root.unmount();
      el.remove();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saves only what's checked in the toolset checklist, and never sends the top-level toolsets unused in conversation", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(1), calls));
    await createAndOpenModel(el);
    await act(async () => {
      await Promise.resolve();
    });

    // Saving without touching anything must not overwrite the server's current state.
    await act(async () => {
      buttonByText(el, "저장").click();
    });
    let put = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/config")).at(-1);
    assert.ok(put, "저장 요청이 없다");
    assert.equal("enabledToolsets" in (put.body as object), false);
    assert.equal("toolsets" in (put.body as object), false);

    const tts = el.querySelector<HTMLInputElement>('input[data-toolset="tts"]');
    assert.ok(tts, "툴셋 체크리스트가 보이지 않는다");
    await act(async () => {
      tts.click();
    });
    await act(async () => {
      buttonByText(el, "저장").click();
    });
    put = calls.filter((c) => c.method === "PUT" && c.url.endsWith("/config")).at(-1);
    assert.deepEqual((put!.body as { enabledToolsets?: string[] }).enabledToolsets?.sort(), [
      "tts",
      "web",
    ]);
    assert.equal("toolsets" in (put!.body as object), false);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the old comma-separated input instead of a checklist on an older plugin", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const routes = {
      ...PROFILE_ROUTES(1),
      "/toolsets": { errorCode: "plugin_upgrade_required" },
      "/skills": { errorCode: "plugin_upgrade_required" },
    };
    // A spread preserves key order, so "/plugin/profiles" still comes last.
    const { root, el } = await mount(wizardWith(routes, calls));
    await createAndOpenModel(el);
    await act(async () => {
      await Promise.resolve();
    });
    const text = [...el.querySelectorAll("input")].find((i) => i.placeholder === "툴셋");
    assert.ok(text, "텍스트 입력으로 떨어지지 않았다 — 툴셋을 지정할 방법이 사라진다");
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("turning on 'also copy all API keys' sends cloneKeys:api_keys, turning it off omits it", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const all of [true, false]) {
      const calls: FetchCall[] = [];
      const { root, el } = await mount(
        wizardWith(PROFILE_ROUTES(1), calls, undefined, () => {}, true),
      );
      const box = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((b) =>
        b.parentElement?.textContent?.includes("모든 API 키도 함께 복사"),
      );
      assert.ok(box, "키 복사 범위 체크박스가 없다");
      if (all) {
        await act(async () => {
          box.click();
        });
      }
      await createProfile(el);
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/plugin/profiles"));
      assert.deepEqual(
        post?.body,
        all
          ? { name: "mia", cloneFrom: "default", cloneKeys: "api_keys" }
          : { name: "mia", cloneFrom: "default" },
      );
      root.unmount();
      el.remove();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not show the key-copy checkbox on a gateway that doesn't support cloning", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const { root, el } = await mount(wizardWith(PROFILE_ROUTES(1), calls));
    assert.equal((el.textContent ?? "").includes("모든 API 키도 함께 복사"), false);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const AUTH_CATALOG = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      authenticated: false,
      authType: "api_key",
      envVars: ["OPENAI_API_KEY"],
    },
  ],
  models: {},
  reasoningEfforts: [],
};

async function openModelFor(canManageProviderAuth: boolean) {
  const calls: FetchCall[] = [];
  globalThis.fetch = stubFetch(calls, {
    "/config": { model: null, provider: null, toolsets: null, reasoning_effort: null },
    "/catalog": AUTH_CATALOG,
    "/identity": { isDefaultTemplate: true, body: "", revision: "r0" },
  }) as typeof fetch;
  const mounted = await mount(
    <I18nProvider initialLocale="ko">
      <NpcHireWizard
        gatewayId="gw-1"
        pluginStatus="plugin_ready"
        localDiscovery={false}
        existingProfiles={["oliver"]}
        initialProfile="oliver"
        canManageProviderAuth={canManageProviderAuth}
        onDone={() => {}}
      />
    </I18nProvider>,
  );
  await act(async () => {
    tabByNumber(mounted.el, "④")!.click();
  });
  const select = mounted.el.querySelector("select")!;
  return { ...mounted, select };
}

test("an owner can pick an unauthenticated provider and enter its key right there", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { root, el, select } = await openModelFor(true);
    const option = [...select.options].find((o) => o.value === "openai");
    assert.equal(option?.disabled, false, "인증 안 된 프로바이더를 고를 수 없다");
    await act(async () => {
      select.value = "openai";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.ok(el.querySelector('input[type="password"]'), "키 입력 패널이 나오지 않았다");
    // The old "go to the dashboard" guidance is hidden as redundant when in-app auth is available.
    assert.equal((el.textContent ?? "").includes("직원마다"), false);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tells a shared user the owner needs to set it up, instead of showing key input", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const { root, el, select } = await openModelFor(false);
    const option = [...select.options].find((o) => o.value === "openai");
    assert.equal(option?.disabled, true, "누를 수 없는 인증을 고르게 한다");
    assert.ok(!el.querySelector('input[type="password"]'));
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unauthenticated provider keeps model disabled, and switches to a dropdown once the list arrives after login", async () => {
  // Staging 2026-09-19: Codex was unauthenticated so the catalog had no model list, the model
  // field fell back to free-text input, and a typo like "gpt-6-astra S" was accepted as-is.
  const originalFetch = globalThis.fetch;
  let authenticated = false;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: undefined });
    const payload = url.includes("/catalog")
      ? {
          providers: [
            {
              id: "openai-codex",
              name: "OpenAI Codex",
              authenticated,
              // Omit authType so the old "Confirm login" guidance is used again — the panel's
              // login completion also calls the same loadCatalog.
            },
          ],
          models: authenticated ? { "openai-codex": ["gpt-6", "gpt-6-mini"] } : {},
          reasoningEfforts: [],
        }
      : url.includes("/config")
        ? { model: "gpt-6-astra", provider: "openai-codex", toolsets: null }
        : { isDefaultTemplate: true, body: "", revision: "r0" };
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const { root, el } = await mount(
      <I18nProvider initialLocale="ko">
        <NpcHireWizard
          gatewayId="gw-1"
          pluginStatus="plugin_ready"
          localDiscovery={false}
          existingProfiles={["oliver"]}
          initialProfile="oliver"
          canManageProviderAuth
          onDone={() => {}}
        />
      </I18nProvider>,
    );
    await act(async () => {
      tabByNumber(el, "④")!.click();
    });
    const modelField = () => el.querySelectorAll("select")[1] as HTMLSelectElement | undefined;
    assert.equal(
      [...el.querySelectorAll("input")].some((i) => i.placeholder === "모델"),
      false,
      "인증 전인데 모델을 자유 입력으로 받는다",
    );
    assert.equal(modelField()?.disabled, true, "인증 전 모델 칸이 비활성이 아니다");
    assert.equal(modelField()?.value, "gpt-6-astra", "저장된 모델 값을 잃었다");

    authenticated = true;
    await act(async () => {
      buttonByText(el, "로그인 확인").click();
    });
    const after = modelField();
    assert.equal(after?.disabled, false);
    assert.deepEqual(
      [...(after?.options ?? [])].map((o) => o.value),
      ["", "gpt-6-astra", "gpt-6", "gpt-6-mini"],
      "저장된 모델이 목록에 없으면 앞에 남겨 두어야 한다",
    );
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("step 3 appearance opens the editor with this employee's current appearance, and saving patches that profile row", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const routes = {
      "/gateways/gw-1/profiles/p-mia": { ok: true },
      "/gateways/gw-1/profiles": {
        profiles: [
          { id: "p-other", profileName: "noah", appearance: null },
          {
            id: "p-mia",
            profileName: "mia",
            appearance: { officeLookId: "office-jun", bodyType: "male" },
          },
        ],
      },
      ...PROFILE_ROUTES(1),
    };
    const { root, el } = await mount(wizardWith(routes, calls));
    await createProfile(el);
    await act(async () => {
      tabByNumber(el, "③")!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const save = [...el.querySelectorAll("button")].find((b) => /저장/.test(b.textContent ?? ""));
    assert.ok(save, "외형 편집기의 저장 버튼이 없다");
    await act(async () => {
      save.click();
    });
    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch?.url.endsWith("/gateways/gw-1/profiles/p-mia"), "다른 직원 행을 고쳤다");
    assert.deepEqual(patch?.body, {
      appearance: { officeLookId: "office-jun", bodyType: "male" },
    });
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces a leftover custom endpoint and only clears it after explicit confirmation", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const routes = {
      ...PROFILE_ROUTES(1),
      "/config": {
        model: "x",
        provider: "openrouter",
        toolsets: null,
        reasoning_effort: null,
        baseUrl: "https://old.example/v1",
      },
    };
    const { root, el } = await mount(wizardWith(routes, calls));
    await createAndOpenModel(el);
    const warning = el.querySelector("[data-base-url-warning]");
    assert.ok(warning, "남은 주소를 알리지 않는다");
    assert.match(el.textContent ?? "", /https:\/\/old\.example\/v1/);
    // The warning must be outside the button row — put in the same flex row it squeezes the
    // save/done buttons and wraps their text vertically (2026-09-20, actually happened).
    const actions = el.querySelector("[data-config-actions]");
    assert.ok(actions, "버튼 줄을 찾지 못했다");
    assert.equal(actions.contains(warning), false, "경고가 버튼 줄 안에 있다");
    for (const button of actions.querySelectorAll("button"))
      assert.match(button.className, /whitespace-nowrap/, "버튼 글자가 줄바꿈될 수 있다");

    // Saving without confirmation must not touch the endpoint — a custom endpoint is never silently cleared.
    await act(async () => {
      buttonByText(el, "저장").click();
    });
    const first = calls.filter((c) => c.method === "PUT" && c.url.includes("/config")).at(-1);
    assert.equal((first?.body as Record<string, unknown>)?.clearBaseUrl, undefined);

    const checkbox = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1);
    assert.ok(checkbox, "지우기 확인칸을 찾지 못했다");
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      buttonByText(el, "저장").click();
    });
    const second = calls.filter((c) => c.method === "PUT" && c.url.includes("/config")).at(-1);
    assert.equal((second?.body as Record<string, unknown>)?.clearBaseUrl, true);
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with worker propagation disabled on the gateway, the hire result shows a notice that output won't collect, with a link to enable it", async () => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  try {
    const routes = {
      ...PROFILE_ROUTES(1),
      "/plugin/profiles": {
        name: "mia",
        keyIssued: true,
        keyStored: true,
        attendedChannels: 1,
        workerPlugin: { skipped: "propagation_disabled" },
      },
    };
    const { root, el } = await mount(wizardWith(routes, calls));
    await createAndOpenModel(el);
    const notice = el.querySelector('[data-worker-propagation-notice="disabled"]');
    assert.ok(notice, "알림이 없다");
    assert.match(notice.textContent ?? "", /칸반·크론 결과물은 모이지 않습니다/);
    assert.equal(notice.querySelector("a")?.getAttribute("href"), "/gateways?gateway=gw-1");
    root.unmount();
    el.remove();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no notice when the worker was applied, or on an old plugin (no workerPlugin)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const workerPlugin of [{ profile: "mia", link: "created", enabled: "added" }, undefined]) {
      const calls: FetchCall[] = [];
      const routes = {
        ...PROFILE_ROUTES(1),
        "/plugin/profiles": {
          name: "mia",
          keyIssued: true,
          keyStored: true,
          attendedChannels: 1,
          ...(workerPlugin ? { workerPlugin } : {}),
        },
      };
      const { root, el } = await mount(wizardWith(routes, calls));
      await createAndOpenModel(el);
      assert.ok(!el.querySelector("[data-worker-propagation-notice]"));
      root.unmount();
      el.remove();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
