/**
 * Pure logic for the project view — knows nothing about React, fetch, or the DOM.
 *
 * The board and the list are **not different screens, just different presentations of the
 * same data**. What to filter, how to group, what order to place things in, and how to count
 * progress are all pinned down in this one place. Components only render the result.
 *
 * This file does not define the status set (`KANBAN_TASK_STATUSES`) and does not change card
 * state. Everything here is a read-only derivation.
 */

import {
  KANBAN_TASK_STATUSES,
  type KanbanTask,
  type KanbanTaskStatus,
  type PluginTime,
} from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type ViewMode = "board" | "list" | "timeline";
export type GroupBy = "none" | "status" | "tenant" | "assignee" | "priority";
export type SortField = "created" | "started" | "priority" | "title" | "status";
export type SortDir = "asc" | "desc";

export type ViewFilter = {
  tenants: string[];
  assignees: string[];
  statuses: KanbanTaskStatus[];
  warningsOnly: boolean;
  /**
   * Whether to include the archive. The old modal's toggle moved here — if a switch with the
   * same meaning existed in two places, you couldn't tell which one is true. This value is
   * also used for the server query (`board(includeArchived)`).
   */
  includeArchived: boolean;
};

export type ProjectViewState = {
  viewMode: ViewMode;
  groupBy: GroupBy;
  sortField: SortField;
  sortDir: SortDir;
  filter: ViewFilter;
  collapsedGroups: string[];
};

export const DEFAULT_VIEW_STATE: ProjectViewState = {
  viewMode: "board",
  groupBy: "status",
  sortField: "created",
  sortDir: "desc",
  filter: {
    tenants: [],
    assignees: [],
    statuses: [],
    warningsOnly: false,
    includeArchived: false,
  },
  collapsedGroups: [],
};

/**
 * Doesn't trust the value read from `localStorage` — folds it into shape. The screen must not
 * break even if a stale schema, a hand-edited value, or a value left by another version comes in.
 */
