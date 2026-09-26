import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n";
import TaskEditorDialog from "./TaskEditorDialog";
import { EMPTY_TASK_FORM } from "./kanban-view-model";

test("registering from a conversation preserves the original text and submits after confirming completion criteria and assignee", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const bodies: Record<string, unknown>[] = [];
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <TaskEditorDialog
            mode="create"
            initial={{
              ...EMPTY_TASK_FORM,
              title: "안내",
              body: "원래 요청과 답변",
              assigneeNpcId: "n1",
            }}
            npcs={[{ npcId: "n1", npcName: "직원", profileName: "worker", active: true }]}
            candidates={[]}
            serverError={null}
            submitting={false}
            confirmChatDraft
            onSubmit={(body) => bodies.push(body)}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );
    const form = host.querySelector("form")!;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(bodies.length, 0, "완료 조건이 없으면 제출하지 않는다");
    const criteria = host.querySelector<HTMLTextAreaElement>("#kanban-completion-criteria");
    assert.ok(criteria);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        criteria,
        "담당자와 마감일을 포함한 세 문장",
      );
      criteria.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(bodies.length, 1);
    assert.match(String(bodies[0].body), /원래 요청과 답변/);
    assert.match(String(bodies[0].body), /담당자와 마감일을 포함한 세 문장/);
    assert.equal(bodies[0].assignee, "n1");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("upstream Hermes: a new card has no approval picker, says it completes without approval, and sends no policy", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const bodies: Record<string, unknown>[] = [];
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <TaskEditorDialog
            mode="create"
            reviewSupported={false}
            initial={{
              ...EMPTY_TASK_FORM,
              reviewMode: undefined,
              title: "업무",
              assigneeNpcId: "n1",
            }}
            npcs={[{ npcId: "n1", npcName: "실행", profileName: "worker", active: true }]}
            candidates={[]}
            serverError={null}
            submitting={false}
            onSubmit={(body) => bodies.push(body)}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );
    assert.equal(Boolean(host.querySelector("#kanban-review-mode")), false);
    assert.match(
      host.querySelector("[data-no-approval-notice]")?.textContent ?? "",
      /승인 없이 완료/,
    );
    const criteria = host.querySelector<HTMLTextAreaElement>("#kanban-completion-criteria");
    if (criteria)
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
          criteria,
          "검증한 세 문장",
        );
        criteria.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(bodies.length, 1);
    assert.equal("reviewPolicy" in bodies[0], false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("a new card's approval defaults to human, and the same profile is excluded from the AI reviewer list", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const bodies: Record<string, unknown>[] = [];
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <TaskEditorDialog
            mode="create"
            initial={{ ...EMPTY_TASK_FORM, title: "업무", assigneeNpcId: "n1" }}
            npcs={[
              { npcId: "n1", npcName: "실행", profileName: "worker", active: true },
              { npcId: "alias", npcName: "동일 프로필", profileName: "worker", active: true },
              { npcId: "n2", npcName: "검토", profileName: "reviewer", active: true },
            ]}
            candidates={[]}
            serverError={null}
            submitting={false}
            onSubmit={(body) => bodies.push(body)}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );
    const mode = host.querySelector<HTMLSelectElement>("#kanban-review-mode");
    assert.ok(mode);
    assert.equal(mode.value, "human");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(bodies.length, 0, "일반 새 카드도 완료 조건이 필요하다");
    const criteria = host.querySelector<HTMLTextAreaElement>("#kanban-completion-criteria");
    assert.ok(criteria);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        criteria,
        "검증한 세 문장",
      );
      criteria.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.deepEqual(bodies[0].reviewPolicy, { mode: "human" });
    await act(async () => {
      mode.value = "agent";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const reviewer = host.querySelector<HTMLSelectElement>("#kanban-reviewer");
    assert.ok(reviewer);
    assert.deepEqual(
      [...reviewer.options].map((x) => x.value),
      ["", "n2"],
    );
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(bodies.length, 1, "검토자를 고르기 전에는 저장하지 않는다");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

async function renderEditor(props: Partial<Parameters<typeof TaskEditorDialog>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <TaskEditorDialog
          mode="create"
          initial={{ ...EMPTY_TASK_FORM, title: "업무", assigneeNpcId: "n1" }}
          npcs={[
            { npcId: "n1", npcName: "실행", profileName: "worker", active: true },
            { npcId: "n2", npcName: "검토", profileName: "reviewer", active: true },
          ]}
          candidates={[]}
          serverError={null}
          submitting={false}
          onSubmit={() => {}}
          onClose={() => {}}
          {...props}
        />
      </I18nProvider>,
    ),
  );
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("mixed review is offered only where the gateway can enforce it", async () => {
  const hooks = await renderEditor({ mixedSupported: true });
  try {
    const options = [
      ...hooks.host.querySelector<HTMLSelectElement>("#kanban-review-mode")!.options,
    ].map((o) => o.value);
    assert.deepEqual(options, ["human", "agent", "mixed"]);
  } finally {
    await hooks.cleanup();
  }
  const patch = await renderEditor({ mixedSupported: false });
  try {
    const options = [
      ...patch.host.querySelector<HTMLSelectElement>("#kanban-review-mode")!.options,
    ].map((o) => o.value);
    assert.deepEqual(options, ["human", "agent"]);
  } finally {
    await patch.cleanup();
  }
});

test("mixed review asks for an AI reviewer like agent review", async () => {
  const view = await renderEditor({
    mixedSupported: true,
    initial: { ...EMPTY_TASK_FORM, title: "업무", assigneeNpcId: "n1", reviewMode: "mixed" },
  });
  try {
    assert.equal(Boolean(view.host.querySelector("#kanban-reviewer")), true);
  } finally {
    await view.cleanup();
  }
});
