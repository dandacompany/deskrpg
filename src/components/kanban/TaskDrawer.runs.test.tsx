import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanTaskDetail } from "@/lib/hermes/deskrpg-plugin-types";

import type { KanbanApi } from "./kanban-api";
import TaskDrawer from "./TaskDrawer";

// `I18nProvider` defaults to English.

async function renderDrawer(detail: KanbanTaskDetail, extra: Partial<KanbanApi> = {}) {
  const api = { taskDetail: async () => detail, ...extra } as unknown as KanbanApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider>
        <TaskDrawer
          api={api}
          taskId={detail.task.id}
          npcs={[]}
          boardTasks={[]}
          attachmentsSupported={false}
          creationWarning={null}
          refreshTick={0}
          onChanged={() => {}}
          onEdit={() => {}}
          onDeleted={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function detail(
  over: Partial<KanbanTaskDetail> & { task: KanbanTaskDetail["task"] },
): KanbanTaskDetail {
  return {
    comments: [],
    events: [],
    attachments: null,
    links: { parents: [], children: [] },
    runs: [],
    ...over,
  };
}

test("runs read as numbered attempts, newest first, with the failure cause in words", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "ready", consecutive_failures: 1 },
      runs: [
        {
          id: "1",
          status: "crashed",
          outcome: "crashed",
          error: "Incorrect API key provided",
          started_at: 100,
          ended_at: 110,
        },
        { id: "2", status: "done", outcome: "completed", started_at: 200, ended_at: 210 },
      ],
    }),
  );
  try {
    const items = [...f.host.querySelectorAll("[data-attempt]")];
    assert.deepEqual(
      items.map((el) => el.getAttribute("data-attempt")),
      ["2", "1"],
    );
    const failed = f.host.querySelector('[data-attempt="1"]');
    assert.equal(failed?.textContent?.includes("Attempt 1"), true);
    assert.equal(failed?.querySelector('[data-attempt-cause="provider_auth"]') !== null, true);
    // The raw text is kept behind "Details", not lost.
    assert.equal(
      failed?.querySelector("details")?.textContent?.includes("Incorrect API key"),
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("a manually stopped run says so instead of the raw reclaimed outcome", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "ready" },
      runs: [
        {
          id: "1",
          status: "reclaimed",
          outcome: "reclaimed",
          error: "manual_reclaim: terminated by deskrpg",
          started_at: 100,
          ended_at: 110,
        },
      ],
    }),
  );
  try {
    const item = f.host.querySelector('[data-attempt="1"]');
    assert.equal(item?.getAttribute("data-attempt-end"), "stopped");
    assert.equal(item?.textContent?.includes("Stopped by a person"), true);
  } finally {
    await f.cleanup();
  }
});

test("a card blocked after repeated failures says a person has to unblock it", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "blocked", consecutive_failures: 3 },
      runs: [
        { id: "1", status: "timed_out", outcome: "timed_out", started_at: 100, ended_at: 110 },
      ],
    }),
  );
  try {
    const state = f.host.querySelector('[data-run-state="gave_up"]');
    assert.equal(state !== null, true);
    assert.equal(state?.textContent?.includes("3 failures"), true);
  } finally {
    await f.cleanup();
  }
});

test("a failed card back in the queue says it will be retried", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "ready", consecutive_failures: 2 },
      runs: [{ id: "1", status: "crashed", outcome: "crashed", started_at: 100, ended_at: 110 }],
    }),
  );
  try {
    assert.equal(f.host.querySelector('[data-run-state="retrying"]') !== null, true);
  } finally {
    await f.cleanup();
  }
});

test("events with a run id are listed under their attempt", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "ready" },
      runs: [{ id: "7", status: "crashed", outcome: "crashed", started_at: 100, ended_at: 110 }],
      events: [
        { id: "e1", kind: "created", payload: {}, created_at: 90, run_id: null },
        { id: "e2", kind: "spawned", payload: {}, created_at: 100, run_id: 7 },
      ],
    }),
  );
  try {
    const details = f.host.querySelector('[data-attempt="1"] details');
    assert.equal(details?.textContent?.includes("spawned"), true);
    assert.equal(details?.textContent?.includes("created"), false);
  } finally {
    await f.cleanup();
  }
});

