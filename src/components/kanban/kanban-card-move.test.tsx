import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanTask, KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";

import KanbanColumn from "./KanbanColumn";
import { restoreKanbanMoveFocus, type KanbanMoveEvent } from "./kanban-card-move";

const task = { id: "task-1", title: "Write release notes", status: "todo" } as KanbanTask;

async function mount(options: { disabled?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const events: KanbanMoveEvent[] = [];
  let opened = 0;
  const column = (name: KanbanTaskStatus, tasks: KanbanTask[]) => (
    <KanbanColumn
      name={name}
      tasks={tasks}
      npcs={[]}
      now={0}
      selectedTaskId={null}
      moveDisabled={options.disabled}
      onMoveInteraction={(event) => events.push(event)}
      onOpen={() => opened++}
    />
  );
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <div className="overflow-x-auto">
          {column("todo", [task])}
          {column("ready", [])}
          {column("running", [])}
          {column("blocked", [])}
          <div hidden>{column("archived", [])}</div>
        </div>
      </I18nProvider>,
    ),
  );
  return {
    host,
    events,
    opened: () => opened,
    /** Simulates the parent re-rendering with a new callback identity (happens whenever the board bumps state). */
    rerender: async () =>
      await act(async () =>
        root.render(
          <I18nProvider initialLocale="en">
            <div className="overflow-x-auto">
              {column("todo", [task])}
              {column("ready", [])}
              {column("running", [])}
              {column("blocked", [])}
              <div hidden>{column("archived", [])}</div>
            </div>
          </I18nProvider>,
        ),
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("R2/R3: card body opens details while the dedicated handle starts keyboard movement", async () => {
  const f = await mount();
  try {
    const body = f.host.querySelector<HTMLButtonElement>('[data-card-detail="task-1"]');
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]');
    assert.ok(body);
    assert.ok(handle);
    assert.match(handle.getAttribute("aria-label") ?? "", /Write release notes/);

    await act(async () => body.click());
    assert.equal(f.opened(), 1);

    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    assert.equal(f.opened(), 1, "handle never opens card details");
    assert.deepEqual(f.events.at(-1), { type: "start", taskId: "task-1", source: "todo" });
  } finally {
    await f.cleanup();
  }
});

test("R1/R3: arrows select adjacent visible columns, Enter requests a move, and focus returns", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    handle.focus();
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    assert.equal(
      f.host.querySelector('[data-column="ready"]')?.getAttribute("data-move-target"),
      "true",
    );
    assert.deepEqual(f.events.at(-1), {
      type: "target",
      taskId: "task-1",
      source: "todo",
      target: "ready",
    });
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    assert.deepEqual(f.events.at(-1), {
      type: "submit",
      taskId: "task-1",
      source: "todo",
      target: "ready",
    });
    assert.equal(document.activeElement, handle);
    assert.equal(
      f.host.querySelector('[data-column="ready"]')?.hasAttribute("data-move-target"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("Hermes-owned running is skipped by keyboard movement", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    assert.equal(
      f.host.querySelector('[data-column="running"]')?.hasAttribute("data-move-target"),
      false,
    );
    assert.equal(
      f.host.querySelector('[data-column="blocked"]')?.getAttribute("data-move-target"),
      "true",
    );
    assert.deepEqual(f.events.at(-1), {
      type: "target",
      taskId: "task-1",
      source: "todo",
      target: "blocked",
    });
  } finally {
    await f.cleanup();
  }
});

test("R3/R5: Escape cancels movement without opening details or submitting", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(
      f.events.some((event) => event.type === "submit"),
      false,
    );
    assert.equal(f.events.at(-1)?.type, "cancel");
    assert.equal(f.opened(), 0);
  } finally {
    await f.cleanup();
  }
});

test("R5: disabled movement cannot start", async () => {
  const f = await mount({ disabled: true });
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    assert.equal(handle.disabled, true);
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    assert.deepEqual(f.events, []);
  } finally {
    await f.cleanup();
  }
});

test("R3: Enter while idle does not grab the card", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    assert.deepEqual(f.events, []);
    assert.equal(handle.getAttribute("aria-pressed"), "false");
  } finally {
    await f.cleanup();
  }
});

test("R3/R5: returning to the source column clears the target and Enter does not submit", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    assert.equal(f.host.querySelector('[data-move-target="true"]'), null);
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    assert.equal(
      f.events.some((event) => event.type === "submit"),
      false,
    );
    assert.equal(f.events.at(-1)?.type, "cancel");
  } finally {
    await f.cleanup();
  }
});

test("R2/R5: moving focus to another control cancels without stealing its focus back", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    const body = f.host.querySelector<HTMLButtonElement>('[data-card-detail="task-1"]')!;
    handle.focus();
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    await act(async () => body.focus());
    assert.deepEqual(f.events.at(-1), {
      type: "cancel",
      taskId: "task-1",
      source: "todo",
      reason: "focus-loss",
    });
    assert.equal(document.activeElement, body);
  } finally {
    await f.cleanup();
  }
});

