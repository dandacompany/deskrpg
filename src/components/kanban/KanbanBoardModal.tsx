"use client";

import { getLocalizedMessage } from "@/lib/i18n/error-codes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, KanbanSquare, Plus, RefreshCw, Settings, X } from "lucide-react";

import { useT } from "@/lib/i18n";
import { ProjectPicker, useSelectedBoard, type ProjectOption } from "./ProjectPicker";
import { ProjectTargetDate } from "./ProjectTargetDate";
import type {
  KanbanRunsPage,
  KanbanStatusTransitionsPage,
  KanbanTask,
  KanbanTaskStatus,
} from "@/lib/hermes/deskrpg-plugin-types";
import GateChecklistModal from "@/components/gateway/GateChecklistModal";
import { classifyGateFailure, isSetupBlocker, type GateBlocker } from "@/lib/gate-failure";

import BoardSettingsPanel from "./BoardSettingsPanel";
import KanbanColumn from "./KanbanColumn";
import KanbanListView from "./KanbanListView";
import KanbanMetricsPanel from "./KanbanMetricsPanel";
import KanbanTimeline from "./KanbanTimeline";
import KanbanViewToolbar from "./KanbanViewToolbar";
import SwarmDialog, { type SwarmSubmit } from "./SwarmDialog";
import TaskDrawer, { type TaskDrawerArtifacts } from "./TaskDrawer";
import TaskEditorDialog from "./TaskEditorDialog";
import { restoreKanbanMoveResultFocus, type KanbanMoveEvent } from "./kanban-card-move";
import { applyFilter, filterRunsByVisibleTasks, hasActiveFilter } from "@/lib/kanban-view-state";
import { useProjectViewState, useTaskGroups } from "./use-project-view-state";
import { presetWindow, type WindowPreset } from "@/lib/timeline-layout";
import { computeOperationalMetrics } from "@/lib/kanban-metrics";
import {
  createKanbanApi,
  toFailure,
  type AutomationStatus,
  type BoardResponse,
} from "./kanban-api";
import {
  activeAssigneeOptions,
  classifyBoardFailure,
  EMPTY_TASK_FORM,
  failureLine,
  flattenTasks,
  isRunning,
  npcIdForAssignee,
  hiddenCards,
  orderColumns,
  type BoardBlocker,
  type TaskFormValues,
} from "./kanban-view-model";
import { CopyCommand } from "../CopyCommand";

interface KanbanBoardModalProps {
  channelId: string;
  /** A draft brought in from a conversation. Not registered on the server until confirmed. */
  initialCreateDraft?: Pick<TaskFormValues, "title" | "body" | "assigneeNpcId">;
  onConnectGateway?: () => void;
  onClose: () => void;
  /** Bumps by 1 every time a `kanban:event` arrives (GamePageClient holds the socket). Debounced before refetching. */
  refreshTick?: number;
  /** Debounce (ms) from event to refetch. Defaults to `KANBAN_EVENT_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Opens this card's detail as soon as the modal opens — "open card" from a room notification (R29). Read only on mount. */
  initialTaskId?: string | null;
  /** The card drawer's artifacts section — passed through to `TaskDrawer` as-is. No section if absent. */
  artifacts?: TaskDrawerArtifacts | null;
  /** Count of channel `artifact:event`s — the drawer's artifacts section debounces and refetches on this. */
  artifactsRefreshTick?: number;
  /**
   * "Open this card" on an already-open board — artifacts' "go to source." The selection moves
   * every time `seq` changes (`initialTaskId` is only read on mount, so it never reaches an
   * already-open board).
   */
  focusRequest?: { taskId: string; seq: number } | null;
  /** Another modal (artifacts) is covering the board — Escape belongs to that modal, so the board doesn't close. */
  covered?: boolean;
}

/** Interval that folds a burst of `kanban:event`s into a single refetch. */
export const KANBAN_EVENT_DEBOUNCE_MS = 400;

type Editor =
  | { mode: "create"; draft?: Pick<TaskFormValues, "title" | "body" | "assigneeNpcId"> }
  | { mode: "edit"; task: KanbanTask };
type MoveState =
  | { phase: "idle" }
  | { phase: "active"; taskId: string; source: KanbanTaskStatus; target?: KanbanTaskStatus }
  | { phase: "pending"; taskId: string; title: string; target: KanbanTaskStatus }
  | { phase: "success"; taskId: string; title: string; status?: KanbanTaskStatus }
  | { phase: "unconfirmed"; taskId: string; title: string; target: KanbanTaskStatus }
  | {
      phase: "error";
      taskId: string;
      title: string;
      target: KanbanTaskStatus;
      code: string;
      message: string;
      /**
       * The board reload sequence current when the failure was shown. Any **later** applied reload
       * clears the banner — by then the board shows the server's truth, and a failure notice left
       * over from an earlier attempt reads as if the latest change failed.
       */
      shownAt: number;
    };
/**
 * `invalid_transition` is Hermes refusing the move for the card's current status — the raw code and
 * its English reason mean nothing to the person who dragged the card, so name the column instead.
 * Other failures keep the server's reason, which is usually the specific cause (e.g. permission).
 */
function moveFailureText(
  t: ReturnType<typeof useT>,
  move: { title: string; target: KanbanTaskStatus; code: string; message: string },
): string {
  if (move.code === "invalid_transition") {
    return t("kanban.move.invalidTransition", {
      title: move.title,
      column: t(`kanban.column.${move.target}`),
    });
  }
  return t("kanban.move.failed", { title: move.title, error: move.message });
}

type ReloadResult =
  { kind: "applied"; board: BoardResponse } | { kind: "superseded" } | { kind: "failed" };