test("stopping a running card warns that it will run again", async () => {
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "running" },
      runs: [{ id: "1", status: "running", started_at: 100 }],
    }),
  );
  try {
    const hint = f.host.querySelector("[data-terminate-hint]");
    assert.equal(hint !== null, true);
    assert.equal(hint?.textContent?.includes("run again"), true);
    assert.equal(
      f.host.querySelector('[data-attempt="1"]')?.getAttribute("data-attempt-end"),
      "running",
    );
  } finally {
    await f.cleanup();
  }
});

test("an attempt shows what the worker reported about how it made the result", async () => {
  const ws = "/srv/hermes/kanban/boards/b/workspaces/t1";
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "done", workspace_path: ws },
      runs: [
        {
          id: "1",
          status: "done",
          outcome: "completed",
          started_at: 100,
          ended_at: 110,
          metadata: {
            changed_files: [`${ws}/draft.md`, "/etc/app.conf"],
            verification: { file_read_back: true, source_count: 12 },
            limitations: ["No live prices"],
            worker_session_id: "s1",
            included_sections: ["a", "b"],
          },
        },
        { id: "2", status: "done", outcome: "completed", started_at: 200, ended_at: 210 },
      ],
    }),
  );
  try {
    const [newest, oldest] = [...f.host.querySelectorAll("[data-attempt]")];
    assert.equal(newest.querySelector('[data-run-provenance=""]') === null, true);
    const made = oldest.querySelector('[data-run-provenance=""]');
    assert.equal(made !== null, true);
    const files = made!.querySelector('[data-run-provenance="changedFiles"]')?.textContent ?? "";
    assert.equal(files.includes("draft.md, app.conf"), true);
    assert.equal(files.includes("/etc"), false);
    const checks = made!.querySelector('[data-run-provenance="checks"]')?.textContent ?? "";
    assert.equal(checks.includes("file_read_back ✓ · source_count 12"), true);
    assert.equal(
      (made!.querySelector('[data-run-provenance="limitations"]')?.textContent ?? "").includes(
        "No live prices",
      ),
      true,
    );
    assert.equal(
      made!.querySelector('[data-run-provenance="other"]')?.textContent,
      "Other notes from the worker: 1",
    );
  } finally {
    await f.cleanup();
  }
});

test("an attempt with a worker session offers its sources, loaded only when opened", async () => {
  const asked: string[] = [];
  const f = await renderDrawer(
    detail({
      task: { id: "t1", title: "card", status: "done" },
      runs: [
        {
          id: "7",
          status: "done",
          outcome: "completed",
          started_at: 100,
          ended_at: 110,
          metadata: { worker_session_id: "sess_w" },
        },
        { id: "8", status: "done", outcome: "completed", started_at: 200, ended_at: 210 },
      ],
    }),
    {
      runSources: async (taskId: string, runId: string) => {
        asked.push(`${taskId}/${runId}`);
        return {
          status: "ok" as const,
          sources: [
            {
              kind: "web" as const,
              ref: "https://a.example/",
              title: "A",
              via: "web_extract",
              at: null,
            },
          ],
          outsideWorkdirFiles: 0,
          truncated: false,
        };
      },
    },
  );
  try {
    const [newest, oldest] = [...f.host.querySelectorAll("[data-attempt]")];
    assert.equal(newest.querySelector("[data-session-sources]") === null, true);
    const summary = oldest.querySelector("[data-session-sources] > summary") as HTMLElement | null;
    assert.equal(summary !== null, true);
    assert.deepEqual(asked, []);
    await act(async () => summary!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.deepEqual(asked, ["t1/7"]);
    assert.equal(
      oldest.querySelector('[data-session-sources] a[href="https://a.example/"]') !== null,
      true,
    );
  } finally {
    await f.cleanup();
  }
});
