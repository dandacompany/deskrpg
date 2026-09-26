import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import { KANBAN_TASK_STATUSES } from "@/lib/hermes/deskrpg-plugin-types";

import ArtifactsModal from "../artifacts/ArtifactsModal";
import KanbanBoardModal from "./KanbanBoardModal";
import type { TaskDrawerArtifacts } from "./TaskDrawer";
import { PLUGIN_INSTALL_COMMAND } from "./kanban-view-model";

const CHANNEL = "ch-1";

const status = (overrides: Record<string, unknown> = {}) => ({
  pluginStatus: "ready",
  pluginVersion: "0.6.0",
  capabilities: ["kanban", "cron", "events", "kanban_review_policy_v1"],
  timezone: "Asia/Seoul",
  boardSlug: "deskrpg-ch-1",
  dispatcherPresent: true,
  attachments: true,
  lastPolledAt: null,
  lastError: null,
  minVersion: "0.6.0",
  working: [],
  ...overrides,
});

const npcs = [
  { npcId: "n1", npcName: "소피", profileName: "sophie", active: true },
  { npcId: "n2", npcName: "잠든 NPC", profileName: "sleepy", active: false },
];

const board = (overrides: Record<string, unknown> = {}) => ({
  columns: [
    { name: "done", tasks: [{ id: "t-done", title: "끝난 카드", status: "done" }] },
    {
      name: "todo",
      tasks: [{ id: "t-todo", title: "할 카드", status: "todo", assignee: "sophie" }],
    },
    { name: "archived", tasks: [{ id: "t-arch", title: "보관 카드", status: "archived" }] },
  ],
  tenants: [],
  assignees: ["sophie"],
  latest_event_id: null,
  now: "2026-09-14T00:00:00Z",
  npcs,
  ...overrides,
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

async function mount(
  handler: Handler,
  props: {
    channelId?: string;
    refreshTick?: number;
    debounceMs?: number;
    onConnectGateway?: () => void;
    initialTaskId?: string | null;
    initialCreateDraft?: { title: string; body: string; assigneeNpcId: string };
    focusRequest?: { taskId: string; seq: number } | null;
    covered?: boolean;
    artifacts?: TaskDrawerArtifacts | null;
    artifactsRefreshTick?: number;
    /** The project list the header picker reads. Answers with an empty list if not given. */
    projects?: unknown[];
    /** `canManage` on the project list — the owner's archive/reopen buttons. */
    canManageProjects?: boolean;
  } = {},
) {
  // View mode/filters persist per-channel in localStorage. Clear it on every mount so one test's
  // "show archive" doesn't change the next test's fetch URL.
  try {
    globalThis.localStorage?.clear();
  } catch {
    // Nothing to clear in an environment with no storage.
  }
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    // The project list is a side path used only by the header picker. Making each test's handler
    // deal with it too would silently throw off counts like "how many times was the board
    // fetched" — so it's answered here with an empty list. A test that needs multiple boards can
    // intercept this path directly in its own handler.
    if (/\/projects(\?|$)/.test(url))
      return json({ projects: props.projects ?? [], canManage: props.canManageProjects === true });
    return handler(url, init);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  let closed = false;
  const render = async (next: typeof props = props) =>
    act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <KanbanBoardModal channelId={CHANNEL} onClose={() => (closed = true)} {...next} />
        </I18nProvider>,
      ),
    );
  await render();
  // Flush microtasks so both the status and board fetches complete.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    host,
    calls,
    render,
    isClosed: () => closed,
    click: async (label: string) => {
      const button = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      );
      assert.ok(button, `button "${label}"`);
      await act(async () => button.click());
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = original;
    },
  };
}

const happy: Handler = (url) => {
  if (url.includes("/automation/status")) return json(status());
  if (url.includes("/kanban/board")) return json(board());
  return json({ code: "not_found", message: "no route" }, { status: 404 });
};

function key(el: Element, value: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

async function submitKeyboardMove(host: HTMLElement, taskId = "t-todo") {
  const handle = host.querySelector<HTMLButtonElement>(`[data-card-move-handle="${taskId}"]`);
  assert.ok(handle, `move handle for ${taskId}`);
  await act(async () => {
    handle.focus();
    key(handle, " ");
    key(handle, "ArrowRight");
    key(handle, "Enter");
  });
  return handle;
}

const detail = (task: Record<string, unknown>) => ({
  task,
  comments: [],
  events: [],
  attachments: [],
  links: { parents: [], children: [] },
  runs: [],
});

test("R4: move PATCHes status once, keeps counts unchanged while pending, then reloads server truth", async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  let patchResolve!: (response: Response) => void;
  const patch = new Promise<Response>((resolve) => (patchResolve = resolve));
  let boardReads = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const f = await mount((url, init) => {
    requests.push({ url, init });
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardReads += 1;
      return json(
        boardReads === 1
          ? board()
          : board({
              columns: [
                { name: "done", tasks: [] },
                { name: "todo", tasks: [] },
                {
                  name: "scheduled",
                  tasks: [{ id: "t-todo", title: "할 카드", status: "scheduled" }],
                },
              ],
            }),
      );
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") return patch;
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    assert.equal(requests.filter((request) => request.init?.method === "PATCH").length, 1);
    const write = requests.find((request) => request.init?.method === "PATCH");
    assert.equal(write?.url, "/api/channels/ch-1/kanban/tasks/t-todo");
    assert.deepEqual(JSON.parse(String(write?.init?.body)), { status: "scheduled" });
    assert.match(
      f.host.querySelector('[data-move-status="pending"]')?.textContent ?? "",
      /할 카드/,
    );
    assert.match(f.host.querySelector('[data-move-status="pending"]')?.textContent ?? "", /예약됨/);
    assert.ok(f.host.querySelector('[data-column="todo"]')?.textContent?.includes("할 카드"));
    assert.equal(
      f.host.querySelector('[data-column="scheduled"]')?.textContent?.includes("할 카드"),
      false,
    );

    // Pins down the order where the next paint callback runs before React renders the server response.
    globalThis.requestAnimationFrame = (callback) => {
      callback(performance.now());
      return 0;
    };
    await act(async () =>
      patchResolve(json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(boardReads, 2);
    assert.ok(f.host.querySelector('[data-column="scheduled"]')?.textContent?.includes("할 카드"));
    assert.equal(
      f.host.querySelector('[data-move-status="success"]')?.getAttribute("role"),
      "status",
    );
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(
      document.activeElement === f.host.querySelector('[data-card-move-handle="t-todo"]'),
      true,
      "focus follows the authoritative card into its new column",
    );
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    await f.cleanup();
  }
});

test("R3/R4: authoritative deletion restores focus to the board fallback", async () => {
  let reads = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      reads += 1;
      return json(reads === 1 ? board() : board({ columns: [{ name: "todo", tasks: [] }] }));
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      return json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(document.activeElement, f.host.querySelector("[data-kanban-board-root]"));
  } finally {
    await f.cleanup();
  }
});

test("R4/R5: channel change hides stale cards and cannot submit until the new board loads", async () => {
  let releaseStatus!: (response: Response) => void;
  const delayedStatus = new Promise<Response>((resolve) => (releaseStatus = resolve));
  let patches = 0;
  const f = await mount((url, init) => {
    if (url.includes("/channels/ch-2/automation/status")) return delayedStatus;
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(board());
    if (init?.method === "PATCH") patches += 1;
    return json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } });
  });
  try {
    const staleHandle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="t-todo"]');
    assert.ok(staleHandle);
    await f.render({ channelId: "ch-2" });
    await act(async () => {
      key(staleHandle, " ");
      key(staleHandle, "ArrowRight");
      key(staleHandle, "Enter");
    });
    assert.ok(!f.host.querySelector('[data-task-id="t-todo"]'));
    assert.equal(patches, 0);
    await act(async () => releaseStatus(json(status())));
  } finally {
    await f.cleanup();
  }
});