function formFromTask(task: KanbanTask & Record<string, unknown>, npcs: BoardResponse["npcs"]) {
  const str = (key: string) => (typeof task[key] === "string" ? (task[key] as string) : "");
  const num = (key: string) => (typeof task[key] === "number" ? String(task[key]) : "");
  const kind = str("workspace_kind");
  return {
    ...EMPTY_TASK_FORM,
    reviewMode:
      task.review &&
      !task.started_at &&
      !task.review.submission &&
      ["todo", "ready", "blocked", "triage"].includes(task.status)
        ? task.review.policy.mode
        : undefined,
    reviewerNpcId: npcIdForAssignee(task.review?.policy.reviewer_profile, npcs) ?? "",
    reviewRevision: task.review?.policy_revision,
    title: task.title,
    body: task.body ?? "",
    assigneeNpcId: npcIdForAssignee(task.assignee, npcs) ?? "",
    priority: task.priority ?? "",
    workspaceKind: (kind === "scratch" || kind === "worktree" || kind === "dir"
      ? kind
      : "") as TaskFormValues["workspaceKind"],
    workspacePath: str("workspace_path"),
    skills: Array.isArray(task.skills) ? (task.skills as string[]).join(", ") : "",
    modelOverride: str("model_override"),
    providerOverride: str("provider_override"),
    reasoningEffort: str("reasoning_effort"),
    maxRuntimeSeconds: num("max_runtime_seconds"),
    goalMode: task.goal_mode === true,
    goalMaxTurns: num("goal_max_turns"),
  } satisfies TaskFormValues;
}

/**
 * The kanban board modal. Reads status (`automation/status`) and the board, rendering fixed-order
 * columns (R6). All mutations are sent by the drawer/edit form, and on success this refetches via
 * `reload` (R26). If the board can't be opened (428/409/503), a message is shown instead of the
 * columns (R31/R32/E6).
 */
