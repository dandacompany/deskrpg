import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import type { AutomationBlueprint } from "@/lib/hermes/deskrpg-plugin-types";
import BlueprintGallery, {
  initialBlueprintValues,
  missingRequiredFields,
} from "./BlueprintGallery";

const NPCS = [
  { npcId: "npc-a", npcName: "소피" },
  { npcId: "npc-b", npcName: "제인" },
];

const BLUEPRINT: AutomationBlueprint = {
  key: "daily-brief",
  title: "아침 브리핑",
  description: "매일 아침 할 일을 정리한다",
  category: "productivity",
  tags: ["daily", "brief"],
  fields: [
    { name: "time", type: "time", label: "시각", default: "09:00" },
    { name: "days", type: "weekdays", label: "요일", options: ["weekdays", "daily"], strict: true },
    { name: "focus", type: "text", label: "관심사", optional: true, help: "예: 영업" },
    { name: "deliver", type: "enum", label: "배달처", default: "origin", options: ["origin"] },
  ],
  command: "hermes cron add ...",
  appUrl: "",
};

test("initialBlueprintValues — fills defaults and turns deliver's origin into local", () => {
  assert.deepEqual(initialBlueprintValues(BLUEPRINT), {
    time: "09:00",
    days: "",
    focus: "",
    deliver: "local",
  });
  assert.deepEqual(missingRequiredFields(BLUEPRINT, initialBlueprintValues(BLUEPRINT)), ["days"]);
});

test("gallery — list (title/description/category/tags) -> select -> field form -> instantiate with assigned NPC (R21)", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/blueprints/instantiate")) {
      return new Response(JSON.stringify({ job: { id: "new", name: "아침 브리핑" } }), {
        status: 201,
      });
    }
    if (url.includes("/blueprints")) {
      return new Response(JSON.stringify({ blueprints: [BLUEPRINT] }), { status: 200 });
    }
    return new Response(JSON.stringify({ targets: [] }), { status: 200 });
  }) as typeof fetch;

  const created: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <BlueprintGallery
            channelId="ch1"
            npcs={NPCS}
            defaultNpcId="npc-b"
            onCreated={(job) => created.push(job.id)}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(calls[0].url, "/api/channels/ch1/cron/blueprints?npcId=npc-b");

    const item = host.querySelector('[role="listitem"]');
    assert.ok(item);
    assert.match(item.textContent ?? "", /아침 브리핑/);
    assert.match(item.textContent ?? "", /매일 아침 할 일을 정리한다/);
    assert.match(item.textContent ?? "", /productivity/);
    assert.match(item.textContent ?? "", /#daily/);

    await act(async () => (item.querySelector("button") as HTMLButtonElement).click());
    const submit = host.querySelector('[data-testid="bp-submit"]') as HTMLButtonElement;
    assert.equal(submit.disabled, true, "필수 필드(days)가 비어 있으면 만들기 불가");

    // strict enum/weekdays renders as a select.
    const days = Array.from(host.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "weekdays"),
    ) as HTMLSelectElement;
    assert.ok(days);
    await act(async () => {
      days.value = "weekdays";
      days.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(submit.disabled, false);
    await act(async () => submit.click());

    const instantiate = calls.find((c) => c.url.endsWith("/blueprints/instantiate"));
    assert.deepEqual(instantiate?.body, {
      npcId: "npc-b",
      blueprint: "daily-brief",
      values: { time: "09:00", days: "weekdays", focus: "", deliver: "local" },
    });
    assert.deepEqual(created, ["new"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