function pointerEvent(type: string, values: Record<string, number>) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: values.clientX,
    clientY: values.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: values.pointerId ?? 1 });
  Object.defineProperty(event, "button", { value: values.button ?? 0 });
  return event;
}

test("R2: pointer movement activates after the threshold and drops on an empty visible column", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointermove", { clientX: 13, clientY: 10 })),
    );
    assert.equal(f.events.length, 0, "small movement remains a tap");
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 10 })),
    );
    assert.equal(f.events[0]?.type, "start");
    assert.equal(ready.dataset.moveTarget, "true");
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointerup", { clientX: 20, clientY: 10 })),
    );
    assert.equal(f.events.at(-1)?.type, "submit");
    assert.equal(f.opened(), 0);
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2: the card never captures the pointer — capture retargets the click to the card and the detail button never hears it", async () => {
  // Behavior confirmed in a real browser (2026-09-20): when the article captures the pointer, the
  // following click goes to the article instead of the inner detail button. So clicking the card
  // did not open the drawer. jsdom does not emulate that retargeting, so this pins down "never
  // calls capture" itself.
  const f = await mount();
  const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
  const captured: number[] = [];
  card.setPointerCapture = (id: number) => void captured.push(id);
  card.releasePointerCapture = () => {};
  const original = document.elementFromPoint;
  try {
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    const detail = f.host.querySelector<HTMLButtonElement>('[data-card-detail="task-1"]')!;
    await act(async () => {
      detail.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
      detail.dispatchEvent(pointerEvent("pointermove", { clientX: 12, clientY: 10 }));
      detail.dispatchEvent(pointerEvent("pointerup", { clientX: 12, clientY: 10 }));
    });
    await act(async () => detail.click());
    assert.equal(f.opened(), 1, "카드를 누르면 상세가 열린다");

    // Dragging is tracked without capture — even when the pointer moves and releases outside the card (a different element).
    await act(async () =>
      detail.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () => {
      document.body.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 10 }));
    });
    assert.equal(f.events[0]?.type, "start", "카드 밖에서 움직여도 끌기가 시작된다");
    await act(async () =>
      document.body.dispatchEvent(pointerEvent("pointerup", { clientX: 300, clientY: 10 })),
    );
    assert.equal(f.events.at(-1)?.type, "submit", "카드 밖에서 떼어도 놓기가 처리된다");
    assert.deepEqual(captured, [], "어느 순간에도 포인터를 캡처하지 않는다");
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("Hermes-owned running is never selected or submitted as a pointer drop target", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    const running = f.host.querySelector<HTMLElement>('[data-column="running"]')!;
    document.elementFromPoint = () => running;
    await act(async () => {
      handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
      handle.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 10 }));
      handle.dispatchEvent(pointerEvent("pointerup", { clientX: 20, clientY: 10 }));
    });
    assert.equal(running.hasAttribute("data-move-target"), false);
    assert.equal(
      f.events.some((event) => event.type === "submit"),
      false,
    );
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("pointer capture failure does not abort a valid touch-style move", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    handle.setPointerCapture = () => {
      throw new DOMException("No active pointer", "NotFoundError");
    };
    document.elementFromPoint = () => ready;
    await act(async () => {
      handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
      handle.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 10 }));
      handle.dispatchEvent(pointerEvent("pointerup", { clientX: 20, clientY: 10 }));
    });
    assert.equal(f.events.at(-1)?.type, "submit");
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2/R5: pointercancel cleans up without submitting", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 10 })),
    );
    await act(async () =>
      handle.dispatchEvent(pointerEvent("pointercancel", { clientX: 20, clientY: 10 })),
    );
    assert.equal(
      f.events.some((event) => event.type === "submit"),
      false,
    );
    assert.deepEqual(f.events.at(-1), {
      type: "cancel",
      taskId: "task-1",
      source: "todo",
      reason: "pointer-cancel",
    });
    assert.equal(ready.hasAttribute("data-move-target"), false);
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R3: focus restoration falls back to the source column when the card disappears", async () => {
  const column = document.createElement("section");
  column.tabIndex = -1;
  const handle = document.createElement("button");
  column.append(handle);
  document.body.append(column);
  try {
    restoreKanbanMoveFocus(handle, column);
    handle.remove();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    assert.equal(document.activeElement, column);
  } finally {
    column.remove();
  }
});