test("R4/R5: only one pre-submit card can be active", async () => {
  let patches = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board"))
      return json(
        board({
          columns: [
            {
              name: "todo",
              tasks: [
                { id: "t-todo", title: "첫 카드", status: "todo" },
                { id: "t-other", title: "둘째 카드", status: "todo" },
              ],
            },
          ],
        }),
      );
    if (init?.method === "PATCH") patches += 1;
    return json({ task: {} });
  });
  try {
    const first = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="t-todo"]')!;
    const second = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="t-other"]')!;
    await act(async () => key(first, " "));
    assert.equal(first.disabled, false, "active handle remains enabled");
    assert.equal(second.disabled, true, "other handles are disabled");
    await act(async () => {
      key(second, " ");
      key(second, "ArrowRight");
      key(second, "Enter");
    });
    assert.equal(patches, 0);
  } finally {
    await f.cleanup();
  }
});

test("R4/R5: duplicate submit is ignored and PATCH success plus GET failure retries only the read", async () => {
  let patchResolve!: (response: Response) => void;
  const patch = new Promise<Response>((resolve) => (patchResolve = resolve));
  let boardReads = 0;
  let patchCount = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardReads += 1;
      if (boardReads === 2)
        return json({ code: "upstream", message: "read failed" }, { status: 503 });
      return json(board());
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      patchCount += 1;
      return patch;
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await submitKeyboardMove(f.host);
    assert.equal(patchCount, 1);
    assert.equal(
      f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="t-todo"]')?.disabled,
      true,
    );
    await act(async () =>
      patchResolve(json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.match(
      f.host.querySelector('[data-move-status="unconfirmed"]')?.textContent ?? "",
      /저장.*최신 상태.*확인하지 못/,
    );
    await f.click("다시 확인");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(patchCount, 1, "read retry must not repeat PATCH");
    assert.equal(boardReads, 3);
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(document.activeElement, f.host.querySelector('[data-card-move-handle="t-todo"]'));
  } finally {
    await f.cleanup();
  }
});

test("R4: a superseded post-PATCH reload reconciles with the newer applied server truth", async () => {
  let releaseOldRead!: (response: Response) => void;
  const oldRead = new Promise<Response>((resolve) => (releaseOldRead = resolve));
  let oldReadStarted!: () => void;
  const started = new Promise<void>((resolve) => (oldReadStarted = resolve));
  let boardReads = 0;
  let patches = 0;
  const movedBoard = board({
    columns: [
      { name: "todo", tasks: [] },
      { name: "scheduled", tasks: [{ id: "t-todo", title: "할 카드", status: "scheduled" }] },
    ],
  });
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardReads += 1;
      if (boardReads === 2) {
        oldReadStarted();
        return oldRead;
      }
      return json(boardReads === 1 ? board() : movedBoard);
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      patches += 1;
      return json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await started;
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('button[aria-label="새로고침"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.ok(f.host.querySelector('[data-column="scheduled"]')?.textContent?.includes("할 카드"));
    await act(async () => releaseOldRead(json(board())));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(patches, 1);
    assert.ok(!f.host.querySelector('[data-move-status="unconfirmed"]'));
    assert.match(f.host.querySelector('[data-move-status="success"]')?.textContent ?? "", /예약됨/);
  } finally {
    await f.cleanup();
  }
});

test("R5: successful read retry focuses the board fallback when the moved card disappeared", async () => {
  let boardReads = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardReads += 1;
      if (boardReads === 2)
        return json({ code: "upstream", message: "read failed" }, { status: 503 });
      return json(boardReads === 1 ? board() : board({ columns: [{ name: "todo", tasks: [] }] }));
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      return json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.ok(f.host.querySelector('[data-move-status="unconfirmed"]'));
    await f.click("다시 확인");
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(document.activeElement, f.host.querySelector("[data-kanban-board-root]"));
  } finally {
    await f.cleanup();
  }
});

test("R1/R5: stale source and server failure cancel/fail without false success", async () => {
  let current = board();
  let patchCount = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(current);
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      patchCount += 1;
      return json({ code: "forbidden", message: "권한 없음" }, { status: 403 });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const handle = f.host.querySelector<HTMLButtonElement>('[data-card-move-handle="t-todo"]');
    assert.ok(handle);
    await act(async () => {
      key(handle, " ");
      key(handle, "ArrowRight");
    });
    current = board({
      columns: [
        { name: "done", tasks: [] },
        { name: "scheduled", tasks: [{ id: "t-todo", title: "할 카드", status: "scheduled" }] },
      ],
    });
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('button[aria-label="새로고침"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => key(handle, "Enter"));
    assert.equal(patchCount, 0, "changed source cancels before write");

    current = board();
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('button[aria-label="새로고침"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await submitKeyboardMove(f.host);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(patchCount, 1);
    assert.match(
      f.host.querySelector('[data-move-status="error"]')?.textContent ?? "",
      /권한 없음/,
    );
    assert.ok(!f.host.querySelector('[data-move-status="success"]'));
  } finally {
    await f.cleanup();
  }
});

test("a refused move names the target column instead of the raw invalid_transition code", async () => {
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(board());
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      return json(
        {
          code: "invalid_transition",
          message: "cannot move to 'scheduled' from the current status",
        },
        { status: 409 },
      );
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const text = f.host.querySelector('[data-move-status="error"]')?.textContent ?? "";
    assert.match(text, /예약됨/);
    assert.equal(text.includes("invalid_transition"), false);
    assert.equal(text.includes("cannot move"), false);
  } finally {
    await f.cleanup();
  }
});

test("a move failure notice clears once the board is read again afterwards", async () => {
  // Observed on staging: the card was later changed from its detail pane and the board refreshed
  // several times, yet the old "move failed" line stayed on top of the board.
  let boardReads = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardReads += 1;
      return json(board());
    }
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
      return json({ code: "forbidden", message: "권한 없음" }, { status: 403 });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(f.host.querySelector('[data-move-status="error"]') !== null, true);
    const readsAtFailure = boardReads;

    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('button[aria-label="새로고침"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    assert.equal(boardReads > readsAtFailure, true);
    assert.equal(f.host.querySelector('[data-move-status="error"]') !== null, false);
  } finally {
    await f.cleanup();
  }
});

