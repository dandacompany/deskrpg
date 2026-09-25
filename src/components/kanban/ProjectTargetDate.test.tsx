import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import { KanbanApiError } from "./kanban-api";
import type { ProjectOption } from "./ProjectPicker";
import { ProjectTargetDate } from "./ProjectTargetDate";

const PROJECT: ProjectOption = {
  id: "p1",
  boardSlug: "deskrpg-p1",
  name: "Launch",
  status: "in_progress",
  isEventCarrier: true,
  targetDate: "2026-10-31",
};

type Props = Parameters<typeof ProjectTargetDate>[0];

async function mount(props: Partial<Props>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <ProjectTargetDate project={PROJECT} canManage onSave={async () => {}} {...props} />
      </I18nProvider>,
    ),
  );
  return {
    host,
    input: () => host.querySelector<HTMLInputElement>("[data-project-target-date]"),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** React tracks the value it last rendered; the native setter makes it see a user edit. */
async function typeDate(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

test("the owner sees the project's target date and saves a new one", async () => {
  const saved: Array<[string, string | null]> = [];
  const f = await mount({
    onSave: async (id, date) => {
      saved.push([id, date]);
    },
  });
  const input = f.input();
  assert.ok(input, "date input is shown");
  assert.equal(input.value, "2026-10-31");
  await typeDate(input, "2026-11-15");
  assert.deepEqual(saved, [["p1", "2026-11-15"]]);
  await f.cleanup();
});

test("the owner clears the target date", async () => {
  const saved: Array<[string, string | null]> = [];
  const f = await mount({
    onSave: async (id, date) => {
      saved.push([id, date]);
    },
  });
  await act(async () => {
    f.host.querySelector<HTMLButtonElement>("[data-project-target-date-clear]")?.click();
  });
  assert.deepEqual(saved, [["p1", null]]);
  await f.cleanup();
});

test("no clear button when the project has no target date", async () => {
  const f = await mount({ project: { ...PROJECT, targetDate: null } });
  assert.equal(f.input()?.value, "");
  assert.ok(!f.host.querySelector("[data-project-target-date-clear]"));
  await f.cleanup();
});

test("a member doesn't get the input", async () => {
  const f = await mount({ canManage: false });
  assert.ok(!f.input(), "members can't set the target date");
  await f.cleanup();
});

test("a refused date is explained and the input goes back to the saved value", async () => {
  const f = await mount({
    onSave: async () => {
      throw new KanbanApiError({ status: 400, code: "invalid_target_date", message: "bad" });
    },
  });
  const input = f.input();
  assert.ok(input);
  await typeDate(input, "2026-11-15");
  assert.match(f.host.querySelector("[role=alert]")?.textContent ?? "", /날짜/);
  assert.equal(input.value, "2026-10-31");
  await f.cleanup();
});