export default function KanbanBoardModal({
  channelId,
  onClose,
  onConnectGateway,
  refreshTick = 0,
  debounceMs = KANBAN_EVENT_DEBOUNCE_MS,
  initialTaskId = null,
  initialCreateDraft,
  artifacts = null,
  artifactsRefreshTick = 0,
  focusRequest = null,
  covered = false,
}: KanbanBoardModalProps) {
  const t = useT();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [canManageProjects, setCanManageProjects] = useState(false);
  const [projectsTick, setProjectsTick] = useState(0);
  const { selected: selectedBoard, select: selectBoard } = useSelectedBoard(channelId, projects);
  // When the board changes, a new api is created, and the loading effect below refetches for that board.
  const api = useMemo(
    () => createKanbanApi(channelId, undefined, selectedBoard ?? undefined),
    [channelId, selectedBoard],
  );
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [boardChannelId, setBoardChannelId] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<BoardBlocker | null>(null);
  const [checklist, setChecklist] = useState<GateBlocker | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  const [editor, setEditor] = useState<Editor | null>(
    initialCreateDraft ? { mode: "create", draft: initialCreateDraft } : null,
  );
  const [editorError, setEditorError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [showSwarm, setShowSwarm] = useState(false);
  const [swarmSubmitting, setSwarmSubmitting] = useState(false);
  const [swarmError, setSwarmError] = useState<string | null>(null);
  const [boardWarning, setBoardWarning] = useState<string | null>(null);
  const [creationWarnings, setCreationWarnings] = useState<Record<string, string>>({});
  const [detailTick, setDetailTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [move, setMove] = useState<MoveState>({ phase: "idle" });
  const {
    state: viewState,
    update: updateView,
    setFilter: setViewFilter,
    toggleGroup: toggleViewGroup,
  } = useProjectViewState(channelId);
  const includeArchived = viewState.filter.includeArchived;
  /**
   * Whether bulk link lookup is available. The capability is the source of truth — judging by
   * version would make "new plugin but still 404" impossible to diagnose (same reason as the
   * swarm gate in `plugin-capability.ts`).
   */
  const viewsSupported = status?.capabilities?.includes("kanban_views") ?? false;
  /** Whether the plugin lists status transitions in bulk. Without it the rework metric is hidden. */
  const taskEventsSupported = status?.capabilities?.includes("kanban_task_events") ?? false;
  const [expandedTasks, setExpandedTasks] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingChildren, setLoadingChildren] = useState<ReadonlySet<string>>(() => new Set());
  /** Links for expanded cards. Holds only ids — the board response is always the source of truth for card content. */
  const [links, setLinks] = useState<
    ReadonlyMap<string, { parents: string[]; children: string[] }>
  >(() => new Map());
  const [timelinePreset, setTimelinePreset] = useState<WindowPreset>("today");
  const [runsPage, setRunsPage] = useState<KanbanRunsPage | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [transitionsPage, setTransitionsPage] = useState<KanbanStatusTransitionsPage | null>(null);
  const [boardLinks, setBoardLinks] = useState<readonly { parent_id: string; child_id: string }[]>(
    [],
  );
  const mounted = useRef(true);
  const reloadSequence = useRef(0);
  const latestReloadRef = useRef<Promise<ReloadResult> | null>(null);
  const moveRequestPending = useRef(false);
  const currentApi = useRef(api);
  const selectedTaskIdRef = useRef(selectedTaskId);
  const boardRootRef = useRef<HTMLDivElement>(null);
  const activeMoveRef = useRef<{
    taskId: string;
    source: KanbanTaskStatus;
    target?: KanbanTaskStatus;
  } | null>(null);
  currentApi.current = api;
  selectedTaskIdRef.current = selectedTaskId;
  const getBoardRoot = useCallback(() => boardRootRef.current, []);

  // Move focus to the new card's DOM after the server's source of truth is reflected on screen.
  useEffect(() => {
    if (move.phase === "success") {
      restoreKanbanMoveResultFocus(boardRootRef.current, move.taskId);
    }
  }, [move]);

  // "Go to source" — moves the drawer to the requested card even on an already-open board (board state is left as-is).
  const focusSeq = focusRequest?.seq ?? null;
  const focusTaskId = focusRequest?.taskId ?? null;
  useEffect(() => {
    if (focusSeq !== null && focusTaskId) setSelectedTaskId(focusTaskId);
  }, [focusSeq, focusTaskId]);

  useEffect(() => {
    mounted.current = true;
    setMove({ phase: "idle" });
    activeMoveRef.current = null;
    return () => {
      mounted.current = false;
      moveRequestPending.current = false;
      reloadSequence.current += 1;
    };
  }, [channelId]);

  // The project list depends only on the channel — tying it to `api` would refetch every time a
  // board is chosen, and that result touching the selection again would create a loop. Failures
  // are silently ignored: in a channel with only one board the picker wouldn't render anyway, and
  // a missing list is no reason to block kanban.
  useEffect(() => {
    let alive = true;
    const listApi = createKanbanApi(channelId);
    void listApi
      .projects()
      .then((data) => {
        // If the shape doesn't match expectations, treat it as an empty list — kanban must not stall over a single picker.
        if (!alive) return;
        setProjects(Array.isArray(data?.projects) ? data.projects : []);
        setCanManageProjects(data?.canManage === true);
      })
      .catch(() => {
        if (alive) setProjects([]);
      });
    return () => {
      alive = false;
    };
  }, [channelId, projectsTick]);

  // Failures are thrown back to the picker, which explains them next to the button.
  const archiveProject = useCallback(
    async (projectId: string) => {
      await createKanbanApi(channelId).archiveProject(projectId);
      selectBoard(null);
      setProjectsTick((n) => n + 1);
    },
    [channelId, selectBoard],
  );
  const saveTargetDate = useCallback(
    async (projectId: string, date: string | null) => {
      await createKanbanApi(channelId).setProjectTargetDate(projectId, date);
      setProjectsTick((n) => n + 1);
    },
    [channelId],
  );
  const reopenProject = useCallback(
    async (projectId: string) => {
      await createKanbanApi(channelId).reopenProject(projectId);
      setProjectsTick((n) => n + 1);
    },
    [channelId],
  );

  const reload = useCallback((): Promise<ReloadResult> => {
    const sequence = ++reloadSequence.current;
    const current = () => mounted.current && sequence === reloadSequence.current;
    const operation = (async (): Promise<ReloadResult> => {
      let nextStatus: AutomationStatus | null = null;
      try {
        nextStatus = await api.status();
        if (current()) setStatus(nextStatus);
      } catch (err) {
        const failure = toFailure(err);
        if (failure.code === "gateway_not_bound") {
          if (!current()) return { kind: "superseded" };
          setBlocker({ kind: "gateway_not_bound" });
          setBoard(null);
          setBoardChannelId(null);
          setLoading(false);
          return { kind: "failed" };
        }
        // The board can still open without a status summary — only the warning badge is left empty.
        if (current()) setStatus(null);
      }
      try {
        const data = await api.board(includeArchived);
        if (!current()) return { kind: "superseded" };
        setBoard(data);
        setMove((move) =>
          move.phase === "error" && sequence > move.shownAt ? { phase: "idle" } : move,
        );
        setBoardChannelId(channelId);
        setBlocker(null);
        // A checklist opened for the old failure would otherwise keep saying what is missing.
        setChecklist(null);
        return { kind: "applied", board: data };
      } catch (err) {
        if (!current()) return { kind: "superseded" };
        setBlocker(classifyBoardFailure(toFailure(err), nextStatus?.minVersion));
        return { kind: "failed" };
      } finally {
        if (current()) setLoading(false);
      }
    })();
    latestReloadRef.current = operation;
    return operation;
  }, [api, channelId, includeArchived]);

  const reconcileReload = useCallback(
    async (result: ReloadResult): Promise<ReloadResult> => {
      if (result.kind !== "superseded") return result;
      const latest = latestReloadRef.current;
      const next = latest ? await latest : result;
      return next.kind === "superseded" ? reload() : next;
    },
    [reload],
  );

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  // `kanban:event` — refetch the board/detail after debouncing (R26).
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (refreshTick === 0) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      debounce.current = null;
      void reload();
      setDetailTick((n) => n + 1);
    }, debounceMs);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [refreshTick, debounceMs, reload]);

  const currentBoard = boardChannelId === channelId ? board : null;
  const columns = useMemo(
    () => orderColumns(currentBoard?.columns, includeArchived),
    [currentBoard, includeArchived],
  );
  const hidden = useMemo(() => hiddenCards(currentBoard?.columns), [currentBoard]);
  const allTasks = useMemo(() => flattenTasks(columns), [columns]);
  const listGroups = useTaskGroups(allTasks, viewState, {
    tenants: currentBoard?.tenants,
    assignees: currentBoard?.assignees,
  });

  /**
   * Applies **the same filter as the list** to the board columns.
   *
   * If the filter only applied to the list, the same board's two views would show different card
   * counts. Choosing a subproject while the board stays the same is a silent failure — the screen
   * says "1 filter" while doing nothing.
   *
   * The nine columns themselves are kept as-is; only cards are removed. Removing empty columns
   * would make the status set vary with the filter, and never inventing or removing columns is
   * this screen's rule.
   */
  const visibleColumns = useMemo(
    () =>
      columns.map((column) => ({ ...column, tasks: applyFilter(column.tasks, viewState.filter) })),
    [columns, viewState.filter],
  );

  /**
   * Expands the tree one level — only an expanded card has its detail fetched (design D1(a)).
   *
   * The board response gives no links, only `link_counts`. Pre-fetching the whole tree would need
   * one call per card, so only the branch the user actually opens gets loaded. The links received
   * are held only as ids, and card content is looked up from the board response — keeping a copy
   * would leave a stale title behind after a refetch.
   */
  const toggleExpand = useCallback(
    (taskId: string) => {
      setExpandedTasks((prev) => {
        const next = new Set(prev);
        if (next.has(taskId)) {
          next.delete(taskId);
          return next;
        }
        next.add(taskId);
        return next;
      });
      if (links.has(taskId)) return;
      setLoadingChildren((prev) => new Set(prev).add(taskId));
      void api
        .taskDetail(taskId)
        .then((detail) => {
          setLinks((prev) => new Map(prev).set(taskId, detail.links));
        })
        .catch(() => {
          // If the links can't be fetched, the branch just looks empty. Since card content is
          // already in the list, this doesn't block the screen and is retried on the next expand
          // (nothing was cached).
        })
        .finally(() => {
          setLoadingChildren((prev) => {
            const next = new Set(prev);
            next.delete(taskId);
            return next;
          });
        });
    },
    [api, links],
  );

  /**
   * The timeline window. **`Date.now()` is not re-read on every render** — doing so would cause
   * the bars to keep jittering slightly and break `useMemo` every time. It's re-captured only when
   * the view is opened or the period is changed.
   */
  const timelineWindow = useMemo(
    () => presetWindow(timelinePreset, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keeping the window fixed means using only the time it was opened.
    [timelinePreset, viewState.viewMode],
  );

  useEffect(() => {
    if (viewState.viewMode !== "timeline" || !viewsSupported || blocker) return;
    let alive = true;
    setRunsLoading(true);
    setRunsError(null);
    void api
      .runs({
        from: Math.floor(timelineWindow.fromMs / 1000),
        to: Math.ceil(timelineWindow.toMs / 1000),
      })
      .then((page) => {
        if (alive) setRunsPage(page);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // A failure is not papered over by an empty timeline — "nobody has worked" and "can't be asked" are different things.
        setRunsPage(null);
        setRunsError(toFailure(err).message);
      })
      .finally(() => {
        if (alive) setRunsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, blocker, timelineWindow, viewState.viewMode, viewsSupported, detailTick]);

  // Status transitions for the rework metric, over the same window as the runs. A failure leaves the
  // page null so the metric is hidden — it never reads as "nothing was sent back".
  useEffect(() => {
    if (viewState.viewMode !== "timeline" || !taskEventsSupported || blocker) return;
    let alive = true;
    setTransitionsPage(null);
    void api
      .statusTransitions({
        from: Math.floor(timelineWindow.fromMs / 1000),
        to: Math.ceil(timelineWindow.toMs / 1000),
      })
      .then((page) => {
        if (alive) setTransitionsPage(page);
      })
      .catch(() => {
        if (alive) setTransitionsPage(null);
      });
    return () => {
      alive = false;
    };
  }, [api, blocker, timelineWindow, viewState.viewMode, taskEventsSupported, detailTick]);

  /**
   * The run history the timeline and metrics see. When a filter is active, keeps **only the ones
   * for visible cards** — a filter that applies to the board/list but not the timeline is a silent
   * failure (this happened once on the board).
   *
   * With no filter, nothing is dropped. Runs for a deleted card still remain in the history (the
   * plugin keeps them deliberately), and intersecting them out would make those disappear.
   */
  const visibleRuns = useMemo(() => {
    const runs = runsPage?.runs ?? [];
    if (!hasActiveFilter(viewState.filter)) return runs;
    const ids = new Set(applyFilter(allTasks, viewState.filter).map((task) => task.id));
    return filterRunsByVisibleTasks(runs, ids);
  }, [runsPage, allTasks, viewState.filter]);

  /** Transitions for the rework metric, narrowed by the same filter as the runs. null = unknown. */
  const visibleTransitions = useMemo(() => {
    if (!taskEventsSupported || !transitionsPage) return null;
    if (!hasActiveFilter(viewState.filter)) return transitionsPage.events;
    const ids = new Set(applyFilter(allTasks, viewState.filter).map((task) => task.id));
    return filterRunsByVisibleTasks(transitionsPage.events, ids);
  }, [taskEventsSupported, transitionsPage, allTasks, viewState.filter]);

  /**
   * Operational metrics. Computed from **the same run history and the same window** as the
   * timeline — if the two views state different numbers, both lose trust.
   *
   * The set of cards awaiting approval is still empty. Once the approval gate (dev2) lands, that
   * set gets passed through. Until then, every `blocked` reads as an error block, which is the
   * choice that errs on the safe side — better than requiring approval twice.
   */
  /**
   * The target date of the project this board belongs to. Matched by `boardSlug` — a channel can
   * have multiple boards, and one project has one board.
   *
   * The channel owner sets it next to the project picker; until then **having no value is the
   * default**. In that case the timeline draws no vertical line and just writes "target date
   * unset" — a nonexistent deadline is never drawn in.
   */
  const openProject = useMemo(() => {
    // The picker's choice wins. `status` is channel-wide and always names the default
    // (event-carrier) board, so it is only the fallback when nothing is chosen.
    const slug = selectedBoard ?? status?.boardSlug;
    if (!slug) return null;
    return projects.find((project) => project.boardSlug === slug) ?? null;
  }, [projects, selectedBoard, status?.boardSlug]);
  const targetDate = openProject?.targetDate ?? null;

  const metrics = useMemo(
    () =>
      computeOperationalMetrics(
        visibleRuns,
        allTasks,
        PENDING_APPROVALS_UNAVAILABLE,
        timelineWindow,
        visibleTransitions,
      ),
    [visibleRuns, allTasks, timelineWindow, visibleTransitions],
  );

  useEffect(() => {
    if (viewState.viewMode !== "timeline" || !viewsSupported || blocker) return;
    let alive = true;
    void api
      .links()
      .then((page) => {
        if (alive) setBoardLinks(page.links);
      })
      .catch(() => {
        // If the links can't be fetched, only the arrows are missing. The bars still render, so this doesn't block the screen.
        if (alive) setBoardLinks([]);
      });
    return () => {
      alive = false;
    };
  }, [api, blocker, viewState.viewMode, viewsSupported, detailTick]);

  const byId = useMemo(() => new Map(allTasks.map((task) => [task.id, task])), [allTasks]);
  const childrenOf = useMemo(() => resolveLinks(links, byId, "children"), [links, byId]);
  const parentsOf = useMemo(() => resolveLinks(links, byId, "parents"), [links, byId]);
  const npcs = useMemo(() => currentBoard?.npcs ?? [], [currentBoard]);
  // Swarm workers are chosen only from NPCs who are active (checked in) — the server rejects sleeping NPCs with 400.
  const npcOptions = useMemo(() => activeAssigneeOptions(npcs), [npcs]);
  // If the plugin can't do swarm, the button is hidden entirely — better than clicking it and seeing a 428.
  const reviewSupported = status?.capabilities?.includes("kanban_review_policy_v1") ?? false;
  // Upstream Hermes has no approval-policy contract: cards and swarms are still created (Hermes' own
  // behaviour), and the board says their results complete without approval.
  const swarmSupported = status?.capabilities?.includes("swarm") ?? false;
  const swarmApproval =
    reviewSupported && (status?.capabilities?.includes("swarm_review_policy") ?? false);
  const anyRunning = allTasks.some(isRunning);
  const movePending = move.phase === "pending";
  const moveBlocked =
    movePending ||
    loading ||
    Boolean(editor) ||
    showSettings ||
    showSwarm ||
    Boolean(blocker) ||
    !currentBoard;

  const handleMoveInteraction = useCallback(
    (event: KanbanMoveEvent) => {
      if (event.type === "start") {
        const task = allTasks.find((candidate) => candidate.id === event.taskId);
        if (moveBlocked || activeMoveRef.current || !task || task.status !== event.source) return;
        activeMoveRef.current = { taskId: event.taskId, source: event.source };
        setMove({ phase: "active", taskId: event.taskId, source: event.source });
        return;
      }
      if (event.type === "target") {
        const active = activeMoveRef.current;
        if (!active || active.taskId !== event.taskId || active.source !== event.source) return;
        active.target = event.target;
        setMove((current) =>
          current.phase === "active" && current.taskId === event.taskId
            ? { ...current, target: event.target }
            : current,
        );
        return;
      }
      if (event.type === "cancel") {
        const active = activeMoveRef.current;
        if (!active || active.taskId !== event.taskId || active.source !== event.source) return;
        activeMoveRef.current = null;
        setMove((current) =>
          current.phase === "active" && current.taskId === event.taskId
            ? { phase: "idle" }
            : current,
        );
        return;
      }
      if (moveBlocked || moveRequestPending.current) return;
      const active = activeMoveRef.current;
      if (
        !active ||
        active.taskId !== event.taskId ||
        active.source !== event.source ||
        active.target !== event.target
      )
        return;
      const task = allTasks.find((candidate) => candidate.id === event.taskId);
      const targetVisible = Array.from(
        boardRootRef.current?.querySelectorAll<HTMLElement>("[data-column]") ?? [],
      ).some(
        (column) =>
          column.dataset.column === event.target &&
          !column.closest("[hidden]") &&
          column.getAttribute("aria-hidden") !== "true",
      );
      if (
        !task ||
        task.status !== event.source ||
        event.source === event.target ||
        !targetVisible
      ) {
        setMove({ phase: "idle" });
        activeMoveRef.current = null;
        return;
      }

      const request = { taskId: task.id, title: task.title, target: event.target };
      activeMoveRef.current = null;
      moveRequestPending.current = true;
      setMove({ phase: "pending", ...request });
      void (async () => {
        try {
          await api.updateTask(task.id, { status: event.target });
        } catch (err) {
          moveRequestPending.current = false;
          if (!mounted.current || currentApi.current !== api) return;
          const failure = toFailure(err);
          // Reload first, then show the failure: the reload that belongs to this failure must not
          // be the one that clears it.
          await reconcileReload(await reload());
          if (!mounted.current || currentApi.current !== api) return;
          setMove({
            phase: "error",
            ...request,
            code: failure.code,
            message: failureLine(failure),
            shownAt: reloadSequence.current,
          });
          return;
        }
        if (!mounted.current || currentApi.current !== api) return;
        const reloadResult = await reconcileReload(await reload());
        moveRequestPending.current = false;
        if (!mounted.current || currentApi.current !== api) return;
        if (selectedTaskIdRef.current === task.id) setDetailTick((value) => value + 1);
        if (reloadResult.kind !== "applied") {
          setMove({ phase: "unconfirmed", ...request });
          return;
        }
        const authoritativeBoard = reloadResult.board;
        const authoritativeTask = flattenTasks(
          orderColumns(authoritativeBoard.columns, includeArchived),
        ).find((candidate) => candidate.id === task.id);
        setMove({
          phase: "success",
          taskId: request.taskId,
          title: request.title,
          status: authoritativeTask?.status,
        });
      })();
    },
    [allTasks, api, includeArchived, moveBlocked, reconcileReload, reload],
  );

  const retryMoveRead = useCallback(async () => {
    if (move.phase !== "unconfirmed") return;
    const request = move;
    const reloadResult = await reconcileReload(await reload());
    if (!mounted.current) return;
    if (reloadResult.kind === "applied") {
      const authoritativeBoard = reloadResult.board;
      if (selectedTaskIdRef.current === request.taskId) setDetailTick((value) => value + 1);
      const authoritativeTask = flattenTasks(
        orderColumns(authoritativeBoard.columns, includeArchived),
      ).find((candidate) => candidate.id === request.taskId);
      setMove({
        phase: "success",
        taskId: request.taskId,
        title: request.title,
        status: authoritativeTask?.status,
      });
    }
  }, [includeArchived, move, reconcileReload, reload]);

  // Only run a 1-second clock when there's a running card (for the elapsed time display).
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !covered && !editor && !showSettings && !showSwarm) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, covered, editor, showSettings, showSwarm]);

  const openEditor = (next: Editor) => {
    setEditorError(null);
    setEditor(next);
  };

  const handleEditorSubmit = async (body: Record<string, unknown>) => {
    if (!editor) return;
    setSubmitting(true);
    setEditorError(null);
    try {
      if (editor.mode === "create") {
        const res = await api.createTask(body);
        if (res.warning) {
          setBoardWarning(res.warning);
          setCreationWarnings((prev) => ({ ...prev, [res.task.id]: res.warning as string }));
        }
        setSelectedTaskId(res.task.id);
      } else {
        await api.updateTask(editor.task.id, body);
        setDetailTick((n) => n + 1);
      }
      setEditor(null);
      await reload();
    } catch (err) {
      // The server's 400 message as-is (R8).
      setEditorError(failureLine(toFailure(err)));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDispatch = async () => {
    setDispatching(true);
    try {
      await api.dispatch();
      await reload();
    } catch (err) {
      setBoardWarning(failureLine(toFailure(err)));
    } finally {
      setDispatching(false);
    }
  };

  const handleSwarm = async (values: SwarmSubmit) => {
    setSwarmSubmitting(true);
    setSwarmError(null); // A new submit clears the previous error.
    try {
      const created = await api.createSwarm(values);
      setShowSwarm(false);
      await reload();
      setSelectedTaskId(created.root_id); // Open the root card — that's where the blackboard is.
    } catch (err) {
      const failure = toFailure(err);
      // `SwarmDialog` covers the board banner with `fixed inset-0`, so the error must be shown
      // inside the dialog for the user to see it (boardWarning alone won't be visible).
      const line =
        failure.code === "plugin_upgrade_required"
          ? t("kanban.swarm.unsupported")
          : failureLine(failure);
      setSwarmError(line);
      setBoardWarning(line);
    } finally {
      setSwarmSubmitting(false);
    }
  };

  const banners: Array<{ key: string; text: string; tone: "warn" | "error" }> = [];
  if (status && status.dispatcherPresent === false) {
    banners.push({ key: "dispatcher", text: t("kanban.warning.noDispatcher"), tone: "warn" });
  }
  if (status?.lastError) {
    banners.push({
      key: "lastError",
      text: t("kanban.warning.lastError", { error: getLocalizedMessage(t, status.lastError) }),
      tone: "error",
    });
  }
  if (hidden.count > 0) {
    banners.push({
      key: "hiddenCards",
      text: t("kanban.warning.hiddenCards", {
        count: hidden.count,
        statuses: hidden.statuses.join(", "),
      }),
      tone: "warn",
    });
  }
  if (boardWarning) banners.push({ key: "board", text: boardWarning, tone: "warn" });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kanban-modal-title"
        className="bg-bg border border-border rounded-xl shadow-2xl w-[96vw] max-w-[1400px] h-[88dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border flex-shrink-0">
          <h2 id="kanban-modal-title" className="text-sm font-bold flex items-center gap-1.5">
            <KanbanSquare className="w-4 h-4" />
            {t("kanban.title")}
            {status?.pluginVersion && (
              <span className="text-[10px] font-normal text-text-dim">v{status.pluginVersion}</span>
            )}
          </h2>
          <div className="flex items-center gap-1.5 text-xs">
            <ProjectPicker
              options={projects}
              selected={selectedBoard}
              onSelect={selectBoard}
              canManage={canManageProjects}
              onArchive={archiveProject}
              onReopen={reopenProject}
            />
            <ProjectTargetDate
              project={openProject}
              canManage={canManageProjects}
              onSave={saveTargetDate}
            />
            <button
              type="button"
              onClick={() => openEditor({ mode: "create" })}
              disabled={!currentBoard}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary hover:bg-primary-hover text-white font-semibold disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("kanban.newTask")}
            </button>
            {swarmSupported ? (
              <button
                type="button"
                onClick={() => {
                  setSwarmError(null);
                  setShowSwarm(true);
                }}
                disabled={!currentBoard || npcOptions.length === 0}
                className="px-2.5 py-1 rounded-md bg-surface-raised text-text-secondary hover:brightness-125 disabled:opacity-50"
              >
                {t("kanban.swarm")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleDispatch()}
              disabled={!currentBoard || dispatching}
              className="px-2.5 py-1 rounded-md bg-surface-raised text-text-secondary hover:brightness-125 disabled:opacity-50"
            >
              {t("kanban.dispatch")}
            </button>
            <button
              type="button"
              onClick={() => void reload()}
              aria-label={t("kanban.refresh")}
              title={t("kanban.refresh")}
              className="p-1.5 rounded-md bg-surface-raised text-text-secondary hover:brightness-125"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              disabled={!currentBoard}
              aria-label={t("kanban.settings.title")}
              title={t("kanban.settings.title")}
              className="p-1.5 rounded-md bg-surface-raised text-text-secondary hover:brightness-125 disabled:opacity-50"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="ml-1 text-text-muted hover:text-text"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Banners (R9·E6) */}
        {banners.length > 0 && (
          <div className="flex flex-col gap-1 px-5 py-2 border-b border-border text-xs">
            {banners.map((banner) => (
              <div
                key={banner.key}
                data-banner={banner.key}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 ${
                  banner.tone === "error" ? "bg-danger-bg text-danger" : "bg-npc/10 text-npc-dark"
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="break-words">{banner.text}</span>
                {banner.key === "board" && (
                  <button
                    type="button"
                    onClick={() => setBoardWarning(null)}
                    aria-label={t("common.close")}
                    className="ml-auto"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        {move.phase === "pending" ||
        move.phase === "success" ||
        move.phase === "unconfirmed" ||
        move.phase === "error" ? (
          <div
            data-move-status={move.phase}
            role={move.phase === "error" ? "alert" : "status"}
            aria-live={move.phase === "error" ? "assertive" : "polite"}
            className="border-b border-border px-5 py-2 text-xs text-text-secondary"
          >
            {move.phase === "pending"
              ? t("kanban.move.pending", {
                  title: move.title,
                  column: t(`kanban.column.${move.target}`),
                })
              : move.phase === "success" && move.status
                ? t("kanban.move.success", {
                    title: move.title,
                    column: t(`kanban.column.${move.status}`),
                  })
                : move.phase === "success"
                  ? t("kanban.move.reconciled", { title: move.title })
                  : move.phase === "unconfirmed"
                    ? t("kanban.move.unconfirmed", { title: move.title })
                    : moveFailureText(t, move)}
            {move.phase === "unconfirmed" ? (
              <button type="button" className="ml-2 underline" onClick={() => void retryMoveRead()}>
                {t("kanban.move.retryRead")}
              </button>
            ) : null}
          </div>
        ) : null}
        {!blocker && (
          <KanbanViewToolbar
            state={viewState}
            tenants={currentBoard?.tenants ?? []}
            assignees={currentBoard?.assignees ?? []}
            onUpdate={updateView}
            onFilter={setViewFilter}
            timelineSupported={viewsSupported}
          />
        )}
        <div className="flex flex-1 overflow-hidden">
          <div
            ref={boardRootRef}
            data-kanban-board-root
            tabIndex={-1}
            className={
              viewState.viewMode === "list"
                ? "flex flex-1 flex-col overflow-hidden"
                : "flex-1 overflow-x-auto overflow-y-hidden p-4"
            }
          >
            {loading && !currentBoard && !blocker ? (
              <div className="text-xs text-text-dim">{t("common.loading")}</div>
            ) : blocker ? (
              <Blocker
                blocker={blocker}
                onRetry={() => void reload()}
                onConnectGateway={onConnectGateway}
                onOpenChecklist={() => setChecklist(gateBlockerFromBoard(blocker))}
              />
            ) : viewState.viewMode === "timeline" ? (
              <>
                <KanbanTimeline
                  runs={visibleRuns}
                  window={timelineWindow}
                  preset={timelinePreset}
                  onPresetChange={setTimelinePreset}
                  now={now}
                  truncated={runsPage?.truncated ?? false}
                  loading={runsLoading}
                  error={runsError}
                  onOpenTask={setSelectedTaskId}
                  header={<KanbanMetricsPanel metrics={metrics} />}
                  targetDate={targetDate}
                  links={boardLinks}
                />
              </>
            ) : viewState.viewMode === "list" ? (
              <KanbanListView
                groups={listGroups}
                groupBy={viewState.groupBy}
                npcs={npcs}
                now={now}
                selectedTaskId={selectedTaskId}
                collapsedGroups={viewState.collapsedGroups}
                onToggleGroup={toggleViewGroup}
                onOpen={setSelectedTaskId}
                childrenOf={childrenOf}
                parentsOf={parentsOf}
                expanded={expandedTasks}
                loadingChildren={loadingChildren}
                onToggleExpand={toggleExpand}
              />
            ) : (
              <div className="flex h-full gap-3">
                {visibleColumns.map((column) => (
                  <KanbanColumn
                    key={column.name}
                    name={column.name}
                    tasks={column.tasks}
                    npcs={npcs}
                    now={now}
                    selectedTaskId={selectedTaskId}
                    onOpen={setSelectedTaskId}
                    moveDisabled={moveBlocked}
                    activeMoveTaskId={move.phase === "active" ? move.taskId : null}
                    getMoveRoot={getBoardRoot}
                    onMoveInteraction={handleMoveInteraction}
                  />
                ))}
              </div>
            )}
          </div>

          {selectedTaskId && currentBoard && !blocker && (
            <TaskDrawer
              key={selectedTaskId}
              api={api}
              taskId={selectedTaskId}
              npcs={npcs}
              boardTasks={allTasks}
              attachmentsSupported={status?.attachments !== false}
              creationWarning={creationWarnings[selectedTaskId] ?? null}
              refreshTick={detailTick}
              onChanged={() => void reload()}
              onEdit={(task) => openEditor({ mode: "edit", task })}
              onDeleted={() => setSelectedTaskId(null)}
              onClose={() => setSelectedTaskId(null)}
              artifacts={artifacts}
              artifactsRefreshTick={artifactsRefreshTick}
            />
          )}
        </div>
      </div>

      {currentBoard && !reviewSupported && (
        <p data-no-approval-notice role="status" className="px-5 py-2 text-xs text-npc-dark">
          {t("kanban.review.noApproval")}
        </p>
      )}
      {editor && currentBoard && !blocker && (
        <TaskEditorDialog
          mode={editor.mode}
          reviewSupported={reviewSupported}
          assigneeLocked={
            editor.mode === "edit" && !!editor.task.review && !!editor.task.started_at
          }
          confirmChatDraft={editor.mode === "create" && !!editor.draft}
          initial={
            editor.mode === "edit"
              ? formFromTask(editor.task as KanbanTask & Record<string, unknown>, npcs)
              : {
                  ...EMPTY_TASK_FORM,
                  // No approval picker where the gateway can't enforce one — sending a policy would be refused.
                  ...(reviewSupported ? {} : { reviewMode: undefined }),
                  ...editor.draft,
                  assigneeNpcId: npcs.some(
                    (npc) => npc.active && npc.npcId === editor.draft?.assigneeNpcId,
                  )
                    ? editor.draft!.assigneeNpcId
                    : "",
                }
          }
          npcs={npcs}
          candidates={
            editor.mode === "edit"
              ? allTasks.filter((task) => task.id !== editor.task.id)
              : allTasks
          }
          serverError={editorError}
          submitting={submitting}
          onSubmit={(body) => void handleEditorSubmit(body)}
          onClose={() => setEditor(null)}
        />
      )}

      {showSettings && <BoardSettingsPanel api={api} onClose={() => setShowSettings(false)} />}

      {showSwarm ? (
        <SwarmDialog
          npcs={npcOptions}
          withoutApproval={!swarmApproval}
          submitting={swarmSubmitting}
          error={swarmError}
          onSubmit={(values) => void handleSwarm(values)}
          onClose={() => setShowSwarm(false)}
        />
      ) : null}

      <GateChecklistModal blocker={checklist} onClose={() => setChecklist(null)} />
    </div>
  );
}

/** Moves the failure held by the board banner into the shape the checklist knows. Never re-judges — */
/** it just runs `board_unavailable`'s code/message back through `classifyGateFailure`. */
/**
 * Turns a link id into a card from the board response.
 *
 * A card not currently visible (a parent/child while the archive is collapsed) is dropped from
 * the result — a missing card is never invented just to draw it. A child that loses its parent
 * this way stays at the root in the list.
 */
function resolveLinks(
  links: ReadonlyMap<string, { parents: string[]; children: string[] }>,
  byId: ReadonlyMap<string, KanbanTask>,
  side: "parents" | "children",
): Map<string, KanbanTask[]> {
  const out = new Map<string, KanbanTask[]>();
  for (const [taskId, link] of links) {
    const resolved = link[side]
      .map((id) => byId.get(id))
      .filter((task): task is KanbanTask => task !== undefined);
    if (resolved.length > 0) out.set(taskId, resolved);
  }
  return out;
}

/**
 * An empty set until the approval gate lands. Once dev2's `approval_targets` lookup is in place,
 * this gets swapped for that result. While empty, `blocked` reads as an error block — the choice
 * that avoids asking the same decision twice.
 */
const PENDING_APPROVALS_UNAVAILABLE: ReadonlySet<string> = new Set();

function gateBlockerFromBoard(blocker: BoardBlocker): GateBlocker | null {
  if (blocker.kind === "gateway_not_bound") return { kind: "gateway_not_bound" };
  if (blocker.kind === "upgrade_required") {
    return {
      kind: "plugin_upgrade_required",
      minVersion: blocker.minVersion,
      command: blocker.command,
    };
  }
  if (blocker.kind === "board_unavailable") {
    return classifyGateFailure({ status: 503, code: blocker.code, message: blocker.reason });
  }
  return classifyGateFailure({
    status: blocker.status,
    code: blocker.code,
    message: blocker.message,
  });
}

function Blocker({
  blocker,
  onRetry,
  onConnectGateway,
  onOpenChecklist,
}: {
  blocker: BoardBlocker;
  onRetry: () => void;
  onConnectGateway?: () => void;
  onOpenChecklist: () => void;
}) {
  const t = useT();
  const gateBlocker = gateBlockerFromBoard(blocker);
  const title =
    blocker.kind === "upgrade_required"
      ? t("kanban.blocker.upgradeTitle")
      : blocker.kind === "gateway_not_bound"
        ? t("kanban.blocker.gatewayTitle")
        : blocker.kind === "board_unavailable"
          ? t("kanban.blocker.boardTitle")
          : t("kanban.blocker.errorTitle");
  return (
    <div
      data-blocker={blocker.kind}
      className="mx-auto mt-8 max-w-[560px] rounded-xl border border-border bg-surface p-5 text-xs"
    >
      <div className="text-sm font-bold text-text mb-2 flex items-center gap-1.5">
        <AlertTriangle className="w-4 h-4 text-npc-dark" />
        {title}
      </div>
      {blocker.kind === "upgrade_required" && (
        <>
          <p className="text-text-secondary mb-2">
            {t("kanban.blocker.upgradeBody", { minVersion: blocker.minVersion })}
          </p>
          <CopyCommand command={blocker.command} />
        </>
      )}
      {blocker.kind === "gateway_not_bound" && (
        <p className="text-text-secondary">
          {t(onConnectGateway ? "kanban.blocker.gatewayBody" : "kanban.blocker.gatewayAskOwner")}
        </p>
      )}
      {blocker.kind === "board_unavailable" && (
        <p className="text-text-secondary break-words">
          {failureLine({ code: blocker.code, message: blocker.reason })}
        </p>
      )}
      {blocker.kind === "other" && (
        <p className="text-text-secondary break-words">
          {blocker.status ? `${blocker.status} · ` : ""}
          {failureLine(blocker)}
        </p>
      )}
      {(blocker.kind !== "gateway_not_bound" || onConnectGateway) && (
        <>
          <button
            type="button"
            onClick={blocker.kind === "gateway_not_bound" ? onConnectGateway : onRetry}
            className="mt-3 px-3 py-1.5 rounded-lg bg-surface-raised text-text-secondary hover:brightness-125"
          >
            {t(
              blocker.kind === "gateway_not_bound"
                ? "kanban.blocker.connectGateway"
                : "common.retry",
            )}
          </button>
          {gateBlocker && isSetupBlocker(gateBlocker) && (
            <button type="button" onClick={onOpenChecklist} className="ml-2 underline">
              {t("gateChecklist.whatIsNeeded")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