test("R4: completion refreshes detail only when the moved card is currently selected", async () => {
  let patchResolve!: (response: Response) => void;
  const patch = new Promise<Response>((resolve) => (patchResolve = resolve));
  let boardReads = 0;
  const detailReads = new Map<string, number>();
  const f = await mount(
    (url, init) => {
      if (url.includes("/automation/status")) return json(status());
      if (url.includes("/kanban/board")) {
        boardReads += 1;
        return json(board());
      }
      if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") return patch;
      const taskId = url.match(/\/kanban\/tasks\/(t-[^/?]+)$/)?.[1];
      if (taskId) {
        detailReads.set(taskId, (detailReads.get(taskId) ?? 0) + 1);
        return json(
          detail({
            id: taskId,
            title: taskId === "t-todo" ? "할 카드" : "끝난 카드",
            status: taskId === "t-todo" ? "todo" : "done",
          }),
        );
      }
      return json({ code: "not_found", message: "no route" }, { status: 404 });
    },
    { initialTaskId: "t-todo" },
  );
  try {
    await submitKeyboardMove(f.host);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[data-card-detail="t-done"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(detailReads.get("t-done"), 1);

    await act(async () =>
      patchResolve(json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(boardReads, 2);
    assert.equal(detailReads.get("t-done"), 1, "unrelated current drawer is not refreshed");
  } finally {
    await f.cleanup();
  }
});

test("R4: a moved card selected while pending receives the completion detail refresh", async () => {
  let patchResolve!: (response: Response) => void;
  const patch = new Promise<Response>((resolve) => (patchResolve = resolve));
  let detailReads = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(board());
    if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") return patch;
    if (url.endsWith("/kanban/tasks/t-todo")) {
      detailReads += 1;
      return json(detail({ id: "t-todo", title: "할 카드", status: "todo" }));
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await submitKeyboardMove(f.host);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[data-card-detail="t-todo"]')?.click(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(detailReads, 1);
    await act(async () =>
      patchResolve(json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(detailReads, 2);
  } finally {
    await f.cleanup();
  }
});

test("R4: success reports authoritative status and does not claim target when the card disappeared", async () => {
  for (const authoritative of ["ready", "missing"] as const) {
    let boardReads = 0;
    const f = await mount((url, init) => {
      if (url.includes("/automation/status")) return json(status());
      if (url.includes("/kanban/board")) {
        boardReads += 1;
        if (boardReads === 1) return json(board());
        return json(
          board({
            columns:
              authoritative === "ready"
                ? [{ name: "ready", tasks: [{ id: "t-todo", title: "할 카드", status: "ready" }] }]
                : [{ name: "todo", tasks: [] }],
          }),
        );
      }
      if (url.endsWith("/kanban/tasks/t-todo") && init?.method === "PATCH") {
        return json({ task: { id: "t-todo", title: "할 카드", status: "scheduled" } });
      }
      return json({ code: "not_found", message: "no route" }, { status: 404 });
    });
    try {
      await submitKeyboardMove(f.host);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const message = f.host.querySelector('[data-move-status="success"]')?.textContent ?? "";
      if (authoritative === "ready") assert.match(message, /준비됨/);
      else {
        assert.match(message, /최신 보드/);
        assert.doesNotMatch(message, /예약됨/);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("R6: columns render in the fixed order and archived only after the toggle", async () => {
  const f = await mount(happy);
  try {
    const names = () =>
      Array.from(f.host.querySelectorAll<HTMLElement>("[data-column]")).map(
        (el) => el.dataset.column,
      );
    assert.deepEqual(
      names(),
      KANBAN_TASK_STATUSES.filter((n) => n !== "archived"),
    );
    assert.ok(
      f.calls.some((c) => c.endsWith("/kanban/board")),
      "board fetched without archive",
    );
    assert.equal(f.host.textContent?.includes("보관 카드"), false);

    // The toolbar has multiple checkboxes (attention-only, archive) — grabbing the first one would click the wrong one.
    const toggle = f.host.querySelector<HTMLInputElement>("input[data-kanban-archive-toggle]");
    assert.ok(toggle);
    await act(async () => {
      toggle.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.deepEqual(names(), [...KANBAN_TASK_STATUSES]);
    assert.ok(
      f.calls.some((c) => c.endsWith("/kanban/board?include_archived=true")),
      "archived toggle refetches with include_archived=true",
    );
    assert.ok(f.host.textContent?.includes("보관 카드"));
  } finally {
    await f.cleanup();
  }
});

test("R31: 428 renders the upgrade notice with the install command and minVersion", async () => {
  const f = await mount((url) => {
    if (url.includes("/automation/status")) return json(status({ minVersion: "0.6.0" }));
    return json(
      { code: "plugin_upgrade_required", message: "too old", minVersion: "0.6.0" },
      { status: 428 },
    );
  });
  try {
    const blocker = f.host.querySelector<HTMLElement>("[data-blocker]");
    assert.equal(blocker?.dataset.blocker, "upgrade_required");
    assert.match(blocker?.textContent ?? "", /플러그인 업데이트 필요/);
    assert.match(blocker?.textContent ?? "", /0\.6\.0/);
    assert.ok(blocker?.textContent?.includes(PLUGIN_INSTALL_COMMAND));
    assert.ok(!f.host.querySelector("[data-column]"), "no columns behind a blocker");
  } finally {
    await f.cleanup();
  }
});

test("R31: 409 gateway_not_bound from status renders the gateway notice", async () => {
  const f = await mount(() =>
    json({ code: "gateway_not_bound", message: "Channel has no gateway bound" }, { status: 409 }),
  );
  try {
    assert.equal(
      f.host.querySelector<HTMLElement>("[data-blocker]")?.dataset.blocker,
      "gateway_not_bound",
    );
    assert.match(f.host.textContent ?? "", /게이트웨이 연결 필요/);
  } finally {
    await f.cleanup();
  }
});

test("E6: 503 renders the reason and a retry button that refetches", async () => {
  let boardCalls = 0;
  const f = await mount((url) => {
    if (url.includes("/automation/status")) return json(status());
    boardCalls += 1;
    return json({ code: "board_create_failed", message: "disk full" }, { status: 503 });
  });
  try {
    const blocker = f.host.querySelector<HTMLElement>("[data-blocker]");
    assert.equal(blocker?.dataset.blocker, "board_unavailable");
    assert.match(blocker?.textContent ?? "", /disk full/);
    await f.click("재시도");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.equal(boardCalls, 2);
  } finally {
    await f.cleanup();
  }
});

test("R9/E6: dispatcherPresent=false and lastError show as banners above the board", async () => {
  const f = await mount((url) => {
    if (url.includes("/automation/status")) {
      return json(status({ dispatcherPresent: false, lastError: "poll timeout" }));
    }
    return json(board());
  });
  try {
    const banners = Array.from(f.host.querySelectorAll<HTMLElement>("[data-banner]")).map(
      (el) => el.dataset.banner,
    );
    assert.deepEqual(banners, ["dispatcher", "lastError"]);
    assert.match(f.host.textContent ?? "", /디스패처가 없어/);
    assert.match(f.host.textContent ?? "", /poll timeout/);
    // Columns still render as usual — the banner doesn't block them.
    assert.ok(f.host.querySelector("[data-column]"));
  } finally {
    await f.cleanup();
  }
});

test("cards under a status the board does not know stay out of the columns and are counted in a banner", async () => {
  const f = await mount(() =>
    json(
      board({
        columns: [
          ...board().columns,
          {
            name: "made_up",
            tasks: [
              { id: "t-x1", title: "모르는 상태 카드1", status: "made_up" },
              { id: "t-x2", title: "모르는 상태 카드2", status: "made_up" },
            ],
          },
        ],
      }),
    ),
  );
  try {
    const banner = f.host.querySelector<HTMLElement>('[data-banner="hiddenCards"]');
    assert.ok(banner);
    assert.match(banner.textContent ?? "", /2/);
    assert.match(banner.textContent ?? "", /made_up/);
    assert.doesNotMatch(f.host.textContent ?? "", /모르는 상태 카드/);
    assert.ok(f.host.querySelector("[data-column]"));
  } finally {
    await f.cleanup();
  }
});

test("R7: the create form lists only active NPCs as assignee options", async () => {
  const f = await mount(happy);
  try {
    await f.click("새 카드");
    const select = f.host.querySelector<HTMLSelectElement>("#kanban-assignee");
    assert.ok(select);
    const options = Array.from(select.options).map((o) => [o.value, o.textContent]);
    assert.deepEqual(options, [
      ["", "(미배정)"],
      ["n1", "소피"],
    ]);
    // Prerequisite-card candidates are all cards on the same board.
    const parents = Array.from(
      f.host.querySelectorAll<HTMLInputElement>('form input[type="checkbox"]'),
    );
    assert.ok(parents.length >= 2);
  } finally {
    await f.cleanup();
  }
});

test("R8/R9: create posts to the server, shows the 400 message verbatim, and surfaces warning", async () => {
  let attempt = 0;
  const f = await mount((url, init) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.endsWith("/kanban/board")) return json(board());
    if (url.endsWith("/kanban/tasks") && init?.method === "POST") {
      attempt += 1;
      if (attempt === 1) {
        return json(
          { code: "assignee_not_in_channel", message: "Assignee must be an NPC" },
          { status: 400 },
        );
      }
      return json(
        {
          task: { id: "t-new", title: "새 카드", status: "todo" },
          warning: "dispatcher missing",
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/kanban/tasks/t-new")) {
      return json({
        task: { id: "t-new", title: "새 카드", status: "todo" },
        comments: [],
        events: [],
        attachments: [],
        links: { parents: [], children: [] },
        runs: [],
      });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    await f.click("새 카드");
    const title = f.host.querySelector<HTMLInputElement>("#kanban-title");
    assert.ok(title);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title, "새 카드");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const assignee = f.host.querySelector<HTMLSelectElement>("#kanban-assignee")!;
      assignee.value = "n1";
      assignee.dispatchEvent(new Event("change", { bubbles: true }));
      const criteria = f.host.querySelector<HTMLTextAreaElement>("#kanban-completion-criteria")!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        criteria,
        "검증한 결과",
      );
      criteria.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await f.click("만들기");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const alert = f.host.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? "", /assignee_not_in_channel: Assignee must be an NPC/);

    await f.click("만들기");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // On success the form closes and the warning shows at the top of the board and in the drawer.
    assert.ok(!f.host.querySelector("#kanban-title"));
    assert.equal(
      f.host
        .querySelector<HTMLElement>('[data-banner="board"]')
        ?.textContent?.includes("dispatcher missing"),
      true,
    );
    assert.ok(
      f.calls.some((c) => c === "GET /api/channels/ch-1/kanban/tasks/t-new"),
      "drawer opened",
    );
    assert.ok(
      f.calls.filter((c) => c.endsWith("/kanban/board")).length >= 2,
      "board refetched after create (R26)",
    );
  } finally {
    await f.cleanup();
  }
});

test("R26: a kanban:event tick refetches the board after the debounce", async () => {
  // Use a generous debounce window — with 1ms, under full suite load the timer actually fired
  // before the two renders, causing a double fetch (flaky). 50ms so both ticks reliably land within the window.
  const f = await mount(happy, { refreshTick: 0, debounceMs: 50 });
  try {
    const before = f.calls.filter((c) => c.endsWith("/kanban/board")).length;
    await f.render({ refreshTick: 1, debounceMs: 50 });
    await f.render({ refreshTick: 2, debounceMs: 50 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    const after = f.calls.filter((c) => c.endsWith("/kanban/board")).length;
    assert.equal(after, before + 1, "two ticks inside the debounce window collapse into one fetch");
  } finally {
    await f.cleanup();
  }
});

test("R26: two open clients independently refetch after the same kanban:event tick", async () => {
  const original = globalThis.fetch;
  let boardFetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) {
      boardFetches++;
      return json(board());
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (refreshTick: number) =>
    act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <KanbanBoardModal
            channelId={CHANNEL}
            onClose={() => undefined}
            refreshTick={refreshTick}
            debounceMs={50}
          />
          <KanbanBoardModal
            channelId={CHANNEL}
            onClose={() => undefined}
            refreshTick={refreshTick}
            debounceMs={50}
          />
        </I18nProvider>,
      ),
    );
  try {
    await render(0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const before = boardFetches;
    await render(1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    assert.equal(boardFetches, before + 2, "each client performs its own authoritative refetch");
    assert.equal(host.querySelectorAll('[data-task-id="t-todo"]').length, 2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});

test("unbound gateway offers connection to owners and guidance to members", async () => {
  let connects = 0;
  const f = await mount(() => json({ code: "gateway_not_bound" }, { status: 409 }), {
    onConnectGateway: () => {
      connects++;
    },
  });
  try {
    await f.click("게이트웨이 연결하기");
    assert.equal(connects, 1);
    assert.ok(!f.host.querySelector("[data-blocker]")?.textContent?.includes("재시도"));
    await f.render({});
    assert.match(f.host.textContent ?? "", /오피스 소유자에게/);
    assert.ok(!f.host.querySelector("[data-blocker] button"));
  } finally {
    await f.cleanup();
  }
});

const findButton = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);

test("swarm: the button doesn't render when swarm is absent from capabilities", async () => {
  const f = await mount((url) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(board());
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    assert.equal(findButton(f.host, "스웜"), undefined, "swarm capability 없이는 버튼 없음");
  } finally {
    await f.cleanup();
  }
});

test("blackboard JSON does not show up as a comment on the swarm root card", async () => {
  const f = await mount(
    (url) => {
      if (url.includes("/automation/status")) return json(status());
      if (url.endsWith("/kanban/board")) return json(board());
      if (url.endsWith("/kanban/tasks/t-root")) {
        return json({
          task: { id: "t-root", title: "스웜 루트", status: "done" },
          comments: [
            {
              id: "bb",
              author: "swarm-orchestrator",
              body: '[swarm:blackboard] {"key":"topology","value":{"goal":"목표"}}',
              created_at: "2026-09-16T00:00:00Z",
            },
            { id: "c1", author: "nova", body: "시작합니다", created_at: "2026-09-16T00:01:00Z" },
          ],
          events: [],
          attachments: [],
          links: { parents: [], children: [] },
          runs: [],
        });
      }
      return json({ code: "not_found", message: "no route" }, { status: 404 });
    },
    { initialTaskId: "t-root" },
  );
  try {
    assert.equal(f.host.textContent?.includes("[swarm:blackboard]"), false);
    assert.equal(f.host.textContent?.includes("시작합니다"), true);
    assert.equal(f.host.textContent?.includes("topology"), true); // it's in the table
  } finally {
    await f.cleanup();
  }
});

test("a swarm root card reads as a work split, not as an approval-free done card", async () => {
  const f = await mount((url) =>
    url.includes("/automation/status")
      ? json(status())
      : json(
          board({
            columns: [
              {
                name: "done",
                tasks: [
                  {
                    id: "t-root",
                    title: "Swarm: 뉴스레터",
                    status: "done",
                    body: "Kanban Swarm v1 planning/root card. This card is completed immediately…",
                  },
                  { id: "t-done", title: "끝난 카드", status: "done" },
                ],
              },
            ],
          }),
        ),
  );
  try {
    const labels = [...f.host.querySelectorAll("[data-card-structure]")];
    assert.equal(labels.length, 1);
    assert.equal(labels[0].textContent, "분업 묶음 — 팀 업무 시작 표시(결과 아님)");
  } finally {
    await f.cleanup();
  }
});

const detailHandler =
  (detailReads: Map<string, number>): Handler =>
  (url) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(board());
    const taskId = url.match(/\/kanban\/tasks\/(t-[^/?]+)$/)?.[1];
    if (taskId) {
      detailReads.set(taskId, (detailReads.get(taskId) ?? 0) + 1);
      return json(detail({ id: taskId, title: `카드 ${taskId}`, status: "todo" }));
    }
    if (url.includes("/artifacts")) return json({ artifacts: [], cursor: null, has_more: false });
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  };

test("go to source: an incoming focusRequest switches to that card's detail even on an already-open board", async () => {
  const detailReads = new Map<string, number>();
  const first = { taskId: "t-todo", seq: 1 };
  const f = await mount(detailHandler(detailReads), {
    initialTaskId: "t-todo",
    focusRequest: first,
  });
  try {
    assert.equal(detailReads.get("t-todo"), 1);
    await f.render({ initialTaskId: "t-done", focusRequest: { taskId: "t-done", seq: 2 } });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(detailReads.get("t-done"), 1, "새 카드의 상세를 연다");

    // Even after opening a different card directly, re-requesting the same card (with a bumped seq) returns to it.
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('[data-card-detail="t-todo"]')?.click(),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(detailReads.get("t-todo"), 2);
    await f.render({ initialTaskId: "t-done", focusRequest: { taskId: "t-done", seq: 3 } });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(detailReads.get("t-done"), 2);
  } finally {
    await f.cleanup();
  }
});

test("artifacts: the board passes artifacts through to the card drawer as-is", async () => {
  const listed: string[] = [];
  const artifacts: TaskDrawerArtifacts = {
    list: async (taskId) => {
      listed.push(taskId);
      return [];
    },
    open: () => {},
  };
  const f = await mount(detailHandler(new Map()), { initialTaskId: "t-todo", artifacts });
  try {
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.deepEqual(listed, ["t-todo"]);
    assert.ok(f.host.textContent?.includes("이 카드에서 만든 결과물이 없습니다"));
  } finally {
    await f.cleanup();
  }
});

test("artifacts: even with a burst of artifact event signals, the drawer refetches only once after debouncing", async () => {
  let listCalls = 0;
  const artifacts: TaskDrawerArtifacts = {
    list: async () => {
      listCalls += 1;
      return [];
    },
    open: () => {},
  };
  const f = await mount(detailHandler(new Map()), {
    initialTaskId: "t-todo",
    artifacts,
    artifactsRefreshTick: 0,
  });
  try {
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(listCalls, 1);
    await f.render({ initialTaskId: "t-todo", artifacts, artifactsRefreshTick: 1 });
    await f.render({ initialTaskId: "t-todo", artifacts, artifactsRefreshTick: 2 });
    await f.render({ initialTaskId: "t-todo", artifacts, artifactsRefreshTick: 3 });
    assert.equal(listCalls, 1, "디바운스 전에는 다시 읽지 않는다");
    await act(async () => new Promise((r) => setTimeout(r, 350)));
    assert.equal(listCalls, 2, "연달은 사건은 한 번으로 접힌다");
  } finally {
    await f.cleanup();
  }
});

test("when an artifacts modal is covering the board (covered), Escape does not close the board", async () => {
  const f = await mount(happy, { covered: true });
  try {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(f.isClosed(), false);
    await f.render({ covered: false });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(f.isClosed(), true);
  } finally {
    await f.cleanup();
  }
});

test("an artifacts modal over the board: one Escape closes only the artifacts modal, and the next Escape closes the board", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return detailHandler(new Map())(url, init);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [kanban, setKanban] = useState(true);
    const [artifactsOpen, setArtifactsOpen] = useState(true);
    return (
      <I18nProvider initialLocale="ko">
        {kanban && (
          <KanbanBoardModal
            channelId={CHANNEL}
            covered={artifactsOpen}
            onClose={() => setKanban(false)}
          />
        )}
        {artifactsOpen && (
          <ArtifactsModal
            channelId={CHANNEL}
            npcs={[]}
            refreshTick={0}
            lastEvent={null}
            onOpenSource={() => {}}
            onClose={() => setArtifactsOpen(false)}
          />
        )}
      </I18nProvider>
    );
  }
  const shown = (id: string) => host.querySelector(`[aria-labelledby="${id}"]`) !== null;
  try {
    await act(async () => root.render(<Harness />));
    assert.ok(shown("kanban-modal-title") && shown("artifacts-modal-title"));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(shown("artifacts-modal-title"), false, "결과물 모달이 닫힌다");
    assert.equal(shown("kanban-modal-title"), true, "보드는 남는다");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(shown("kanban-modal-title"), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});

test("the subproject filter applies the same way to both the board and the list", async () => {
  const tenantBoard = board({
    columns: [
      {
        name: "todo",
        tasks: [
          { id: "t-web", title: "웹 카드", status: "todo", tenant: "web" },
          { id: "t-api", title: "API 카드", status: "todo", tenant: "api" },
        ],
      },
    ],
    tenants: ["web", "api"],
  });
  const f = await mount((url) => {
    if (url.includes("/automation/status")) return json(status());
    if (url.includes("/kanban/board")) return json(tenantBoard);
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    assert.ok(f.host.textContent?.includes("웹 카드"));
    assert.ok(f.host.textContent?.includes("API 카드"));

    // Keep only web selected in the toolbar's subproject filter.
    const tenantSelect = Array.from(f.host.querySelectorAll<HTMLSelectElement>("select")).find(
      (el) => el.getAttribute("aria-label") === "서브프로젝트",
    );
    assert.ok(tenantSelect, "서브프로젝트 필터가 없다");
    await act(async () => {
      tenantSelect.value = "web";
      tenantSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    assert.ok(f.host.textContent?.includes("웹 카드"), "고른 서브프로젝트 카드가 사라졌다");
    assert.equal(
      f.host.textContent?.includes("API 카드"),
      false,
      "보드 뷰에서 필터가 아무 일도 하지 않는다 — 화면은 필터가 걸렸다고 말한다",
    );
    const todoColumn = f.host.querySelector<HTMLElement>('[data-column="todo"]');
    assert.ok(todoColumn);
    assert.ok(
      /(^|\D)1(\D|$)/.test(todoColumn.textContent ?? ""),
      `열 머리 개수가 거른 뒤 수가 아니다: ${todoColumn.textContent?.slice(0, 40)}`,
    );

    // Switching to list view with the same filter must show the same set of cards.
    const listButton = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("aria-label") === "목록",
    );
    assert.ok(listButton);
    await act(async () => {
      listButton.click();
    });
    assert.ok(f.host.textContent?.includes("웹 카드"));
    assert.equal(
      f.host.textContent?.includes("API 카드"),
      false,
      "두 표현이 다른 카드를 보이면 같은 데이터라고 할 수 없다",
    );
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Project (= board) picker — design 2026-09-21 project-registry
// ---------------------------------------------------------------------------

const MAIN_PROJECT = {
  id: "p1",
  boardSlug: "deskrpg-main",
  name: "기본 프로젝트",
  status: "planned",
  isEventCarrier: true,
};
const SIDE_PROJECT = {
  id: "p2",
  boardSlug: "deskrpg-side",
  name: "둘째 프로젝트",
  status: "in_progress",
  isEventCarrier: false,
};

function plain(url: string) {
  return url.includes("/automation/status") ? json(status()) : json(board());
}

test("does not render the picker when there is only one board", async () => {
  const f = await mount(plain, { projects: [MAIN_PROJECT] });
  try {
    // Never assert the node directly — the failure message would serialize the DOM tree and crash the process.
    assert.equal(
      f.host.querySelector("[data-project-picker]") === null,
      true,
      "고를 것이 없는데 선택기가 떴습니다",
    );
  } finally {
    await f.cleanup();
  }
});

test("with two boards, the picker shows up and the chosen board goes out as ?board=", async () => {
  const f = await mount(plain, { projects: [MAIN_PROJECT, SIDE_PROJECT] });
  try {
    const select = f.host.querySelector<HTMLSelectElement>("[data-project-picker]");
    assert.ok(select, "선택기가 없습니다");
    assert.deepEqual(
      [...select.options].map((o) => o.value),
      ["deskrpg-main", "deskrpg-side"],
    );
    assert.equal(select.value, "deskrpg-main", "기본은 사건 수신 보드입니다");

    await act(async () => {
      select.value = "deskrpg-side";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const boardCalls = f.calls.filter((c) => c.includes("/kanban/board"));
    assert.ok(
      boardCalls.some((c) => c.includes("board=deskrpg-side")),
      `고른 보드가 요청에 실리지 않았습니다: ${boardCalls.join(" | ")}`,
    );
  } finally {
    await f.cleanup();
  }
});

test("the owner archives the chosen project, then the list reloads and the default board opens", async () => {
  const f = await mount(
    (url, init) => {
      if (url.endsWith("/projects/p2/archive") && init?.method === "POST")
        return json({ project: { id: "p2", status: "completed" } });
      return plain(url);
    },
    { projects: [MAIN_PROJECT, SIDE_PROJECT], canManageProjects: true },
  );
  try {
    const select = f.host.querySelector<HTMLSelectElement>("[data-project-picker]");
    assert.ok(select);
    await act(async () => {
      select.value = "deskrpg-side";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const listsBefore = f.calls.filter((c) => /GET \S*\/projects$/.test(c)).length;
    await f.click("보관");
    await act(async () => {
      f.host.querySelector<HTMLButtonElement>("[data-project-archive-confirm]")?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(
      f.calls.some((c) => c === "POST /api/channels/ch-1/projects/p2/archive"),
      f.calls.join(" | "),
    );
    assert.equal(f.calls.filter((c) => /GET \S*\/projects$/.test(c)).length, listsBefore + 1);
    assert.equal(
      f.host.querySelector<HTMLSelectElement>("[data-project-picker]")?.value,
      "deskrpg-main",
    );
  } finally {
    await f.cleanup();
  }
});

test("the owner sets the open project's target date and the project list reloads", async () => {
  const bodies: unknown[] = [];
  const f = await mount(
    (url, init) => {
      if (url.endsWith("/projects/p1") && init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        return json({ project: { ...MAIN_PROJECT, targetDate: "2026-11-15" } });
      }
      if (url.includes("/automation/status")) return json(status({ boardSlug: "deskrpg-main" }));
      return json(board());
    },
    { projects: [{ ...MAIN_PROJECT, targetDate: null }], canManageProjects: true },
  );
  try {
    const input = f.host.querySelector<HTMLInputElement>("[data-project-target-date]");
    assert.ok(input, "owner sees the target date input");
    const listsBefore = f.calls.filter((c) => /GET \S*\/projects$/.test(c)).length;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "2026-11-15",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.deepEqual(bodies, [{ targetDate: "2026-11-15" }]);
    assert.equal(f.calls.filter((c) => /GET \S*\/projects$/.test(c)).length, listsBefore + 1);
  } finally {
    await f.cleanup();
  }
});

test("the target date follows the project chosen in the picker, not the channel's default board", async () => {
  const patched: string[] = [];
  const f = await mount(
    (url, init) => {
      if (init?.method === "PATCH" && /\/projects\/p\d$/.test(url)) {
        patched.push(url.slice(url.lastIndexOf("/") + 1));
        return json({ project: SIDE_PROJECT });
      }
      // The status route is channel-wide: it always names the default board.
      if (url.includes("/automation/status")) return json(status({ boardSlug: "deskrpg-main" }));
      return json(board());
    },
    {
      projects: [
        { ...MAIN_PROJECT, targetDate: null },
        { ...SIDE_PROJECT, targetDate: "2026-12-01" },
      ],
      canManageProjects: true,
    },
  );
  try {
    const select = f.host.querySelector<HTMLSelectElement>("[data-project-picker]");
    assert.ok(select);
    await act(async () => {
      select.value = "deskrpg-side";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const input = f.host.querySelector<HTMLInputElement>("[data-project-target-date]");
    assert.ok(input);
    assert.equal(input.value, "2026-12-01", "shows the chosen project's date");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "2026-12-24",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.deepEqual(patched, ["p2"], "saves onto the chosen project");
  } finally {
    await f.cleanup();
  }
});

test("a member sees no target date input", async () => {
  const f = await mount(
    (url) =>
      url.includes("/automation/status")
        ? json(status({ boardSlug: "deskrpg-main" }))
        : json(board()),
    { projects: [MAIN_PROJECT], canManageProjects: false },
  );
  try {
    assert.ok(!f.host.querySelector("[data-project-target-date]"));
  } finally {
    await f.cleanup();
  }
});

test("does not append ?board= when viewing the default board — matches the shape of the old requests", async () => {
  const f = await mount(plain, { projects: [MAIN_PROJECT, SIDE_PROJECT] });
  try {
    const boardCalls = f.calls.filter((c) => c.includes("/kanban/board"));
    assert.ok(boardCalls.length > 0);
    assert.ok(
      boardCalls.every((c) => !c.includes("board=")),
      `기본 보드인데 board= 가 붙었습니다: ${boardCalls.join(" | ")}`,
    );
  } finally {
    await f.cleanup();
  }
});

test("the timeline is enabled only with the capability, and fetches run history when opened", async () => {
  const f = await mount((url) => {
    if (url.includes("/automation/status"))
      return json(status({ capabilities: ["kanban", "cron", "events", "kanban_views"] }));
    if (url.includes("/kanban/runs"))
      return json({
        runs: [],
        board: "deskrpg-ch-1",
        window: { from: 0, to: 1 },
        truncated: false,
      });
    if (url.includes("/kanban/board")) return json(board());
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const button = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("aria-label") === "타임라인",
    );
    assert.ok(button, "capability 가 있는데 타임라인 버튼이 없다");
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(
      f.calls.some((c) => c.includes("/kanban/runs")),
      "타임라인을 열었는데 실행 기록을 조회하지 않았다",
    );
  } finally {
    await f.cleanup();
  }
});

async function openTimelineWith(capabilities: string[]) {
  const nowSec = Math.floor(Date.now() / 1000);
  const f = await mount((url) => {
    if (url.includes("/automation/status")) return json(status({ capabilities }));
    if (url.includes("/kanban/runs"))
      return json({
        runs: [],
        board: "deskrpg-ch-1",
        window: { from: 0, to: 1 },
        truncated: false,
      });
    if (url.includes("/kanban/events"))
      return json({
        events: [
          {
            id: 1,
            task_id: "t1",
            board: "deskrpg-ch-1",
            from: "running",
            to: "review",
            created_at: nowSec,
          },
          {
            id: 2,
            task_id: "t1",
            board: "deskrpg-ch-1",
            from: "review",
            to: "todo",
            created_at: nowSec,
          },
        ],
        board: "deskrpg-ch-1",
        kind: "status",
        window: { from: 0, to: nowSec },
        truncated: false,
      });
    if (url.includes("/kanban/board")) return json(board());
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  const button = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
    (el) => el.getAttribute("aria-label") === "타임라인",
  );
  assert.ok(button, "no timeline button");
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return f;
}

test("with kanban_task_events the metrics show how many results were sent back from review", async () => {
  const f = await openTimelineWith([
    "kanban",
    "cron",
    "events",
    "kanban_views",
    "kanban_task_events",
  ]);
  try {
    assert.equal(
      f.calls.some((c) => c.includes("/kanban/events")),
      true,
    );
    const cell = f.host.querySelector('[data-metric="rework"]');
    assert.equal(cell !== null, true);
    assert.equal(cell?.textContent?.startsWith("재작업1"), true);
  } finally {
    await f.cleanup();
  }
});

test("without kanban_task_events the rework metric is hidden and never asked for", async () => {
  const f = await openTimelineWith(["kanban", "cron", "events", "kanban_views"]);
  try {
    assert.equal(
      f.calls.some((c) => c.includes("/kanban/events")),
      false,
    );
    assert.equal(f.host.querySelector('[data-metric="rework"]') !== null, false);
  } finally {
    await f.cleanup();
  }
});

test("does not show the timeline button when the capability is absent", async () => {
  // A button that does nothing when pressed reads as broken. Kanban itself must keep working.
  const f = await mount(happy);
  try {
    const button = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("aria-label") === "타임라인",
    );
    assert.equal(button, undefined);
    assert.equal(
      f.calls.some((c) => c.includes("/kanban/runs")),
      false,
    );
    // The board still renders fine.
    assert.ok(f.host.querySelector('[data-column="todo"]'));
  } finally {
    await f.cleanup();
  }
});

test("the timeline actually draws the target date and dependency arrows — values must flow through the modal", async (t) => {
  // Pins down a bug where each piece was green individually, but the wiring between them was
  // broken so neither the target date nor the arrow showed on screen.
  // Asserts on **values**, not nodes — not whether a line exists, but whether that line is on that date.
  // The timeline draws a "today" window — hardcoding a date would fail the instant that day passes (observed 2026-09-22).
  // The clock is pinned too: the test and the modal each read "today", and across midnight they disagreed.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 22, 12, 0, 0).getTime() });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = today.getTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  const targetDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const runStart = Math.floor((dayStart + 3600_000) / 1000);
  const timelineBoard = board({
    columns: [
      {
        name: "running",
        tasks: [
          { id: "parent", title: "부모", status: "done" },
          { id: "child", title: "자식", status: "running" },
        ],
      },
    ],
  });
  const f = await mount(
    (url) => {
      if (url.includes("/automation/status"))
        return json(
          status({
            capabilities: ["kanban", "cron", "events", "kanban_views"],
            boardSlug: "deskrpg-main",
          }),
        );
      if (url.includes("/kanban/runs"))
        return json({
          runs: [
            {
              id: "r1",
              status: "done",
              task_id: "parent",
              board: "deskrpg-main",
              profile: "sophie",
              task_title: "부모",
              started_at: runStart,
              ended_at: runStart + 600,
              outcome: "completed",
            },
            {
              id: "r2",
              status: "done",
              task_id: "child",
              board: "deskrpg-main",
              profile: "oliver",
              task_title: "자식",
              started_at: runStart + 1200,
              ended_at: runStart + 1800,
              outcome: "completed",
            },
          ],
          board: "deskrpg-main",
          window: { from: 0, to: 9_999_999_999 },
          truncated: false,
        });
      if (url.includes("/kanban/links"))
        return json({
          links: [{ parent_id: "parent", child_id: "child" }],
          board: "deskrpg-main",
        });
      if (url.includes("/kanban/board")) return json(timelineBoard);
      return json({ code: "not_found", message: "no route" }, { status: 404 });
    },
    {
      projects: [{ ...MAIN_PROJECT, boardSlug: "deskrpg-main", targetDate }],
    },
  );
  try {
    const timelineButton = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("aria-label") === "타임라인",
    );
    assert.ok(timelineButton, "타임라인 버튼이 없다");
    await act(async () => {
      timelineButton.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const target = f.host.querySelector("[data-timeline-target]");
    assert.ok(target, "모달이 목표일을 계산했는데 화면에 세로선이 없다");
    assert.ok(
      (target.getAttribute("data-timeline-target") ?? "").startsWith(targetDate),
      `목표일 선이 다른 날짜다: ${target.getAttribute("data-timeline-target")}`,
    );

    const edge = f.host.querySelector("[data-timeline-edge]");
    assert.ok(edge, "링크를 받아왔는데 화살표가 없다");
    assert.equal(edge.getAttribute("data-timeline-edge"), "parent->child");
  } finally {
    await f.cleanup();
  }
});

test("the subproject filter also applies to the timeline", async (t) => {
  // A filter that only applies to the board/list is a silent failure — this exact bug happened once in the board view.
  // The clock is pinned to local noon: the "today" window starts at local midnight, so a run
  // "ten minutes ago" fell on yesterday between 00:00 and 00:10 and the test failed every night.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 22, 12, 0, 0).getTime() });
  const runStart = Math.floor(Date.now() / 1000) - 600;
  const f = await mount((url) => {
    if (url.includes("/automation/status"))
      return json(status({ capabilities: ["kanban", "cron", "events", "kanban_views"] }));
    if (url.includes("/kanban/runs"))
      return json({
        runs: [
          {
            id: "r-web",
            status: "done",
            task_id: "t-web",
            board: "deskrpg-ch-1",
            profile: "sophie",
            task_title: "웹 카드",
            started_at: runStart,
            ended_at: runStart + 60,
            outcome: "completed",
          },
          {
            id: "r-api",
            status: "done",
            task_id: "t-api",
            board: "deskrpg-ch-1",
            profile: "oliver",
            task_title: "API 카드",
            started_at: runStart,
            ended_at: runStart + 60,
            outcome: "completed",
          },
        ],
        board: "deskrpg-ch-1",
        window: { from: 0, to: 9_999_999_999 },
        truncated: false,
      });
    if (url.includes("/kanban/links")) return json({ links: [], board: "deskrpg-ch-1" });
    if (url.includes("/kanban/board"))
      return json(
        board({
          columns: [
            {
              name: "done",
              tasks: [
                { id: "t-web", title: "웹 카드", status: "done", tenant: "web" },
                { id: "t-api", title: "API 카드", status: "done", tenant: "api" },
              ],
            },
          ],
          tenants: ["web", "api"],
        }),
      );
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const timelineButton = Array.from(f.host.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.getAttribute("aria-label") === "타임라인",
    );
    assert.ok(timelineButton);
    await act(async () => {
      timelineButton.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.ok(f.host.textContent?.includes("sophie"), "타임라인에 막대가 없다");
    assert.ok(f.host.textContent?.includes("oliver"));

    const tenantSelect = Array.from(f.host.querySelectorAll<HTMLSelectElement>("select")).find(
      (el) => el.getAttribute("aria-label") === "서브프로젝트",
    );
    assert.ok(tenantSelect, "타임라인 뷰에 서브프로젝트 필터가 보이는데 잡히지 않는다");
    await act(async () => {
      tenantSelect.value = "web";
      tenantSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    assert.ok(f.host.textContent?.includes("sophie"), "고른 서브프로젝트의 작업자가 사라졌다");
    assert.equal(
      f.host.textContent?.includes("oliver"),
      false,
      "타임라인에서 필터가 아무 일도 하지 않는다 — 화면은 필터가 걸렸다고 말한다",
    );
  } finally {
    await f.cleanup();
  }
});

test("a conversation draft only opens the confirmation form, and canceling never registers the card", async () => {
  const f = await mount((url) => json(url.includes("/automation/status") ? status() : board()), {
    initialCreateDraft: { title: "주간 안내", body: "원래 요청\n수정한 초안", assigneeNpcId: "n1" },
  });
  try {
    const title = f.host.querySelector<HTMLInputElement>("#kanban-title");
    assert.equal(title?.value, "주간 안내");
    assert.equal(
      f.host.querySelector<HTMLTextAreaElement>("#kanban-body")?.value,
      "원래 요청\n수정한 초안",
    );
    assert.equal(f.host.querySelector<HTMLSelectElement>("#kanban-assignee")?.value, "n1");
    assert.equal(
      f.calls.some((call) => call.startsWith("POST")),
      false,
    );
    await f.click("취소");
    assert.ok(!f.host.querySelector("#kanban-title"));
    assert.equal(
      f.calls.some((call) => call.startsWith("POST")),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("a review card's result shows the latest Hermes summary over the old result", async () => {
  const f = await mount(
    (url) => {
      if (url.includes("/automation/status")) return json(status());
      if (url.includes("/kanban/board")) return json(board());
      return json(
        detail({
          id: "t-todo",
          title: "할 카드",
          status: "review",
          result: "지난 결과",
          latest_summary: "수정 결과 금요일 오후 5시",
        }),
      );
    },
    { initialTaskId: "t-todo" },
  );
  try {
    const result = Array.from(
      f.host.querySelectorAll('aside[aria-label="카드 상세"] section'),
    ).find((node) => node.firstElementChild?.textContent === "결과");
    assert.match(result?.textContent ?? "", /수정 결과 금요일 오후 5시/);
    assert.doesNotMatch(result?.textContent ?? "", /지난 결과/);
  } finally {
    await f.cleanup();
  }
});

for (const sample of [
  { status: "review", result: null, latest_summary: "검토 결과", expected: "검토 결과" },
  { status: "done", result: "승인된 결과", latest_summary: "실행 요약", expected: "승인된 결과" },
  { status: "done", result: null, latest_summary: "완료 결과", expected: "완료 결과" },
  { status: "ready", result: null, latest_summary: "사용자의 수정 요청", expected: "결과 없음" },
] as const) {
  test(`카드 결과 표시 ${sample.status}: ${sample.expected}`, async () => {
    const f = await mount(
      (url) => {
        if (url.includes("/automation/status")) return json(status());
        if (url.includes("/kanban/board")) return json(board());
        return json(
          detail({
            id: "t-todo",
            title: "할 카드",
            status: sample.status,
            result: sample.result,
            latest_summary: sample.latest_summary,
          }),
        );
      },
      { initialTaskId: "t-todo" },
    );
    try {
      const result = Array.from(
        f.host.querySelectorAll('aside[aria-label="카드 상세"] section'),
      ).find((node) => node.firstElementChild?.textContent === "결과");
      assert.equal(result?.textContent, `결과${sample.expected}`);
    } finally {
      await f.cleanup();
    }
  });
}

test("upstream Hermes: new cards and swarms stay available and the board says they complete without approval", async () => {
  const f = await mount((url) =>
    url.includes("/automation/status")
      ? json(status({ capabilities: ["kanban", "swarm"] }))
      : json(board()),
  );
  try {
    const buttons = [...f.host.querySelectorAll("button")];
    const create = buttons.find((b) => b.textContent?.includes("새 카드"));
    assert.equal(Boolean(create), true);
    assert.equal(create?.disabled, false);
    assert.equal(
      buttons.some((b) => b.textContent?.trim() === "스웜"),
      true,
    );
    const notice = f.host.querySelector("[data-no-approval-notice]");
    assert.equal(Boolean(notice), true);
    assert.match(notice?.textContent ?? "", /승인 없이 완료/);
  } finally {
    await f.cleanup();
  }
});

test("a policy-aware gateway shows no no-approval notice", async () => {
  const f = await mount((url) =>
    url.includes("/automation/status")
      ? json(
          status({
            capabilities: ["kanban", "swarm", "kanban_review_policy_v1", "swarm_review_policy"],
          }),
        )
      : json(board()),
  );
  try {
    assert.equal(Boolean(f.host.querySelector("[data-no-approval-notice]")), false);
  } finally {
    await f.cleanup();
  }
});

test("the swarm button comes back with the policy-aware swarm contract", async () => {
  const f = await mount((url) =>
    url.includes("/automation/status")
      ? json(
          status({
            capabilities: ["kanban", "swarm", "kanban_review_policy_v1", "swarm_review_policy"],
          }),
        )
      : json(board()),
  );
  try {
    assert.equal(
      [...f.host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "스웜"),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("a protected card's human-judgment screen shows the approval target's result instead of the AI review opinion", async () => {
  const f = await mount(
    (url) => {
      if (url.includes("/automation/status")) return json(status());
      if (url.includes("/kanban/board")) return json(board());
      return json(
        detail({
          id: "t-todo",
          title: "할 카드",
          status: "review",
          started_at: 123,
          result: "제출한 실제 결과",
          latest_summary: "AI의 수정 요청",
          review: {
            policy: { version: 1, mode: "agent", reviewer_profile: "noah" },
            policy_revision: 1,
            submission: { id: "s1", run_id: 1, hash: "hash", policy_revision: 1 },
            review_round: 3,
            state: "human_required",
            reason: "review_round_limit",
            approval: null,
          },
        }),
      );
    },
    { initialTaskId: "t-todo" },
  );
  try {
    const result = [...f.host.querySelectorAll('aside[aria-label="카드 상세"] section')].find(
      (node) => node.firstElementChild?.textContent === "결과",
    );
    assert.match(result?.textContent ?? "", /제출한 실제 결과/);
    assert.doesNotMatch(result?.textContent ?? "", /AI의 수정 요청/);
    const reassign = f.host.querySelector<HTMLSelectElement>('select[aria-label="재배정"]');
    assert.ok(!reassign || reassign.disabled);
  } finally {
    await f.cleanup();
  }
});

test("the handoff-recovery error banner shows an explanation instead of the error code", async () => {
  const f = await mount((url) => {
    if (url.includes("/automation/status"))
      return json(status({ lastError: "event_carrier_handoff_pending" }));
    return json(board());
  });
  try {
    assert.match(
      f.host.querySelector('[data-banner="lastError"]')?.textContent ?? "",
      /자동 복구 후/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a review-hooks gateway counts as enforcing approvals — no no-approval notice", async () => {
  const f = await mount((url) =>
    url.includes("/automation/status")
      ? json(status({ capabilities: ["kanban", "swarm", "review_hooks_v1"] }))
      : json(board()),
  );
  try {
    assert.equal(Boolean(f.host.querySelector("[data-no-approval-notice]")), false);
  } finally {
    await f.cleanup();
  }
});

test("a card finished outside DeskRPG says so in its detail", async () => {
  const f = await mount(
    (url) => {
      if (url.includes("/automation/status"))
        return json(status({ capabilities: ["kanban", "review_hooks_v1"] }));
      if (url.includes("/kanban/board")) return json(board());
      return json(
        detail({
          id: "t-todo",
          title: "밖에서 끝난 카드",
          status: "done",
          review: {
            policy: { version: 1, mode: "human", reviewer_profile: null },
            policy_revision: 1,
            submission: null,
            review_round: 0,
            state: "approved",
            reason: "external_done",
            approval: null,
          },
        }),
      );
    },
    { initialTaskId: "t-todo" },
  );
  try {
    const state = f.host.querySelector('[data-review-state="externalDone"]');
    assert.match(state?.textContent ?? "", /DeskRPG 밖에서 완료/);
  } finally {
    await f.cleanup();
  }
});
