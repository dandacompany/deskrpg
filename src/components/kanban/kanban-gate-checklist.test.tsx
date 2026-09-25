import "../../test-setup/dom";

import assert from "node:assert/strict";
import test from "node:test";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanTaskDetail } from "@/lib/hermes/deskrpg-plugin-types";

import { ArtifactsApiError } from "../artifacts/artifacts-api";
import type { KanbanApi } from "./kanban-api";
import KanbanBoardModal from "./KanbanBoardModal";
import TaskDrawer, { type TaskDrawerArtifacts } from "./TaskDrawer";

/**
 * Wiring test — the classification itself (classifyGateFailure/classifyBoardFailure) is already
 * covered by another file. This only pins down that "the screen keeps that classification alive
 * and opens the checklist with it."
 */

const CHANNEL = "ch-1";

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

async function mountBoard(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        {/* Provide onConnectGateway — the gateway_not_bound banner shows the button only to owners
            (non-owners get no button at all; see "unbound gateway offers connection to owners and
            guidance to members" in `KanbanBoardModal.test.tsx`). */}
        <KanbanBoardModal channelId={CHANNEL} onClose={() => {}} onConnectGateway={() => {}} />
      </I18nProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    host,
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

test("opening the checklist from the board blocker banner keeps the cause alive (gateway_not_bound)", async () => {
  const f = await mountBoard((url) => {
    if (url.includes("/automation/status")) {
      return json({ code: "gateway_not_bound", message: "게이트웨이 미연결" }, { status: 409 });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const blocker = f.host.querySelector<HTMLElement>("[data-blocker]");
    assert.equal(blocker?.dataset.blocker, "gateway_not_bound");
    await f.click("무엇이 필요한가요?");
    assert.match(f.host.textContent ?? "", /게이트웨이 연결/);
  } finally {
    await f.cleanup();
  }
});

test("board_unavailable (503+plugin_absent) from the board blocker banner also has its cause restored in the checklist", async () => {
  const f = await mountBoard((url) => {
    if (url.includes("/automation/status")) {
      return json({
        pluginStatus: "ready",
        pluginVersion: "0.6.0",
        capabilities: ["kanban"],
        timezone: "Asia/Seoul",
        boardSlug: "deskrpg-ch-1",
        dispatcherPresent: true,
        attachments: true,
        lastPolledAt: null,
        lastError: null,
        minVersion: "0.6.0",
        working: [],
      });
    }
    if (url.includes("/kanban/board")) {
      return json({ code: "plugin_absent", message: "플러그인 없음" }, { status: 503 });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const blocker = f.host.querySelector<HTMLElement>("[data-blocker]");
    assert.equal(blocker?.dataset.blocker, "board_unavailable");
    await f.click("무엇이 필요한가요?");
    // Anything other than 428 used to be flattened into board_unavailable, showing only a
    // one-line message. The checklist must point at the plugin_absent step (install the plugin).
    assert.match(f.host.textContent ?? "", /DeskRPG 플러그인 설치/);
  } finally {
    await f.cleanup();
  }
});

test("an ordinary failure (403 not_a_member) from the board blocker banner does not show the checklist button", async () => {
  const f = await mountBoard((url) => {
    if (url.includes("/automation/status")) {
      return json({
        pluginStatus: "ready",
        pluginVersion: "0.6.0",
        capabilities: ["kanban"],
        timezone: "Asia/Seoul",
        boardSlug: "deskrpg-ch-1",
        dispatcherPresent: true,
        attachments: true,
        lastPolledAt: null,
        lastError: null,
        minVersion: "0.6.0",
        working: [],
      });
    }
    if (url.includes("/kanban/board")) {
      return json({ code: "not_a_member", message: "채널 멤버가 아닙니다" }, { status: 403 });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  });
  try {
    const blocker = f.host.querySelector<HTMLElement>("[data-blocker]");
    assert.equal(blocker?.dataset.blocker, "other");
    const checklistButton = Array.from(f.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "무엇이 필요한가요?",
    );
    assert.equal(checklistButton, undefined);
  } finally {
    await f.cleanup();
  }
});

test("once the board recovers, the open checklist closes itself", async () => {
  let bound = false;
  const status = {
    pluginStatus: "ready",
    pluginVersion: "0.6.0",
    capabilities: ["kanban"],
    timezone: "Asia/Seoul",
    boardSlug: "deskrpg-ch-1",
    dispatcherPresent: true,
    attachments: true,
    lastPolledAt: null,
    lastError: null,
    minVersion: "0.6.0",
    working: [],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/automation/status")) {
      return bound
        ? json(status)
        : json({ code: "gateway_not_bound", message: "게이트웨이 미연결" }, { status: 409 });
    }
    if (url.includes("/kanban/board")) {
      return json({ board: { slug: "deskrpg-ch-1", name: "보드" }, columns: [], tasks: [] });
    }
    return json({ code: "not_found", message: "no route" }, { status: 404 });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const mount = (refreshTick: number) =>
    act(async () =>
      root.render(
        <I18nProvider initialLocale="ko">
          <KanbanBoardModal
            channelId={CHANNEL}
            onClose={() => {}}
            onConnectGateway={() => {}}
            refreshTick={refreshTick}
            debounceMs={0}
          />
        </I18nProvider>,
      ),
    );
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  try {
    await mount(0);
    await settle();
    const open = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "무엇이 필요한가요?",
    );
    assert.ok(open);
    await act(async () => open.click());
    assert.ok(document.body.textContent?.includes("이 동작에는 준비가 필요합니다"));

    bound = true;
    await mount(1);
    await settle();
    assert.equal(host.querySelector("[data-blocker]"), null, "the board recovered");
    assert.ok(
      !document.body.textContent?.includes("이 동작에는 준비가 필요합니다"),
      "the checklist closed itself",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// TaskDrawer artifacts section
// ---------------------------------------------------------------------------

const detail: KanbanTaskDetail = {
  task: { id: "t1", title: "보고서 카드", status: "todo" },
  comments: [],
  events: [],
  attachments: null,
  links: { parents: [], children: [] },
  runs: [],
};

const drawerApi = { taskDetail: async () => detail } as unknown as KanbanApi;

async function mountDrawer(artifacts: TaskDrawerArtifacts) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="ko">
        <TaskDrawer
          api={drawerApi}
          taskId="t1"
          npcs={[]}
          boardTasks={[]}
          attachmentsSupported={false}
          creationWarning={null}
          refreshTick={0}
          onChanged={() => {}}
          onEdit={() => {}}
          onDeleted={() => {}}
          onClose={() => {}}
          artifacts={artifacts}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    host,
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
    },
  };
}

test("428 on the artifacts section still hides the section, as before", async () => {
  const view = await mountDrawer({
    list: async () => {
      throw new ArtifactsApiError(428, "plugin_upgrade_required", "upgrade", "0.8.4");
    },
    open: () => {},
  });
  try {
    assert.equal(view.host.textContent?.includes("결과물"), false);
  } finally {
    await view.cleanup();
  }
});

test("409 (gateway_not_bound) on the artifacts section opens the checklist instead of flattening to one line", async () => {
  const view = await mountDrawer({
    list: async () => {
      throw new ArtifactsApiError(409, "gateway_not_bound", "게이트웨이 미연결");
    },
    open: () => {},
  });
  try {
    await view.click("무엇이 필요한가요?");
    assert.match(view.host.textContent ?? "", /게이트웨이 연결/);
  } finally {
    await view.cleanup();
  }
});

test("an ordinary failure (500 internal_error) on the artifacts section does not show the checklist button", async () => {
  const view = await mountDrawer({
    list: async () => {
      throw new ArtifactsApiError(500, "internal_error", "서버 오류");
    },
    open: () => {},
  });
  try {
    assert.match(view.host.textContent ?? "", /결과물/);
    const checklistButton = Array.from(view.host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "무엇이 필요한가요?",
    );
    assert.equal(checklistButton, undefined);
  } finally {
    await view.cleanup();
  }
});
