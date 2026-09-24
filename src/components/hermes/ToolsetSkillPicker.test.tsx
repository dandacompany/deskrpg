import "../../test-setup/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../lib/i18n/context";
import ToolsetSkillPicker from "./ToolsetSkillPicker";

const TOOLSETS = {
  platform: "api_server",
  toolsets: [
    { name: "web", label: "🔍 Web", description: "검색", enabled: true, configured: true },
    { name: "tts", label: "🔊 TTS", description: "음성", enabled: false, configured: false },
  ],
};
const SKILLS = {
  skills: [
    {
      name: "hermes-agent",
      category: "core",
      description: "필수",
      disabled: false,
      essential: true,
    },
    { name: "pdf", category: "docs", description: "PDF", disabled: true, essential: false },
  ],
};

function stubFetch(map: Record<string, unknown>) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    const key = Object.keys(map).find((k) => String(url).endsWith(k))!;
    return new Response(JSON.stringify(map[key]), { status: 200 });
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function mount(props: Partial<React.ComponentProps<typeof ToolsetSkillPicker>>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <ToolsetSkillPicker
          profileBase="/api/gateways/g/plugin/profiles/noah"
          enabledToolsets={null}
          onEnabledToolsetsChange={() => {}}
          disabledSkills={null}
          onDisabledSkillsChange={() => {}}
          {...props}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("loads the list, checks it based on the server's state as default, and reports via onLoaded", async () => {
  const f = stubFetch({ "/toolsets": TOOLSETS, "/skills": SKILLS });
  const loaded: unknown[] = [];
  const { host, unmount } = await mount({ onLoaded: (v) => loaded.push(v) });
  try {
    assert.deepEqual(f.urls.sort(), [
      "/api/gateways/g/plugin/profiles/noah/skills",
      "/api/gateways/g/plugin/profiles/noah/toolsets",
    ]);
    assert.deepEqual(loaded, [{ enabledToolsets: ["web"], disabledSkills: ["pdf"] }]);
    const box = (name: string) =>
      host.querySelector<HTMLInputElement>(`input[data-toolset="${name}"]`)!;
    assert.equal(box("web").checked, true);
    assert.equal(box("tts").checked, false);
    assert.ok(host.textContent?.includes("키 필요"));
    // A checked skill checkbox means "on" — the inverse of disabled.
    assert.equal(host.querySelector<HTMLInputElement>('input[data-skill="pdf"]')!.checked, false);
    assert.equal(
      host.querySelector<HTMLInputElement>('input[data-skill="hermes-agent"]')!.disabled,
      true,
    );
  } finally {
    await unmount();
    f.restore();
  }
});

test("changing a check reports the new list", async () => {
  const f = stubFetch({ "/toolsets": TOOLSETS, "/skills": SKILLS });
  const toolsets: string[][] = [];
  const skills: string[][] = [];
  const { host, unmount } = await mount({
    enabledToolsets: ["web"],
    disabledSkills: ["pdf"],
    onEnabledToolsetsChange: (v) => toolsets.push(v),
    onDisabledSkillsChange: (v) => skills.push(v),
  });
  try {
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-toolset="tts"]')!.click(),
    );
    await act(async () => host.querySelector<HTMLInputElement>('input[data-skill="pdf"]')!.click());
    assert.deepEqual(toolsets, [["tts", "web"]]);
    assert.deepEqual(skills, [[]]);
  } finally {
    await unmount();
    f.restore();
  }
});

test("renders nothing and calls onUnsupported on an old plugin", async () => {
  const f = stubFetch({
    "/toolsets": { errorCode: "plugin_upgrade_required" },
    "/skills": { errorCode: "plugin_upgrade_required" },
  });
  let called = 0;
  const { host, unmount } = await mount({
    onUnsupported: () => {
      called += 1;
    },
  });
  try {
    assert.equal(called, 1);
    assert.equal(host.querySelectorAll("input").length, 0);
  } finally {
    await unmount();
    f.restore();
  }
});

test("a different error shows a message and a retry button", async () => {
  const f = stubFetch({ "/toolsets": { errorCode: "config_unreadable" }, "/skills": SKILLS });
  const { host, unmount } = await mount({});
  try {
    assert.ok(
      Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("다시 시도")),
    );
  } finally {
    await unmount();
    f.restore();
  }
});

test("never carries a name the plugin would reject, even if it's in the parent's given list", async () => {
  const f = stubFetch({ "/toolsets": TOOLSETS, "/skills": SKILLS });
  const toolsets: string[][] = [];
  const skills: string[][] = [];
  const { host, unmount } = await mount({
    // config GET's enabledToolsets can have MCP server names mixed in.
    enabledToolsets: ["web", "my-mcp", "ghost-toolset"],
    disabledSkills: ["pdf", "hermes-agent", "ghost-skill"],
    onEnabledToolsetsChange: (v) => toolsets.push(v),
    onDisabledSkillsChange: (v) => skills.push(v),
  });
  try {
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[data-toolset="tts"]')!.click(),
    );
    await act(async () => host.querySelector<HTMLInputElement>('input[data-skill="pdf"]')!.click());
    assert.deepEqual(toolsets, [["tts", "web"]]);
    assert.deepEqual(skills, [[]]);
  } finally {
    await unmount();
    f.restore();
  }
});

test("an owner sees 'Configure' on a tool with a provider choice, and checking a keyless tool opens the config popup", async () => {
  const withProviders = {
    ...TOOLSETS,
    toolsets: TOOLSETS.toolsets.map((t) => ({ ...t, hasProviders: t.name === "tts" })),
  };
  const providers = {
    toolset: "tts",
    hasProviders: true,
    activeProvider: null,
    cliCommand: "hermes -p noah tools",
    providers: [],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const body = u.endsWith("/providers")
      ? providers
      : u.endsWith("/skills")
        ? SKILLS
        : withProviders;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const { host, unmount } = await mount({ canManageToolProviders: true });
  try {
    assert.ok(host.querySelector('[data-configure-tool="tts"]'), "tts 에 설정이 없다");
    assert.equal(
      host.querySelector('[data-configure-tool="web"]'),
      null,
      "web 에는 설정이 없어야 한다",
    );
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[data-toolset="tts"]')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const panel = host.querySelector('[data-tool-panel="tts"]');
    assert.ok(panel, "키 없는 도구를 켰는데 설정이 열리지 않았다");
    // Shown as a popup rather than expanded inline in the list.
    assert.ok(panel.closest("[data-modal-overlay]"), "설정이 팝업이 아니라 목록 안에 펼쳐졌다");
    const close = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "닫기",
    )!;
    await act(async () => close.click());
    assert.equal(host.querySelector("[data-modal-overlay]"), null, "닫기로 팝업이 닫히지 않았다");
  } finally {
    globalThis.fetch = original;
    await unmount();
  }
});

test("a shared user has no 'Configure'", async () => {
  const withProviders = {
    ...TOOLSETS,
    toolsets: TOOLSETS.toolsets.map((t) => ({ ...t, hasProviders: true })),
  };
  const f = stubFetch({ "/toolsets": withProviders, "/skills": SKILLS });
  const { host, unmount } = await mount({});
  try {
    assert.equal(host.querySelector("[data-configure-tool]"), null);
  } finally {
    f.restore();
    await unmount();
  }
});