test("R2/R5: two boards isolate keyboard targets and target cleanup", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const firstRoot = createRef<HTMLDivElement>();
  const secondRoot = createRef<HTMLDivElement>();
  const events: KanbanMoveEvent[] = [];
  const renderBoard = (ref: typeof firstRoot, id: string, capture: boolean) => (
    <div ref={ref} data-board={id}>
      <KanbanColumn
        name="todo"
        tasks={[{ ...task, id: `${id}-task` }]}
        npcs={[]}
        now={0}
        selectedTaskId={null}
        onOpen={() => undefined}
        getMoveRoot={() => ref.current}
        onMoveInteraction={capture ? (event) => events.push(event) : undefined}
      />
      <KanbanColumn
        name="ready"
        tasks={[]}
        npcs={[]}
        now={0}
        selectedTaskId={null}
        onOpen={() => undefined}
        getMoveRoot={() => ref.current}
      />
    </div>
  );
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLocale="en">
          {renderBoard(firstRoot, "first", true)}
          {renderBoard(secondRoot, "second", false)}
        </I18nProvider>,
      ),
    );
    const handle = firstRoot.current!.querySelector<HTMLButtonElement>(
      '[data-card-move-handle="first-task"]',
    )!;
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    assert.equal(
      firstRoot.current!.querySelector<HTMLElement>('[data-column="ready"]')?.dataset.moveTarget,
      "true",
    );
    assert.equal(secondRoot.current!.querySelector('[data-move-target="true"]'), null);
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(firstRoot.current!.querySelector('[data-move-target="true"]'), null);
    assert.equal(events.at(-1)?.type, "cancel");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("R2: dragging the card body itself starts a move without touching the handle", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 13, clientY: 10 })),
    );
    assert.equal(f.events.length, 0, "small movement remains a tap");
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 10 })),
    );
    assert.equal(f.events[0]?.type, "start");
    assert.equal(ready.dataset.moveTarget, "true");
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerup", { clientX: 30, clientY: 10 })),
    );
    assert.equal(f.events.at(-1)?.type, "submit");
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2: the click that ends a card-body drag does not open details", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const body = f.host.querySelector<HTMLButtonElement>('[data-card-detail="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 10 })),
    );
    // The browser fires pointerup and its click within the same task — no timer runs in between.
    await act(async () => {
      card.dispatchEvent(pointerEvent("pointerup", { clientX: 30, clientY: 10 }));
      body.click();
    });
    assert.equal(f.opened(), 0, "a drag must not fall through to the detail click");
    // Only that one tap is swallowed — the next tap opens details.
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
    await act(async () => body.click());
    assert.equal(f.opened(), 1, "the next genuine tap opens details");
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2: a live move marks locked columns so they read as un-droppable", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const running = f.host.querySelector<HTMLElement>('[data-column="running"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    assert.equal(running.hasAttribute("data-move-locked"), false, "idle boards show no lock");
    document.elementFromPoint = () => ready;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 10 })),
    );
    assert.equal(running.dataset.moveLocked, "true", "running is Hermes-owned");
    assert.equal(ready.hasAttribute("data-move-locked"), false);
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerup", { clientX: 30, clientY: 10 })),
    );
    assert.equal(running.hasAttribute("data-move-locked"), false, "lock clears with the move");
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2: a pointer drag renders a preview that tracks the pointer and clears on drop", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    document.elementFromPoint = () => ready;
    assert.equal(document.querySelector("[data-kanban-drag-preview]"), null);
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 40 })),
    );
    const preview = document.querySelector<HTMLElement>("[data-kanban-drag-preview]");
    assert.ok(preview, "a live drag shows the card under the pointer");
    assert.match(preview.textContent ?? "", /Write release notes/);
    const first = preview.style.transform;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 90, clientY: 120 })),
    );
    assert.notEqual(
      document.querySelector<HTMLElement>("[data-kanban-drag-preview]")?.style.transform,
      first,
      "the preview follows the pointer",
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerup", { clientX: 90, clientY: 120 })),
    );
    assert.equal(document.querySelector("[data-kanban-drag-preview]"), null);
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R3: a keyboard move shows no pointer preview", async () => {
  const f = await mount();
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="task-1"]')!;
    handle.focus();
    await act(async () =>
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    assert.equal(f.events[0]?.type, "start");
    assert.equal(document.querySelector("[data-kanban-drag-preview]"), null);
  } finally {
    await f.cleanup();
  }
});

test("R2/R5: a parent re-render mid-drag keeps the target and lock marks alive", async () => {
  const f = await mount();
  const original = document.elementFromPoint;
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const ready = f.host.querySelector<HTMLElement>('[data-column="ready"]')!;
    const running = f.host.querySelector<HTMLElement>('[data-column="running"]')!;
    document.elementFromPoint = () => ready;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointermove", { clientX: 30, clientY: 10 })),
    );
    assert.equal(ready.dataset.moveTarget, "true");
    assert.equal(running.dataset.moveLocked, "true");

    await f.rerender();

    assert.equal(ready.dataset.moveTarget, "true", "the drop target survives a re-render");
    assert.equal(running.dataset.moveLocked, "true", "the lock survives a re-render");
    assert.equal(
      f.events.some((event) => event.type === "cancel"),
      false,
      "a re-render is not a cancellation",
    );
  } finally {
    document.elementFromPoint = original;
    await f.cleanup();
  }
});

test("R2: a tap on the card body still opens details", async () => {
  const f = await mount();
  try {
    const card = f.host.querySelector<HTMLElement>('[data-task-id="task-1"]')!;
    const body = f.host.querySelector<HTMLButtonElement>('[data-card-detail="task-1"]')!;
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 10 })),
    );
    await act(async () =>
      card.dispatchEvent(pointerEvent("pointerup", { clientX: 11, clientY: 10 })),
    );
    await act(async () => body.click());
    assert.equal(f.opened(), 1);
  } finally {
    await f.cleanup();
  }
});
