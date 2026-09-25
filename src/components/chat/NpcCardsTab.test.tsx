import "../../test-setup/dom";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { I18nProvider } from "@/lib/i18n/context";
import type { KanbanBoard } from "@/lib/hermes/deskrpg-plugin-types";

import NpcCardsTab, { type NpcCardsTabProps } from "./NpcCardsTab";

function render(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<I18nProvider initialLocale="ko">{ui}</I18nProvider>);
  });
  return {
    container: host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const boardWithTwoMine: KanbanBoard = {
  columns: [
    {
      name: "todo",
      tasks: [
        { id: "a", title: "다른 사람 카드", status: "todo", assignee: "noah" },
        { id: "c", title: "진행 중인 내 카드", status: "todo", assignee: "sophie" },
      ],
    },
    {
      name: "running",
      tasks: [{ id: "b", title: "실행 중인 내 카드", status: "running", assignee: "sophie" }],
    },
  ],
  tenants: [],
  assignees: ["sophie", "noah"],
  latest_event_id: null,
  now: "2026-09-21T00:00:00Z",
};

const props: NpcCardsTabProps = {
  npcProfile: "sophie",
  board: null,
  error: null,
  onOpenCard: () => {},
};

test("assigned cards show as a list", () => {
  const { container, cleanup } = render(<NpcCardsTab {...props} board={boardWithTwoMine} />);
  try {
    assert.equal(container.querySelectorAll("[data-card-id]").length, 2);
  } finally {
    cleanup();
  }
});

test("clicking a card calls onOpenCard with that id", () => {
  const seen: string[] = [];
  const { container, cleanup } = render(
    <NpcCardsTab {...props} board={boardWithTwoMine} onOpenCard={(id) => seen.push(id)} />,
  );
  try {
    (container.querySelector("[data-card-id='c']") as HTMLElement).click();
    assert.deepEqual(seen, ["c"]);
  } finally {
    cleanup();
  }
});

test("shows the empty-state message when there are no assigned cards", () => {
  const emptyBoard: KanbanBoard = {
    columns: [],
    tenants: [],
    assignees: [],
    latest_event_id: null,
    now: "2026-09-21T00:00:00Z",
  };
  const { container, cleanup } = render(<NpcCardsTab {...props} board={emptyBoard} />);
  try {
    assert.equal(container.querySelectorAll("[data-card-id]").length, 0);
    assert.ok(container.querySelector("[data-testid='cards-empty']"));
  } finally {
    cleanup();
  }
});

test("when blocked by a gate, shows the reason — not disguised as an empty list", () => {
  const { container, cleanup } = render(
    <NpcCardsTab {...props} board={null} error="plugin_required" />,
  );
  try {
    assert.ok(container.querySelector("[data-testid='cards-error']"));
    assert.ok(!container.querySelector("[data-testid='cards-empty']"));
  } finally {
    cleanup();
  }
});

test("board not ready (board_unavailable) reuses Kanban's board-unavailable message — not collapsed into an unknown error", () => {
  const { container, cleanup } = render(
    <NpcCardsTab {...props} board={null} error="board_unavailable" />,
  );
  try {
    const notice = container.querySelector("[data-testid='cards-error']");
    assert.ok(notice);
    assert.ok(!container.querySelector("[data-testid='cards-empty']"));
    // Same title as the Kanban board-unavailable banner — not the generic "unknown error" fallback from wizard-error-codes.
    assert.match(notice!.textContent ?? "", /보드를 확보하지 못했습니다/);
    assert.doesNotMatch(notice!.textContent ?? "", /알 수 없는 오류/);
  } finally {
    cleanup();
  }
});

test("renders neither empty nor error before the fetch finishes — doesn't assume the unconfirmed", () => {
  const { container, cleanup } = render(<NpcCardsTab {...props} board={null} error={null} />);
  try {
    assert.ok(!container.querySelector("[data-testid='cards-empty']"));
    assert.ok(!container.querySelector("[data-testid='cards-error']"));
    assert.ok(container.querySelector("[data-testid='cards-loading']"), "스켈레톤이 없다");
  } finally {
    cleanup();
  }
});

test("without a known profile, unassigned cards aren't attributed to this staff member — and the skeleton ends", () => {
  const board: KanbanBoard = {
    ...boardWithTwoMine,
    columns: [
      {
        name: "todo",
        tasks: [{ id: "u", title: "담당 없는 카드", status: "todo", assignee: "" }],
      },
    ],
  };
  const { container, cleanup } = render(
    <NpcCardsTab {...props} npcProfile="" board={board} error={null} />,
  );
  try {
    assert.equal(container.querySelectorAll("[data-card-id]").length, 0);
    // Once the board has arrived, loading is over — it shows a settled state, not an infinite skeleton.
    assert.ok(!container.querySelector("[data-testid='cards-loading']"));
    assert.ok(container.querySelector("[data-testid='cards-empty']"));
  } finally {
    cleanup();
  }
});

// Every kind `classifyGateFailure` can emit needs its own message — patching them one at a
// time lets the same defect resurface in the next code (`plugin_absent` once fell back to "unknown error").
const GATE_CODES = [
  "gateway_not_bound",
  "plugin_absent",
  "plugin_unauthorized",
  "plugin_upgrade_required",
  "timeout",
  "unreachable",
  "plugin_unknown",
  "board_unavailable",
] as const;

test("every gate code gets its own message, not a fallback — no raw code exposed", () => {
  const fallback = renderErrorText("some_code_that_does_not_exist");
  for (const code of GATE_CODES) {
    const text = renderErrorText(code);
    assert.notEqual(text, fallback, `${code} 가 폴백 문구와 같다`);
    // `board_unavailable`, like the Kanban board, appends technical detail (`failureLine`)
    // below the title — that's intentional detail, not a fallback.
    if (code !== "board_unavailable") {
      assert.doesNotMatch(text, new RegExp(code), `${code} 원시 코드가 화면에 보인다`);
    }
  }
});

test("when the plugin is missing, install instructions show — not an unknown error", () => {
  const text = renderErrorText("plugin_absent");
  assert.doesNotMatch(text, /알 수 없는 오류/);
  assert.match(text, /hermes/i, "설치 명령이 보이지 않는다");
});

function renderErrorText(code: string): string {
  const { container, cleanup } = render(<NpcCardsTab {...props} board={null} error={code} />);
  try {
    const alert = container.querySelector("[data-testid='cards-error']");
    assert.ok(alert, `${code} 에 안내가 없다`);
    assert.ok(!container.querySelector("[data-testid='cards-empty']"));
    assert.ok(!container.querySelector("[data-testid='cards-loading']"));
    return alert.textContent ?? "";
  } finally {
    cleanup();
  }
}

test("the running count comes from the working signal, not from recounting the list", () => {
  // The list has one running card on this board; the signal counts every board of the channel.
  const { container, cleanup } = render(
    <NpcCardsTab {...props} board={boardWithTwoMine} runningCards={3} />,
  );
  try {
    const count = container.querySelector('[data-testid="cards-running-count"]');
    assert.ok(count, "the count is shown while cards are running");
    assert.match(count.textContent ?? "", /3/);
  } finally {
    cleanup();
  }
});

test("the running count is hidden when nothing is running", () => {
  const { container, cleanup } = render(
    <NpcCardsTab {...props} board={boardWithTwoMine} runningCards={0} />,
  );
  try {
    assert.ok(!container.querySelector('[data-testid="cards-running-count"]'));
  } finally {
    cleanup();
  }
});