export function normalizeViewState(value: unknown): ProjectViewState {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<ProjectViewState>;
  const rawFilter = (
    raw.filter && typeof raw.filter === "object" ? raw.filter : {}
  ) as Partial<ViewFilter>;
  return {
    viewMode: raw.viewMode === "list" || raw.viewMode === "timeline" ? raw.viewMode : "board",
    groupBy: isGroupBy(raw.groupBy) ? raw.groupBy : DEFAULT_VIEW_STATE.groupBy,
    sortField: isSortField(raw.sortField) ? raw.sortField : DEFAULT_VIEW_STATE.sortField,
    sortDir: raw.sortDir === "asc" ? "asc" : "desc",
    filter: {
      tenants: stringList(rawFilter.tenants),
      assignees: stringList(rawFilter.assignees),
      statuses: stringList(rawFilter.statuses).filter(isTaskStatus),
      warningsOnly: rawFilter.warningsOnly === true,
      includeArchived: rawFilter.includeArchived === true,
    },
    collapsedGroups: stringList(raw.collapsedGroups),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isGroupBy(value: unknown): value is GroupBy {
  return (
    value === "none" ||
    value === "status" ||
    value === "tenant" ||
    value === "assignee" ||
    value === "priority"
  );
}

function isSortField(value: unknown): value is SortField {
  return (
    value === "created" ||
    value === "started" ||
    value === "priority" ||
    value === "title" ||
    value === "status"
  );
}

function isTaskStatus(value: string): value is KanbanTaskStatus {
  return (KANBAN_TASK_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * An empty array means "everything" — a filter with nothing selected must not wipe out
 * every card.
 *
 * `includeArchived` is not checked here. That is the server query's scope, and filtering
 * again against cards it never returned would create the same rule in two places.
 */
export function applyFilter(tasks: readonly KanbanTask[], filter: ViewFilter): KanbanTask[] {
  const tenants = new Set(filter.tenants);
  const assignees = new Set(filter.assignees);
  const statuses = new Set<string>(filter.statuses);
  return tasks.filter((task) => {
    if (tenants.size > 0 && !tenants.has(task.tenant ?? "")) return false;
    if (assignees.size > 0 && !assignees.has(task.assignee ?? "")) return false;
    if (statuses.size > 0 && !statuses.has(task.status)) return false;
    if (filter.warningsOnly && !(task.warnings && task.warnings.count > 0)) return false;
    return true;
  });
}

/** Is any filter currently active? If not, there's nothing to filter — an empty filter must not remove cards. */
export function hasActiveFilter(filter: ViewFilter): boolean {
  return (
    filter.tenants.length > 0 ||
    filter.assignees.length > 0 ||
    filter.statuses.length > 0 ||
    filter.warningsOnly
  );
}

/**
 * Filters run records down to **visible cards**. Returns them as-is if there's no filter.
 *
 * If the filter only applies to the board and list but not to the timeline, picking a
 * sub-project leaves the timeline unchanged — a silent failure where the screen claims to
 * have done something but hasn't (we've hit the same defect once before, in the board view).
 *
 * It matters that we don't filter when there's no filter. Runs for deleted cards still stay
 * in the record (the plugin deliberately keeps them via a LEFT JOIN), and intersecting against
 * visible cards would silently drop them.
 */
export function filterRunsByVisibleTasks<T extends { task_id: string }>(
  runs: readonly T[],
  visibleTaskIds: ReadonlySet<string> | null,
): readonly T[] {
  if (visibleTaskIds === null) return runs;
  return runs.filter((run) => visibleTaskIds.has(run.task_id));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Empty values always go last — flipping the direction must not put "unknown" at the front. */
function compareTasks(a: KanbanTask, b: KanbanTask, field: SortField): number {
  switch (field) {
    case "created":
      return compareMaybeTime(a.created_at, b.created_at);
    case "started":
      return compareMaybeTime(a.started_at, b.started_at);
    case "priority":
      return comparePriority(a.priority, b.priority);
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return statusIndex(a.status) - statusIndex(b.status);
  }
}

function compareMaybeTime(a: PluginTime | undefined, b: PluginTime | undefined): number {
  // Only called when both values are present — where missing values go is decided separately by `sortTasks`.
  return (taskTimeMs(a) ?? 0) - (taskTimeMs(b) ?? 0);
}

/**
 * Hermes's `priority` is a number, but it comes over as a string in the plugin contract.
 * Compares as a number when it reads as one, otherwise falls back to a string comparison —
 * so a value like "P1" doesn't lose its ordering.
 */
function comparePriority(a: string | undefined, b: string | undefined): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return (a ?? "").localeCompare(b ?? "");
}

function statusIndex(status: string): number {
  const i = (KANBAN_TASK_STATUSES as readonly string[]).indexOf(status);
  // Unknown statuses go last. They are not dropped.
  return i === -1 ? KANBAN_TASK_STATUSES.length : i;
}

/** Does this card have a value for the sort field? If not, it goes last regardless of direction. */
function hasSortKey(task: KanbanTask, field: SortField): boolean {
  switch (field) {
    case "created":
      return taskTimeMs(task.created_at) !== null;
    case "started":
      return taskTimeMs(task.started_at) !== null;
    case "priority":
      return task.priority !== undefined && task.priority !== "";
    case "title":
    case "status":
      return true;
  }
}

/**
 * Stable sort. If the relative order of cards sharing a key changed on every refetch, rows
 * would jump around for no reason.
 *
 * **Cards without a value stay last even when the direction is flipped.** Multiplying the
 * whole comparison result by a sign would also flip the "missing goes last" rule, putting
 * undated cards first in descending order (a defect caught by observation). So we split
 * cards with and without a value first, and apply the sign only to comparisons between values.
 */
export function sortTasks(
  tasks: readonly KanbanTask[],
  field: SortField,
  dir: SortDir,
): KanbanTask[] {
  const sign = dir === "asc" ? 1 : -1;
  const withKey: KanbanTask[] = [];
  const withoutKey: KanbanTask[] = [];
  for (const task of tasks) (hasSortKey(task, field) ? withKey : withoutKey).push(task);
  withKey.sort((a, b) => sign * compareTasks(a, b, field));
  return [...withKey, ...withoutKey];
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type TaskGroup = {
  /** A stable identifier — the key that remembers collapse state. Can differ from the display name. */
  key: string;
  /** The raw value, e.g. a sub-project slug. The screen looks up the display name from metadata. */
  value: string | null;
  tasks: KanbanTask[];
};

/** The group that cards without a value fall into. Always comes last. */
export const UNSET_GROUP_KEY = "__unset__";

/** The group that unknown status values fall into. A place to hold cards without dropping them. */
export const OTHER_STATUS_GROUP_KEY = "__other_status__";

/**
 * Groups by the `groupBy` criterion.
 *
 * - `status` follows `KANBAN_TASK_STATUSES` order, and unknown statuses go into an "other"
 *   group. **Cards are never dropped** — a card that vanishes from the screen gives the user
 *   no way to find it.
 * - `tenant`/`assignee` use the order of the list (`known`) the board response provided first,
 *   and also create groups for values not in that list. Hiding a tenant with no metadata would
 *   make those cards disappear entirely.
 * - Cards with an empty value collect into the `UNSET_GROUP_KEY` group, which is **always last**.
 * - Empty groups are never created (same for `status` — empty columns are the board view's job).
 */
export function groupTasks(
  tasks: readonly KanbanTask[],
  by: GroupBy,
  known: { tenants?: readonly string[]; assignees?: readonly string[] } = {},
): TaskGroup[] {
  if (by === "none") {
    return tasks.length > 0 ? [{ key: "all", value: null, tasks: [...tasks] }] : [];
  }

  const buckets = new Map<string, TaskGroup>();
  const push = (key: string, value: string | null, task: KanbanTask) => {
    const existing = buckets.get(key);
    if (existing) existing.tasks.push(task);
    else buckets.set(key, { key, value, tasks: [task] });
  };

  for (const task of tasks) {
    if (by === "status") {
      const isKnown = isTaskStatus(task.status);
      push(isKnown ? task.status : OTHER_STATUS_GROUP_KEY, isKnown ? task.status : null, task);
      continue;
    }
    const raw = by === "tenant" ? task.tenant : by === "assignee" ? task.assignee : task.priority;
    const value = (raw ?? "").trim();
    push(value === "" ? UNSET_GROUP_KEY : value, value === "" ? null : value, task);
  }

  return orderGroups([...buckets.values()], by, known);
}

function orderGroups(
  groups: TaskGroup[],
  by: GroupBy,
  known: { tenants?: readonly string[]; assignees?: readonly string[] },
): TaskGroup[] {
  const rank = new Map<string, number>();
  if (by === "status") {
    KANBAN_TASK_STATUSES.forEach((name, i) => rank.set(name, i));
  } else if (by === "tenant" || by === "assignee") {
    const list = by === "tenant" ? known.tenants : known.assignees;
    (list ?? []).forEach((name, i) => rank.set(name, i));
  }

  const last = Number.MAX_SAFE_INTEGER;
  const scoreOf = (group: TaskGroup): number => {
    if (group.key === UNSET_GROUP_KEY || group.key === OTHER_STATUS_GROUP_KEY) return last;
    // A value absent from the response list goes after known values, but before the "unset" group.
    return rank.get(group.key) ?? last - 1;
  };

  return groups.sort((a, b) => {
    const diff = scoreOf(a) - scoreOf(b);
    if (diff !== 0) return diff;
    if (a.key === b.key) return 0;
    // Same score (both unknown values) → alphabetical, so order doesn't shift on every refetch.
    return a.key.localeCompare(b.key);
  });
}

// ---------------------------------------------------------------------------
// Progress — the two kinds are never mixed
// ---------------------------------------------------------------------------

/**
 * Card progress = the completion count of that card's **child cards**. If there are no
 * children, it's `null` and no bar is drawn. Rendering 0/0 as 0% would look like "work not
 * started" — really it just has no children to count.
 */
export function cardProgress(task: KanbanTask): { done: number; total: number } | null {
  const p = task.progress;
  if (!p || p.total <= 0) return null;
  return { done: Math.max(0, Math.min(p.done, p.total)), total: p.total };
}

export type StatusSegment = { status: KanbanTaskStatus; count: number };

/**
 * Group progress = status-distribution segments. It's a different figure from card progress,
 * so it looks different on screen too.
 *
 * **`archived` is excluded from the denominator.** Counting archived work as incomplete would
 * mean progress never reaches 100%. Unknown statuses aren't counted either (we don't invent
 * statuses) — instead `counted` reports how many cards were tallied.
 */
export function statusSegments(tasks: readonly KanbanTask[]): {
  segments: StatusSegment[];
  counted: number;
} {
  const counts = new Map<KanbanTaskStatus, number>();
  let counted = 0;
  for (const task of tasks) {
    if (task.status === "archived") continue;
    if (!isTaskStatus(task.status)) continue;
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    counted += 1;
  }
  const segments = KANBAN_TASK_STATUSES.filter((s) => s !== "archived")
    .map((status) => ({ status, count: counts.get(status) ?? 0 }))
    .filter((segment) => segment.count > 0);
  return { segments, counted };
}

/** The segment bar widths (%). Returns an empty array when `counted` is 0 — no 0% bar is drawn. */
export function segmentWidths(
  segments: readonly StatusSegment[],
  counted: number,
): Array<StatusSegment & { percent: number }> {
  if (counted <= 0) return [];
  return segments.map((segment) => ({ ...segment, percent: (segment.count / counted) * 100 }));
}

// ---------------------------------------------------------------------------
// Subtrees (D1(a) — only expanded cards fetch detail)
// ---------------------------------------------------------------------------

/** Does the card have direct children? Not total descendant count — the board response only gives the direct count. */
export function directChildCount(task: KanbanTask): number {
  return Math.max(0, task.link_counts?.children ?? 0);
}

/**
 * Promotes a card whose parent is **not in the currently visible list** to a root.
 *
 * This prevents a child from disappearing without attaching anywhere in the tree when its
 * parent was filtered out by `include_archived=false`. A card that silently vanishes from
 * the screen gives the user no way to find it.
 */
export function promoteOrphans(
  tasks: readonly KanbanTask[],
  parentOf: ReadonlyMap<string, string | undefined>,
): { roots: KanbanTask[]; childrenOf: Map<string, KanbanTask[]> } {
  const present = new Set(tasks.map((t) => t.id));
  const roots: KanbanTask[] = [];
  const childrenOf = new Map<string, KanbanTask[]>();
  for (const task of tasks) {
    const parent = parentOf.get(task.id);
    if (parent && present.has(parent)) {
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(task);
      childrenOf.set(parent, siblings);
    } else {
      roots.push(task);
    }
  }
  return { roots, childrenOf };
}

/**
 * Is this card stuck because its parent isn't done yet?
 *
 * Hermes only promotes `todo` to `ready` once all parents are done/archived, and rejects
 * claims with `parents_not_done` before that. So a card can sit in `todo` with nobody picking
 * it up — and if the screen doesn't explain why, it just looks stalled.
 */
export function isWaitingOnParents(
  task: KanbanTask,
  parents: readonly KanbanTask[] | undefined,
): boolean {
  if (task.status !== "todo") return false;
  if (!parents || parents.length === 0) return false;
  return parents.some((p) => p.status !== "done" && p.status !== "archived");
}
