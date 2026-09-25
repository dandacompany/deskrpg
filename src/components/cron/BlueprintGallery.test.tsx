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
    // Tags known to the overlay show in the viewer's language; unknown ones keep Hermes' text.
    assert.match(item.textContent ?? "", /#매일/);
    assert.match(item.textContent ?? "", /#brief/);

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

test("an English Hermes blueprint shows in Korean, offers only this channel's bot chats, and sends Hermes' own values", async () => {
  const reminder: AutomationBlueprint = {
    key: "custom-reminder",
    title: "Custom reminder",
    description: "A recurring reminder in your own words, on your schedule.",
    category: "general",
    tags: ["reminder"],
    fields: [
      { name: "what", type: "text", label: "Remind me to…", default: "take a break and stretch" },
      {
        name: "time",
        type: "time",
        label: "What time?",
        default: "14:00",
        help: "24h local time, e.g. 08:00",
      },
      {
        name: "recurrence",
        type: "weekdays",
        label: "Repeat on",
        default: "everyday",
        options: ["everyday", "weekdays", "weekends"],
      },
      {
        name: "deliver",
        type: "enum",
        label: "Where to deliver?",
        default: "origin",
        strict: false,
      },
    ],
    command: "",
    appUrl: "",
  };
  const targets = ["local", "bot-chat:default", "bot-chat:sophie", "bot-chat:mia"].map((id) => ({
    id,
    name: id === "local" ? "Local" : `Bot Chat (${id.split(":")[1]})`,
    home_target_set: true,
    home_env_var: "",
  }));
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("/blueprints/instantiate"))
      return new Response(JSON.stringify({ job: { id: "new" } }), { status: 201 });
    if (url.includes("/blueprints"))
      return new Response(JSON.stringify({ blueprints: [reminder] }), { status: 200 });
    return new Response(JSON.stringify({ targets }), { status: 200 });
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="ko">
          <BlueprintGallery
            channelId="ch1"
            npcs={[{ npcId: "npc-a", npcName: "소피", profileName: "sophie" }]}
            onCreated={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const item = host.querySelector('[role="listitem"]') as HTMLElement;
    assert.doesNotMatch(item.textContent ?? "", /Custom reminder|A recurring reminder/);
    assert.match(item.textContent ?? "", /[가-힣]/);

    await act(async () => (item.querySelector("button") as HTMLButtonElement).click());
    const form = host.textContent ?? "";
    for (const english of [
      "Remind me to",
      "What time?",
      "Repeat on",
      "Where to deliver",
      "24h",
      "everyday",
    ]) {
      assert.ok(!form.includes(english), `"${english}" should be translated`);
    }
    // Only this channel's employee is offered, by name, with a note on where results arrive.
    assert.match(form, /소피/);
    assert.ok(!/default|mia/.test(form), "other profiles on the gateway are not offered");
    assert.ok(host.querySelector('[data-testid="bp-deliver-hint"]'));

    await act(async () =>
      (host.querySelector('[data-testid="bp-submit"]') as HTMLButtonElement).click(),
    );
    const sent = calls.find((c) => c.url.endsWith("/blueprints/instantiate"))?.body as {
      values: Record<string, string>;
    };
    assert.equal(sent.values.recurrence, "everyday", "option values stay Hermes' own");
    assert.equal(sent.values.time, "14:00");
    assert.equal(sent.values.deliver, "local");
    assert.match(
      sent.values.what,
      /[가-힣]/,
      "the editable reminder sentence is in the user's language",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
