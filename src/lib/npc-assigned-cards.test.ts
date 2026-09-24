import assert from "node:assert/strict";
import { test } from "node:test";

import type { KanbanBoard, KanbanTask } from "@/lib/hermes/deskrpg-plugin-types";

import { assignedCards } from "./npc-assigned-cards";

/**
 * Fixtures **must keep their types alive.** The old fixture used `as never` to inject a
 * nonexistent `status: "in_progress"`, which let a sort defect that never looked at the real
 * vocabulary (`KANBAN_TASK_STATUSES`) pass the test. Typing this as `KanbanTask` blocks a
 * nonexistent status at compile time.
 */
function task(
  id: string,
  status: KanbanTask["status"],
  assignee: string | undefined,
  createdAt?: string,
): KanbanTask {
  return { id, title: id.toUpperCase(), status, assignee, created_at: createdAt };
}

function board(tasks: KanbanTask[]): KanbanBoard {
  return {
    columns: [{ name: "all", tasks }],
    tenants: [],
    assignees: [],
    latest_event_id: null,
    now: "2026-09-21T00:00:00Z",
  };
}

const mixed = board([
  task("a", "todo", "noah", "2026-09-01T00:00:00Z"),
  task("b", "todo", "sophie", "2026-09-02T00:00:00Z"),
  task("c", "running", "noah", "2026-08-01T00:00:00Z"),
  task("d", "done", "noah", "2026-09-03T00:00:00Z"),
]);

test("a card not assigned to this NPC is excluded", () => {
  assert.deepEqual(
    assignedCards(mixed, "noah").map((t) => t.id),
    ["c", "a", "d"],
  );
  assert.deepEqual(
    assignedCards(mixed, "sophie").map((t) => t.id),
    ["b"],
  );
});

test("running comes first, done comes last", () => {
  const ids = assignedCards(mixed, "noah").map((t) => t.id);
  assert.equal(ids[0], "c");
  assert.equal(ids[ids.length - 1], "d");
});

test("archived comes after done", () => {
  const b = board([
    task("arch", "archived", "noah", "2026-09-05T00:00:00Z"),
    task("done", "done", "noah", "2026-09-01T00:00:00Z"),
    task("run", "running", "noah", "2026-09-02T00:00:00Z"),
  ]);
  assert.deepEqual(
    assignedCards(b, "noah").map((t) => t.id),
    ["run", "done", "arch"],
  );
});

test("blocked/review are kept together in the waiting group — never pulled forward", () => {
  const b = board([
    task("blocked", "blocked", "noah", "2026-09-01T00:00:00Z"),
    task("running", "running", "noah", "2026-09-01T00:00:00Z"),
    task("review", "review", "noah", "2026-09-02T00:00:00Z"),
  ]);
  // running comes first, and the rest are ordered newest-first within the same group.
  assert.deepEqual(
    assignedCards(b, "noah").map((t) => t.id),
    ["running", "review", "blocked"],
  );
});

test("no created_at means it goes last within the same group", () => {
  const b = board([task("x", "todo", "noah"), task("y", "todo", "noah", "2026-09-01T00:00:00Z")]);
  assert.deepEqual(
    assignedCards(b, "noah").map((t) => t.id),
    ["y", "x"],
  );
});

test("a card with no assignee is invisible to every employee", () => {
  assert.deepEqual(assignedCards(board([task("z", "todo", undefined)]), "noah"), []);
});

test("stays newest-first even when the time comes as epoch seconds — a string comparison flips values with a different digit count", () => {
  // The real plugin gives Kanban timestamps as epoch seconds (a number). 999 < 1000, but "999" > "1000".
  const board = {
    columns: [
      {
        name: "todo",
        tasks: [
          { id: "old", title: "OLD", status: "todo", assignee: "sophie", created_at: 999 },
          { id: "new", title: "NEW", status: "todo", assignee: "sophie", created_at: 1000 },
        ],
      },
    ],
  } as unknown as Parameters<typeof assignedCards>[0];
  assert.deepEqual(
    assignedCards(board, "sophie").map((t) => t.id),
    ["new", "old"],
  );
});
