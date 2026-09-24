"use client";

import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, MessageSquare } from "lucide-react";

import { useLocale, useT } from "@/lib/i18n";
import type { KanbanTask, PluginTime } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";
import {
  cardProgress,
  directChildCount,
  isWaitingOnParents,
  OTHER_STATUS_GROUP_KEY,
  statusSegments,
  UNSET_GROUP_KEY,
  type GroupBy,
  type TaskGroup,
} from "@/lib/kanban-view-state";

import KanbanStatusBar from "./KanbanStatusBar";
import { assigneeLabel, progressLabel, warningBadge, type BoardNpc } from "./kanban-view-model";

export interface KanbanListViewProps {
  groups: readonly TaskGroup[];
  groupBy: GroupBy;
  npcs: readonly BoardNpc[];
  now: number;
  selectedTaskId: string | null;
  collapsedGroups: readonly string[];
  onToggleGroup: (key: string) => void;
  onOpen: (taskId: string) => void;
  /** Direct children of expanded cards. Absent means not yet fetched (D1(a) — detail is fetched only on expand). */
  childrenOf: ReadonlyMap<string, KanbanTask[]>;
  /** Parents of expanded cards. Used for the "waiting on parent" judgment. */
  parentsOf: ReadonlyMap<string, KanbanTask[]>;
  expanded: ReadonlySet<string>;
  loadingChildren: ReadonlySet<string>;
  onToggleExpand: (taskId: string) => void;
}

/** How many levels down a card is in the tree. Indentation depends only on this value. */
const INDENT_PX = 20;
const MAX_DEPTH = 6;

/**
 * List view — **the same data, presented differently** from the board.
 *
 * Rows have no move handle. In a list, dragging is ambiguous between reordering and changing
 * status, and the existing move convention presupposes "visible status columns." Status changes
 * happen only through the detail's action buttons (design D5).
 */
