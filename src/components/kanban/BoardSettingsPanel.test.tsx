import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import BoardSettingsPanel from "./BoardSettingsPanel";
import { createKanbanApi, type BoardSettings } from "./kanban-api";

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

async function mount(settings: BoardSettings) {
  const calls: Array<{ method: string; body: unknown }> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return json(settings);
  }) as typeof fetch;
  const api = createKanbanApi("ch-1", fetchImpl);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <BoardSettingsPanel api={api} onClose={() => {}} />
      </I18nProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    host,
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const orchestration = {
  orchestrator_profile: "lead",
  default_assignee: null,
  auto_decompose: true,
  resolved_orchestrator_profile: "lead",
  resolved_default_assignee: "sophie",
  max_in_progress: 2,
  max_in_progress_per_profile: 1,
};

test("editable=false renders every input disabled and hides the save buttons", async () => {
  const f = await mount({
    board: { slug: "b", name: "Board", default_workdir: "/work", editable: false },
    orchestration: { ...orchestration, editable: false },
    hints: { default_assignee_recommend_empty: true },
  });
  try {
    const inputs = Array.from(f.host.querySelectorAll<HTMLInputElement>("input"));
    assert.ok(inputs.length >= 5, "board + orchestration inputs rendered");
    assert.ok(
      inputs.every((input) => input.disabled),
      "all inputs disabled",
    );
    assert.equal(
      Array.from(f.host.querySelectorAll("button")).some((b) => b.textContent?.trim() === "저장"),
      false,
    );
    assert.match(f.host.textContent ?? "", /읽기 전용/);
    assert.match(f.host.textContent ?? "", /비워 두기를 권장/);
    assert.equal(f.host.querySelector<HTMLInputElement>("#kanban-default-workdir")?.value, "/work");
  } finally {
    await f.cleanup();
  }
});

test("orchestration=null hides that section; editable board saves default_workdir via PATCH", async () => {
  const f = await mount({
    board: { slug: "b", name: null, default_workdir: null, editable: true },
    orchestration: null,
    hints: {},
  });
  try {
    assert.ok(!f.host.querySelector('[data-section="orchestration"]'));
    const input = f.host.querySelector<HTMLInputElement>("#kanban-default-workdir");
    assert.ok(input);
    assert.equal(input.disabled, false);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "/new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(f.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "저장",
    );
    assert.ok(save);
    await act(async () => save.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const patch = f.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch?.body, { board: { default_workdir: "/new" } });
  } finally {
    await f.cleanup();
  }
});
