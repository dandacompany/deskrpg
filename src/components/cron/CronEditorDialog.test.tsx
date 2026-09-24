import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n";
import CronEditorDialog, { type CronEditorSubmit } from "./CronEditorDialog";
import type { CronJobView } from "./cron-api";

const NPCS = [
  { npcId: "npc-a", npcName: "소피" },
  { npcId: "npc-b", npcName: "제인" },
];

const TARGETS = [
  { id: "slack", name: "Slack", home_target_set: true, home_env_var: "SLACK_HOME" },
  { id: "telegram", name: "Telegram", home_target_set: false, home_env_var: "TG_HOME" },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function baseJob(overrides: Partial<CronJobView> = {}): CronJobView {
  return {
    id: "j1",
    name: "브리핑",
    prompt: "오늘 할 일 정리",
    schedule: { kind: "cron", expr: "30 8 * * *" },
    schedule_display: "30 8 * * *",
    repeat: true,
    enabled: true,
    state: "scheduled",
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    deliver: "local,slack",
    skills: [],
    model: "gpt-5",
    provider: "openai",
    created_at: "2026-09-14T00:00:00Z",
    npcId: "npc-a",
    npcName: "소피",
    origin: { channelId: "ch1", createdByUserId: "u1" },
    editable: true,
    ...overrides,
  };
}

async function mount(node: React.ReactElement) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json({ targets: TARGETS })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider initialLocale="ko">{node}</I18nProvider>);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = original;
    },
  };
}

const q = <T extends Element>(host: HTMLElement, id: string) =>
  host.querySelector(`[data-testid="${id}"]`) as T | null;

/** Bypasses React's value tracker by setting via the prototype setter, then dispatches the event. */
async function setValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const isSelect = el.tagName === "SELECT";
  const proto = Object.getPrototypeOf(el) as object;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    if (set) set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event(isSelect ? "change" : "input", { bubbles: true }));
  });
}

test("create form — builds the body from preset expression, comma-joined delivery targets, and split model (R17)", async () => {
  const submitted: CronEditorSubmit[] = [];
  const { host, cleanup } = await mount(
    <CronEditorDialog
      channelId="ch1"
      npcs={NPCS}
      timezone="Asia/Seoul"
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      onClose={() => {}}
    />,
  );
  try {
    assert.equal(q(host, "cron-tz")?.textContent, "Asia/Seoul 기준");
    const submit = q<HTMLButtonElement>(host, "cron-submit")!;
    assert.equal(submit.disabled, true, "프롬프트가 비면 저장 불가");

    await setValue(q<HTMLSelectElement>(host, "cron-npc")!, "npc-b");
    await setValue(q<HTMLInputElement>(host, "cron-name")!, "주간 리포트");
    await setValue(q<HTMLTextAreaElement>(host, "cron-prompt")!, "이번 주 정리");
    await setValue(q<HTMLSelectElement>(host, "cron-preset")!, "weekdays");
    // The delivery-target checkboxes come from the server list.
    const slack = q<HTMLInputElement>(host, "cron-deliver-slack");
    assert.ok(slack, "배달처 목록이 렌더링돼야 한다");
    await act(async () => slack!.click());
    await setValue(q<HTMLInputElement>(host, "cron-model")!, "openrouter:anthropic/claude:beta");

    assert.equal(submit.disabled, false);
    await act(async () => submit.click());
    assert.deepEqual(submitted, [
      {
        npcId: "npc-b",
        name: "주간 리포트",
        prompt: "이번 주 정리",
        schedule: "0 9 * * 1-5",
        deliver: "local,slack",
        model: "anthropic/claude:beta",
        provider: "openrouter",
      },
    ]);
  } finally {
    await cleanup();
  }
});

test("the custom preset sends the expression string as-is (including Hermes schedule strings)", async () => {
  const submitted: CronEditorSubmit[] = [];
  const { host, cleanup } = await mount(
    <CronEditorDialog
      channelId="ch1"
      npcs={NPCS}
      timezone={null}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
      onClose={() => {}}
    />,
  );
  try {
    assert.equal(q(host, "cron-tz")?.textContent, "게이트웨이 시간대 미확인");
    await setValue(q<HTMLTextAreaElement>(host, "cron-prompt")!, "p");
    await setValue(q<HTMLSelectElement>(host, "cron-preset")!, "custom");
    const submit = q<HTMLButtonElement>(host, "cron-submit")!;
    assert.equal(submit.disabled, true, "직접 입력이 비면 저장 불가");
    await setValue(q<HTMLInputElement>(host, "cron-custom-expr")!, "every 10m");
    await act(async () => submit.click());
    assert.equal(submitted[0].schedule, "every 10m");
    assert.equal(submitted[0].deliver, "local");
    assert.equal(submitted[0].model, null);
    assert.equal(submitted[0].provider, null);
  } finally {
    await cleanup();
  }
});

test("edit form — reverse-maps the stored expression to a preset and locks the assigned NPC (R17)", async () => {
  const { host, cleanup } = await mount(
    <CronEditorDialog
      channelId="ch1"
      npcs={NPCS}
      job={baseJob()}
      timezone="Asia/Seoul"
      onSubmit={async () => {}}
      onClose={() => {}}
    />,
  );
  try {
    const npc = q<HTMLSelectElement>(host, "cron-npc")!;
    assert.equal(npc.disabled, true);
    assert.equal(npc.value, "npc-a");
    // `30 8 * * *` has the shape of daily.
    assert.equal(q<HTMLSelectElement>(host, "cron-preset")!.value, "daily");
    assert.equal(q(host, "cron-custom-expr"), null);
    assert.equal(q<HTMLInputElement>(host, "cron-model")!.value, "openai:gpt-5");
    assert.equal(q<HTMLInputElement>(host, "cron-deliver-local")!.checked, true);
    assert.equal(q<HTMLInputElement>(host, "cron-deliver-slack")!.checked, true);
    assert.equal(q<HTMLInputElement>(host, "cron-deliver-telegram")!.checked, false);
  } finally {
    await cleanup();
  }
});

test("edit form — an expression with no matching preset opens as custom with the value in the input", async () => {
  const { host, cleanup } = await mount(
    <CronEditorDialog
      channelId="ch1"
      npcs={NPCS}
      job={baseJob({ schedule: { kind: "every", expr: "*/5 * * * *" }, schedule_display: "" })}
      timezone="Asia/Seoul"
      onSubmit={async () => {}}
      onClose={() => {}}
    />,
  );
  try {
    assert.equal(q<HTMLSelectElement>(host, "cron-preset")!.value, "custom");
    assert.equal(q<HTMLInputElement>(host, "cron-custom-expr")!.value, "*/5 * * * *");
  } finally {
    await cleanup();
  }
});

test("a save failure stays in the form as code/message and does not close", async () => {
  const { CronApiError } = await import("./cron-api");
  let closed = 0;
  const { host, cleanup } = await mount(
    <CronEditorDialog
      channelId="ch1"
      npcs={NPCS}
      job={baseJob()}
      timezone="Asia/Seoul"
      onSubmit={async () => {
        throw new CronApiError(403, "cron_read_only", "nope", {});
      }}
      onClose={() => closed++}
    />,
  );
  try {
    await act(async () => q<HTMLButtonElement>(host, "cron-submit")!.click());
    assert.match(q(host, "cron-error-other")?.textContent ?? "", /cron_read_only: nope/);
    assert.equal(closed, 0);
  } finally {
    await cleanup();
  }
});
