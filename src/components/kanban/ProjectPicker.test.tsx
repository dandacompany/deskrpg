import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";

import { KanbanApiError } from "./kanban-api";
import { ProjectPicker, type ProjectOption } from "./ProjectPicker";

const project = (id: string, status = "in_progress", isEventCarrier = false): ProjectOption => ({
  id,
  boardSlug: `deskrpg-${id}`,
  name: `Project ${id}`,
  status,
  isEventCarrier,
});

type Props = Partial<Parameters<typeof ProjectPicker>[0]>;

async function mount(props: Props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (next: Props) =>
    act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <ProjectPicker options={[]} selected={null} onSelect={() => {}} {...next} />
        </I18nProvider>,
      ),
    );
  await render(props);
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
  return {
    host,
    render,
    settle,
    optionLabels: () =>
      [...host.querySelectorAll("[data-project-picker] option")].map((o) => o.textContent),
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) ?? null,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const click = (el: Element | null) =>
  act(async () => {
    assert.ok(el, "element exists");
    (el as HTMLElement).click();
  });

test("archived projects stay out of the picker until the archived filter is on", async () => {
  const f = await mount({
    options: [project("a", "planned", true), project("b"), project("c", "completed")],
  });
  assert.deepEqual(f.optionLabels(), ["Project a", "Project b"]);
  await click(f.host.querySelector("[data-project-archived-filter]"));
  assert.deepEqual(f.optionLabels(), ["Project a", "Project b", "Project c"]);
  await f.cleanup();
});

test("one active project with an archived one still shows the picker so the filter is reachable", async () => {
  const f = await mount({ options: [project("a", "planned", true), project("c", "cancelled")] });
  assert.ok(f.host.querySelector("[data-project-archived-filter]"));
  assert.deepEqual(f.optionLabels(), ["Project a"]);
  await f.cleanup();
});

test("a selected archived project stays listed even with the filter off", async () => {
  const f = await mount({
    options: [project("a", "planned", true), project("b"), project("c", "completed")],
    selected: "deskrpg-c",
  });
  assert.deepEqual(f.optionLabels(), ["Project a", "Project b", "Project c"]);
  await f.cleanup();
});

test("the owner archives the selected project after confirming", async () => {
  const archived: string[] = [];
  const f = await mount({
    options: [project("a", "planned", true), project("b")],
    selected: "deskrpg-b",
    canManage: true,
    onArchive: async (id) => {
      archived.push(id);
    },
  });
  await click(f.button("보관"));
  assert.deepEqual(archived, [], "the first click only asks");
  await click(f.host.querySelector("[data-project-archive-confirm]"));
  await f.settle();
  assert.deepEqual(archived, ["b"]);
  await f.cleanup();
});

test("a running-card refusal tells the owner how many cards must finish first", async () => {
  const f = await mount({
    options: [project("a", "planned", true), project("b")],
    selected: "deskrpg-b",
    canManage: true,
    onArchive: async () => {
      throw new KanbanApiError({
        status: 409,
        code: "board_has_running_cards",
        message: "2 running",
        extra: { running: 2 },
      });
    },
  });
  await click(f.button("보관"));
  await click(f.host.querySelector("[data-project-archive-confirm]"));
  await f.settle();
  const alert = f.host.querySelector("[role=alert]");
  assert.match(alert?.textContent ?? "", /실행 중인 카드 2장/);
  await f.cleanup();
});

test("no archive button for a member, or for the last active project", async () => {
  const member = await mount({
    options: [project("a", "planned", true), project("b")],
    canManage: false,
  });
  assert.equal(member.host.querySelector("[data-project-archive]"), null);
  await member.cleanup();
  const last = await mount({
    options: [project("a", "planned", true), project("c", "completed")],
    canManage: true,
  });
  assert.equal(last.host.querySelector("[data-project-archive]"), null);
  await last.cleanup();
});

test("an archived selection offers reopening instead of archiving", async () => {
  const reopened: string[] = [];
  const f = await mount({
    options: [project("a", "planned", true), project("c", "completed")],
    selected: "deskrpg-c",
    canManage: true,
    onReopen: async (id) => {
      reopened.push(id);
    },
  });
  assert.equal(f.host.querySelector("[data-project-archive]"), null);
  await click(f.host.querySelector("[data-project-reopen]"));
  await f.settle();
  assert.deepEqual(reopened, ["c"]);
  await f.cleanup();
});