export default function KanbanListView({
  groups,
  groupBy,
  npcs,
  now,
  selectedTaskId,
  collapsedGroups,
  onToggleGroup,
  onOpen,
  childrenOf,
  parentsOf,
  expanded,
  loadingChildren,
  onToggleExpand,
}: KanbanListViewProps) {
  const t = useT();
  const collapsed = new Set(collapsedGroups);

  /**
   * Cards already rendered under an expanded parent are excluded from the top level — showing the
   * same card twice makes the count look wrong. If the parent is collapsed or not in this list,
   * the card stays at the top level (this keeps an orphaned child from disappearing).
   */
  const nested = new Set<string>();
  for (const taskId of expanded) {
    for (const child of childrenOf.get(taskId) ?? []) nested.add(child.id);
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-text-muted">
        {t("kanban.list.empty")}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-2 sm:p-4">
      <ul className="flex flex-col gap-4">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          const { segments, counted } = statusSegments(group.tasks);
          return (
            <li key={group.key}>
              <button
                type="button"
                onClick={() => onToggleGroup(group.key)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-raised"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} className="shrink-0 text-text-muted" />
                ) : (
                  <ChevronDown size={14} className="shrink-0 text-text-muted" />
                )}
                <span className="truncate text-sm font-semibold text-text">
                  {groupLabel(group, groupBy, npcs, t)}
                </span>
                <span className="shrink-0 text-xs text-text-muted">{group.tasks.length}</span>
                <span className="ml-auto hidden sm:block">
                  <KanbanStatusBar segments={segments} counted={counted} />
                </span>
              </button>

              {!isCollapsed && (
                <ul className="mt-1 flex flex-col divide-y divide-border-subtle">
                  {group.tasks
                    .filter((task) => !nested.has(task.id))
                    .map((task) => (
                      <Rows
                        key={task.id}
                        task={task}
                        depth={0}
                        npcs={npcs}
                        now={now}
                        selectedTaskId={selectedTaskId}
                        onOpen={onOpen}
                        childrenOf={childrenOf}
                        parentsOf={parentsOf}
                        expanded={expanded}
                        loadingChildren={loadingChildren}
                        onToggleExpand={onToggleExpand}
                      />
                    ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One card and, if expanded, its children below. Recursion stops at `MAX_DEPTH`. */
function Rows({
  task,
  depth,
  ...rest
}: {
  task: KanbanTask;
  depth: number;
} & Omit<KanbanListViewProps, "groups" | "groupBy" | "collapsedGroups" | "onToggleGroup">) {
  const children = rest.expanded.has(task.id) ? (rest.childrenOf.get(task.id) ?? []) : [];
  return (
    <>
      <Row task={task} depth={depth} {...rest} />
      {depth < MAX_DEPTH &&
        children.map((child) => <Rows key={child.id} task={child} depth={depth + 1} {...rest} />)}
    </>
  );
}

function Row({
  task,
  depth,
  npcs,
  now,
  selectedTaskId,
  onOpen,
  parentsOf,
  expanded,
  loadingChildren,
  onToggleExpand,
}: {
  task: KanbanTask;
  depth: number;
} & Omit<KanbanListViewProps, "groups" | "groupBy" | "collapsedGroups" | "onToggleGroup">) {
  const t = useT();
  const { locale } = useLocale();

  const childCount = directChildCount(task);
  const isExpanded = expanded.has(task.id);
  const isLoading = loadingChildren.has(task.id);
  const progress = cardProgress(task);
  const warning = warningBadge(task);
  const assignee = assigneeLabel(task.assignee, npcs);
  const waiting = isWaitingOnParents(task, parentsOf.get(task.id));

  return (
    <li className="flex items-center gap-1" style={{ paddingLeft: depth * INDENT_PX }}>
      {childCount > 0 ? (
        <button
          type="button"
          onClick={() => onToggleExpand(task.id)}
          aria-expanded={isExpanded}
          aria-label={t("kanban.list.subtasks", { count: childCount })}
          title={t("kanban.list.subtasks", { count: childCount })}
          className="shrink-0 rounded p-1 text-text-muted hover:bg-surface-raised hover:text-text"
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      ) : (
        <span className="w-[25px] shrink-0" aria-hidden="true" />
      )}

      <button
        type="button"
        onClick={() => onOpen(task.id)}
        aria-current={selectedTaskId === task.id ? "true" : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-raised ${
          selectedTaskId === task.id ? "bg-surface-raised" : ""
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-text">{task.title}</span>

        {waiting && (
          <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-secondary">
            {t("kanban.list.waitingOnParents")}
          </span>
        )}

        {childCount > 0 && (
          <span className="hidden shrink-0 items-center gap-0.5 text-[11px] text-text-muted sm:flex">
            <GitBranch size={11} aria-hidden="true" />
            {childCount}
            {isLoading && <span className="ml-0.5">…</span>}
          </span>
        )}

        {progress && (
          <span className="hidden shrink-0 text-[11px] text-text-muted sm:inline">
            {progressLabel(task)}
          </span>
        )}

        {task.comment_count ? (
          <span className="hidden shrink-0 items-center gap-0.5 text-[11px] text-text-muted sm:flex">
            <MessageSquare size={11} aria-hidden="true" />
            {task.comment_count}
          </span>
        ) : null}

        {warning && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[11px] text-danger"
            title={t("kanban.card.warnings", { count: warning.count })}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            {warning.count}
          </span>
        )}

        {assignee && (
          <span className="hidden w-20 shrink-0 truncate text-right text-[11px] text-text-secondary sm:inline">
            {assignee}
          </span>
        )}

        <span className="hidden w-16 shrink-0 text-right text-[11px] text-text-dim md:inline">
          {relativeTime(task.created_at, now, locale)}
        </span>
      </button>
    </li>
  );
}

function groupLabel(
  group: TaskGroup,
  groupBy: GroupBy,
  npcs: readonly BoardNpc[],
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (group.key === OTHER_STATUS_GROUP_KEY) return t("kanban.list.group.otherStatus");
  if (group.key === UNSET_GROUP_KEY) {
    // Status and "no grouping" never produce an empty value — only the three that actually can have wording.
    if (groupBy === "tenant") return t("kanban.list.group.unset.tenant");
    if (groupBy === "assignee") return t("kanban.list.group.unset.assignee");
    return t("kanban.list.group.unset.priority");
  }
  if (groupBy === "status") return t(`kanban.column.${group.key}`);
  if (groupBy === "assignee") return assigneeLabel(group.value, npcs) ?? group.key;
  if (groupBy === "none") return t("kanban.list.group.all");
  // Tenant is shown as the raw slug. A display name gets attached once a project meta table exists.
  return group.value ?? group.key;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/**
 * Builds a string like "2 days ago" via `Intl.RelativeTimeFormat`. This avoids writing out
 * wording per locale, and the platform handles singular/plural rules too.
 */
function relativeTime(value: PluginTime | undefined, now: number, locale: string): string {
  const at = taskTimeMs(value);
  if (at === null) return "";
  const diff = at - now;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return fmt.format(Math.round(diff / ms), unit);
  }
  return fmt.format(0, "minute");
}
