import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanTask, KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";
import {
  applyFilter,
  cardProgress,
  filterRunsByVisibleTasks,
  hasActiveFilter,
  DEFAULT_VIEW_STATE,
  directChildCount,
  groupTasks,
  isWaitingOnParents,
  normalizeViewState,
  OTHER_STATUS_GROUP_KEY,
  promoteOrphans,
  segmentWidths,
  sortTasks,
  statusSegments,
  UNSET_GROUP_KEY,
} from "./kanban-view-state";

function task(id: string, over: Partial<KanbanTask> = {}): KanbanTask {
  return { id, title: id, status: "todo", ...over };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("an empty filter filters nothing out — an unselected value must not wipe out everything", () => {
  const tasks = [task("a"), task("b", { tenant: "web" })];
  assert.deepEqual(
    applyFilter(tasks, DEFAULT_VIEW_STATE.filter).map((t) => t.id),
    ["a", "b"],
  );
});

test("tenant/assignee/status filters combine as an intersection", () => {
  const tasks = [
    task("a", { tenant: "web", assignee: "sophie", status: "todo" }),
    task("b", { tenant: "web", assignee: "oliver", status: "todo" }),
    task("c", { tenant: "api", assignee: "sophie", status: "done" }),
  ];
  const got = applyFilter(tasks, {
    ...DEFAULT_VIEW_STATE.filter,
    tenants: ["web"],
    assignees: ["sophie"],
  });
  assert.deepEqual(
    got.map((t) => t.id),
    ["a"],
  );
});

test("a card with no tenant is treated as an empty string and isn't caught by another tenant filter", () => {
  const tasks = [task("a"), task("b", { tenant: "web" })];
  const got = applyFilter(tasks, { ...DEFAULT_VIEW_STATE.filter, tenants: ["web"] });
  assert.deepEqual(
    got.map((t) => t.id),
    ["b"],
  );
});

test("warnings-only view keeps only cards with count>0", () => {
  const tasks = [
    task("a", { warnings: { count: 0 } }),
    task("b", { warnings: { count: 2, highest_severity: "high" } }),
    task("c"),
  ];
  const got = applyFilter(tasks, { ...DEFAULT_VIEW_STATE.filter, warningsOnly: true });
  assert.deepEqual(
    got.map((t) => t.id),
    ["b"],
  );
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("grouping by status follows the KANBAN_TASK_STATUSES order", () => {
  const tasks = [
    task("done1", { status: "done" }),
    task("todo1", { status: "todo" }),
    task("run1", { status: "running" }),
  ];
  assert.deepEqual(
    groupTasks(tasks, "status").map((g) => g.key),
    ["todo", "running", "done"],
  );
});

test("a card with an unknown status isn't dropped — it goes into the other group", () => {
  const tasks = [task("a", { status: "todo" }), task("x", { status: "weird" as KanbanTaskStatus })];
  const groups = groupTasks(tasks, "status");
  const other = groups.find((g) => g.key === OTHER_STATUS_GROUP_KEY);
  assert.ok(other, "기타 그룹이 없다 — 카드가 사라졌다");
  assert.deepEqual(
    other?.tasks.map((t) => t.id),
    ["x"],
  );
  assert.equal(groups.at(-1)?.key, OTHER_STATUS_GROUP_KEY, "기타 그룹은 마지막이다");
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);
  assert.equal(total, tasks.length, "묶는 과정에서 카드 수가 줄었다");
});

test("a card with no tenant goes into the 'none' group and it's always last", () => {
  const tasks = [task("a"), task("b", { tenant: "web" })];
  const groups = groupTasks(tasks, "tenant", { tenants: ["web"] });
  assert.deepEqual(
    groups.map((g) => g.key),
    ["web", UNSET_GROUP_KEY],
  );
});

test("a tenant absent from the board response list still becomes a group — a subproject with no meta must not disappear", () => {
  const tasks = [task("a", { tenant: "ghost" }), task("b", { tenant: "web" })];
  const groups = groupTasks(tasks, "tenant", { tenants: ["web"] });
  assert.deepEqual(
    groups.map((g) => g.key),
    ["web", "ghost"],
  );
  assert.equal(groups[1]?.value, "ghost", "슬러그가 값으로 그대로 남아야 화면이 표시할 수 있다");
});

test("grouping by none yields one group, and no cards means no groups", () => {
  assert.equal(groupTasks([task("a")], "none").length, 1);
  assert.deepEqual(groupTasks([], "none"), []);
  assert.deepEqual(groupTasks([], "status"), []);
});

test("empty groups are never created — empty columns are the board view's job", () => {
  const groups = groupTasks([task("a", { status: "todo" })], "status");
  assert.deepEqual(
    groups.map((g) => g.key),
    ["todo"],
  );
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test("relative order of cards sharing a key holds regardless of direction (stable sort)", () => {
  const tasks = [
    task("a", { created_at: "2026-09-01T00:00:00Z" }),
    task("b", { created_at: "2026-09-01T00:00:00Z" }),
    task("c", { created_at: "2026-09-01T00:00:00Z" }),
  ];
  assert.deepEqual(
    sortTasks(tasks, "created", "asc").map((t) => t.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    sortTasks(tasks, "created", "desc").map((t) => t.id),
    ["a", "b", "c"],
  );
});

test("cards with no date go last regardless of direction", () => {
  const tasks = [
    task("none"),
    task("old", { created_at: "2026-01-01T00:00:00Z" }),
    task("new", { created_at: "2026-09-01T00:00:00Z" }),
  ];
  assert.equal(sortTasks(tasks, "created", "asc").at(-1)?.id, "none");
  assert.equal(sortTasks(tasks, "created", "desc").at(-1)?.id, "none");
});

test("numeric priority is compared as a number — string comparison would put 10 before 2", () => {
  const tasks = [task("p10", { priority: "10" }), task("p2", { priority: "2" })];
  assert.deepEqual(
    sortTasks(tasks, "priority", "asc").map((t) => t.id),
    ["p2", "p10"],
  );
});

test("status sort uses the column order and unknown statuses go last", () => {
  const tasks = [
    task("x", { status: "weird" as KanbanTaskStatus }),
    task("d", { status: "done" }),
    task("t", { status: "todo" }),
  ];
  assert.deepEqual(
    sortTasks(tasks, "status", "asc").map((t) => t.id),
    ["t", "d", "x"],
  );
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("no bar is drawn when progress is absent or total is 0 (null)", () => {
  assert.equal(cardProgress(task("a")), null);
  assert.equal(cardProgress(task("b", { progress: { done: 0, total: 0 } })), null);
});

test("clamps so done doesn't overflow past total", () => {
  assert.deepEqual(cardProgress(task("a", { progress: { done: 9, total: 3 } })), {
    done: 3,
    total: 3,
  });
});

test("archived is excluded from the batch progress denominator", () => {
  const tasks = [
    task("a", { status: "done" }),
    task("b", { status: "todo" }),
    task("z", { status: "archived" }),
  ];
  const { segments, counted } = statusSegments(tasks);
  assert.equal(counted, 2, "보관한 일을 미완으로 세면 100% 에 영영 닿지 않는다");
  assert.equal(
    segments.some((s) => s.status === "archived"),
    false,
  );
});

test("segments come out in status order and a status with 0 is excluded", () => {
  const tasks = [task("a", { status: "done" }), task("b", { status: "todo" })];
  assert.deepEqual(
    statusSegments(tasks).segments.map((s) => s.status),
    ["todo", "done"],
  );
});

test("no countable cards means an empty array for width — no 0% bar is drawn", () => {
  const { segments, counted } = statusSegments([task("z", { status: "archived" })]);
  assert.equal(counted, 0);
  assert.deepEqual(segmentWidths(segments, counted), []);
});

test("segment widths sum to 100", () => {
  const tasks = [
    task("a", { status: "done" }),
    task("b", { status: "todo" }),
    task("c", { status: "todo" }),
  ];
  const { segments, counted } = statusSegments(tasks);
  const total = segmentWidths(segments, counted).reduce((n, s) => n + s.percent, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `합이 100 이 아니다: ${total}`);
});

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

test("direct child count uses the board response's link_counts as-is", () => {
  assert.equal(directChildCount(task("a", { link_counts: { parents: 1, children: 3 } })), 3);
  assert.equal(directChildCount(task("b")), 0);
});

test("if the parent is absent from the visible list, the child is promoted to root — the card doesn't disappear", () => {
  const tasks = [task("child")];
  const parentOf = new Map([["child", "archived-parent"]]);
  const { roots, childrenOf } = promoteOrphans(tasks, parentOf);
  assert.deepEqual(
    roots.map((t) => t.id),
    ["child"],
  );
  assert.equal(childrenOf.size, 0);
});

test("if the parent is in the list, the child is nested under it", () => {
  const tasks = [task("parent"), task("child")];
  const parentOf = new Map([["child", "parent"]]);
  const { roots, childrenOf } = promoteOrphans(tasks, parentOf);
  assert.deepEqual(
    roots.map((t) => t.id),
    ["parent"],
  );
  assert.deepEqual(
    childrenOf.get("parent")?.map((t) => t.id),
    ["child"],
  );
});

test("waiting on parents is true only when the card is todo and has an unfinished parent", () => {
  const child = task("c", { status: "todo" });
  assert.equal(isWaitingOnParents(child, [task("p", { status: "running" })]), true);
  assert.equal(isWaitingOnParents(child, [task("p", { status: "done" })]), false);
  assert.equal(isWaitingOnParents(child, [task("p", { status: "archived" })]), false);
  assert.equal(isWaitingOnParents(child, []), false);
  assert.equal(
    isWaitingOnParents(task("c", { status: "running" }), [task("p", { status: "todo" })]),
    false,
    "이미 돌고 있는 카드는 부모 대기가 아니다",
  );
});

// ---------------------------------------------------------------------------
// Saved view state
// ---------------------------------------------------------------------------

test("a stale or broken saved value falls back to the default", () => {
  assert.deepEqual(normalizeViewState(null), DEFAULT_VIEW_STATE);
  assert.deepEqual(normalizeViewState("nonsense"), DEFAULT_VIEW_STATE);
  assert.deepEqual(normalizeViewState({ viewMode: "gantt", groupBy: "moon" }), DEFAULT_VIEW_STATE);
});

test("an unknown status filter value is dropped — a filter that can't open must not wipe out all cards", () => {
  const got = normalizeViewState({ filter: { statuses: ["todo", "weird"] } });
  assert.deepEqual(got.filter.statuses, ["todo"]);
});

test("a valid saved value is read as-is", () => {
  const got = normalizeViewState({
    viewMode: "list",
    groupBy: "tenant",
    sortField: "title",
    sortDir: "asc",
    filter: { tenants: ["web"], includeArchived: true },
    collapsedGroups: ["web"],
  });
  assert.equal(got.viewMode, "list");
  assert.equal(got.groupBy, "tenant");
  assert.equal(got.sortField, "title");
  assert.equal(got.sortDir, "asc");
  assert.deepEqual(got.filter.tenants, ["web"]);
  assert.equal(got.filter.includeArchived, true);
  assert.deepEqual(got.collapsedGroups, ["web"]);
});

test("sorting by creation date also works with epoch seconds sent by the plugin", () => {
  // Failing to read an integer timestamp would dump everything into "no value," silently making the sort fall back to input order.
  const tasks = [task("new", { created_at: 1758412800 }), task("old", { created_at: 1750000000 })];
  assert.deepEqual(
    sortTasks(tasks, "created", "asc").map((t) => t.id),
    ["old", "new"],
  );
  assert.deepEqual(
    sortTasks(tasks, "created", "desc").map((t) => t.id),
    ["new", "old"],
  );
});

test("a mix of epoch seconds and ISO still sorts as one consistent line", () => {
  const tasks = [
    task("iso-new", { created_at: "2025-09-21T00:00:00.000Z" }),
    task("epoch-old", { created_at: 1750000000 }),
  ];
  assert.deepEqual(
    sortTasks(tasks, "created", "asc").map((t) => t.id),
    ["epoch-old", "iso-new"],
  );
});

test("with no filter, run records aren't filtered out — a run for a deleted card must not disappear", () => {
  const runs = [{ task_id: "gone" }, { task_id: "a" }];
  assert.equal(hasActiveFilter(DEFAULT_VIEW_STATE.filter), false);
  assert.deepEqual(filterRunsByVisibleTasks(runs, null), runs);
});

test("when a filter is active, only runs for visible cards remain", () => {
  const runs = [{ task_id: "web" }, { task_id: "api" }];
  assert.deepEqual(filterRunsByVisibleTasks(runs, new Set(["web"])), [{ task_id: "web" }]);
});

test("having only the archive view toggled on is not itself a filter", () => {
  // That's the server query scope — there's no reason to filter again for what the response already excludes.
  assert.equal(hasActiveFilter({ ...DEFAULT_VIEW_STATE.filter, includeArchived: true }), false);
});

test("tenant/assignee/status/warnings filters all count as active", () => {
  const base = DEFAULT_VIEW_STATE.filter;
  assert.equal(hasActiveFilter({ ...base, tenants: ["web"] }), true);
  assert.equal(hasActiveFilter({ ...base, assignees: ["sophie"] }), true);
  assert.equal(hasActiveFilter({ ...base, statuses: ["todo"] }), true);
  assert.equal(hasActiveFilter({ ...base, warningsOnly: true }), true);
});
