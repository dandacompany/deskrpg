import "../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import { DEFAULT_NPC_MOTION } from "@/lib/npc-motion-config";
import ChannelSettingsModal from "./ChannelSettingsModal";

/** Fake every request the modal makes and only collect the PUT bodies. */
function fakeFetch() {
  const puts: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT" && init.body) puts.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ members: [], gatewayConfig: null }), { status: 200 });
  }) as typeof fetch;
  return { puts, restore: () => (globalThis.fetch = original) };
}

async function mount(onUpdated: (d: unknown) => void = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ChannelSettingsModal
          channelId="c1"
          channelName="채널"
          channelDescription={null}
          isPublic
          inviteCode={null}
          motionConfig={DEFAULT_NPC_MOTION}
          onClose={() => {}}
          onUpdated={onUpdated}
        />
      </I18nProvider>,
    );
  });
  return host;
}

async function save(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((b) =>
    /Save|저장/.test(b.textContent ?? ""),
  );
  assert.ok(button, "저장 버튼이 없습니다");
  await act(async () => (button as HTMLButtonElement).click());
}

async function slide(host: HTMLElement, kind: string, value: number) {
  const input = host.querySelector(`[data-motion-kind="${kind}"]`) as HTMLInputElement | null;
  assert.ok(input, `${kind} 속도 칸이 없습니다`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("has four speed fields and, at defaults, shows summon/meeting-summon as 'running'", async () => {
  const net = fakeFetch();
  try {
    const host = await mount();
    for (const kind of ["summon", "meetingSummon", "walk", "stroll"])
      assert.ok(host.querySelector(`[data-motion-kind="${kind}"]`), kind);
    const text = host.querySelector("[data-motion-settings]")?.textContent ?? "";
    assert.equal((text.match(/running/g) ?? []).length, 2, `뛰기 표시: ${text}`);
  } finally {
    net.restore();
  }
});

test("changing the speed and saving includes motionConfig in the PUT body and notifies the parent", async () => {
  const net = fakeFetch();
  const updates: Record<string, unknown>[] = [];
  try {
    const host = await mount((d) => updates.push(d as Record<string, unknown>));
    await slide(host, "summon", 400);
    await save(host);
    assert.deepEqual(net.puts.at(-1)?.motionConfig, { ...DEFAULT_NPC_MOTION, summon: 400 });
    assert.deepEqual(updates.at(-1)?.motionConfig, { ...DEFAULT_NPC_MOTION, summon: 400 });
  } finally {
    net.restore();
  }
});

test("saving without changing the speed does not include motionConfig", async () => {
  const net = fakeFetch();
  try {
    const host = await mount();
    const name = host.querySelector("input[type=text], input:not([type])") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "새 이름");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await save(host);
    assert.ok(net.puts.length > 0, "저장 요청이 없습니다");
    assert.equal("motionConfig" in (net.puts.at(-1) ?? {}), false);
  } finally {
    net.restore();
  }
});
