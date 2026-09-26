"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, GitBranch, GripVertical, MessageSquare, Play } from "lucide-react";

import { isSwarmStructureCard } from "@/lib/swarm-structure";
import { useT } from "@/lib/i18n";
import type { KanbanTask, KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";

import KanbanDragPreview, { type KanbanDragPreviewState } from "./KanbanDragPreview";
import {
  assigneeLabel,
  elapsedSeconds,
  formatElapsed,
  isRunning,
  progressLabel,
  warningBadge,
  type BoardNpc,
} from "./kanban-view-model";
import {
  clearLockedColumns,
  clearMoveTargets,
  autoScrollKanbanBoard,
  columnStatus,
  directMoveColumns,
  isKanbanDirectMoveTarget,
  markLockedColumns,
  markMoveTarget,
  restoreKanbanMoveFocus,
  type KanbanMoveCancelReason,
  type KanbanMoveInteractionHandler,
} from "./kanban-card-move";

interface KanbanCardProps {
  task: KanbanTask;
  npcs: readonly BoardNpc[];
  /** Reference time (ms) for computing elapsed time. The board bumps this every second. */
  now: number;
  selected: boolean;
  onOpen: (taskId: string) => void;
  moveDisabled?: boolean;
  getMoveRoot?: () => HTMLElement | null;
  onMoveInteraction?: KanbanMoveInteractionHandler;
}

const SEVERITY_CLASS: Record<"critical" | "error" | "warning", string> = {
  critical: "bg-danger-bg text-danger",
  error: "bg-danger-bg text-danger",
  warning: "bg-npc-dark/15 text-npc-dark",
};

/** One card summary — title, assignee, priority, progress, warnings, running, comments, links. The drawer holds the detail. */
export default function KanbanCard({
  task,
  npcs,
  now,
  selected,
  onOpen,
  moveDisabled = false,
  getMoveRoot,
  onMoveInteraction,
}: KanbanCardProps) {
  const t = useT();
  const assignee = assigneeLabel(task.assignee, npcs);
  const progress = progressLabel(task);
  const warning = warningBadge(task);
  const running = isRunning(task);
  const elapsed = running ? elapsedSeconds(task, now) : null;
  const linkCount = (task.link_counts?.parents ?? 0) + (task.link_counts?.children ?? 0);
  const commentCount = task.comment_count ?? 0;
  const handleRef = useRef<HTMLButtonElement>(null);
  const movingRef = useRef(false);
  const targetRef = useRef<KanbanTaskStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [isMoving, setIsMoving] = useState(false);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const grabRef = useRef<{ x: number; y: number; width: number } | null>(null);
  const [preview, setPreview] = useState<KanbanDragPreviewState | null>(null);
  const focusFallbackRef = useRef<HTMLElement | null>(null);
  const moveRoot = useCallback(
    () =>
      getMoveRoot?.() ??
      handleRef.current?.closest<HTMLElement>("[data-kanban-board-root], .overflow-x-auto") ??
      null,
    [getMoveRoot],
  );

  const announce = useCallback(
    (key: string, values?: Record<string, string>) => {
      setAnnouncement(t(key, values));
    },
    [t],
  );

  const finish = useCallback(
    (restoreFocus = true) => {
      movingRef.current = false;
      setIsMoving(false);
      setPreview(null);
      pointerRef.current = null;
      grabRef.current = null;
      targetRef.current = null;
      const root = moveRoot();
      if (root) {
        clearMoveTargets(root);
        clearLockedColumns(root);
      }
      if (restoreFocus) restoreKanbanMoveFocus(handleRef.current, focusFallbackRef.current);
      focusFallbackRef.current = null;
    },
    [moveRoot],
  );

  const cancel = useCallback(
    (reason: KanbanMoveCancelReason) => {
      if (!movingRef.current) return;
      onMoveInteraction?.({ type: "cancel", taskId: task.id, source: task.status, reason });
      announce("kanban.move.cancelled");
      finish(reason !== "focus-loss");
    },
    [announce, finish, onMoveInteraction, task.id, task.status],
  );

  const start = useCallback(() => {
    if (moveDisabled || movingRef.current) return;
    movingRef.current = true;
    focusFallbackRef.current = handleRef.current?.closest<HTMLElement>("[data-column]") ?? null;
    setIsMoving(true);
    targetRef.current = null;
    const root = moveRoot();
    if (root) markLockedColumns(root, task.status);
    onMoveInteraction?.({ type: "start", taskId: task.id, source: task.status });
    announce("kanban.move.started", { title: task.title });
  }, [announce, moveDisabled, moveRoot, onMoveInteraction, task.id, task.status, task.title]);

  const selectTarget = useCallback(
    (column: HTMLElement) => {
      const target = columnStatus(column);
      if (!target || target === task.status || !isKanbanDirectMoveTarget(target, task.status))
        return;
      const root = moveRoot();
      if (!root || !root.contains(column)) return;
      targetRef.current = target;
      markMoveTarget(column, root);
      onMoveInteraction?.({ type: "target", taskId: task.id, source: task.status, target });
      announce("kanban.move.target", { column: t(`kanban.column.${target}`) });
    },
    [announce, moveRoot, onMoveInteraction, t, task.id, task.status],
  );

  // Unmount cleanup must run only on unmount. Adding the callback or task to the dependencies
  // would fire cleanup every time the parent re-renders with a new callback identity, clearing the
  // highlight and lock markers of an in-progress drag and even sending a "teardown" cancel
  // (observed in a real browser).
  const teardownRef = useRef({ moveRoot, onMoveInteraction, task });
  useEffect(() => {
    teardownRef.current = { moveRoot, onMoveInteraction, task };
  });
  useEffect(
    () => () => {
      if (!movingRef.current) return;
      const { moveRoot: rootOf, onMoveInteraction: notify, task: current } = teardownRef.current;
      notify?.({
        type: "cancel",
        taskId: current.id,
        source: current.status,
        reason: "teardown",
      });
      const root = rootOf();
      if (root) {
        clearMoveTargets(root);
        clearLockedColumns(root);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isMoving) return;
    const onBlur = () => cancel("focus-loss");
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [cancel, isMoving]);

  const columnAtPoint = (clientX: number, clientY: number) => {
    const hit = document.elementFromPoint(clientX, clientY);
    const column = hit?.closest<HTMLElement>("[data-column]") ?? null;
    const root = moveRoot();
    const target = column ? columnStatus(column) : null;
    return root &&
      column &&
      target &&
      root.contains(column) &&
      directMoveColumns(root, task.status).includes(column)
      ? column
      : null;
  };

  /**
   * A pointer that ends via drag subsequently fires a click. That click is swallowed exactly
   * once, wherever it lands.
   *
   * Because capture is attached at drag-start, this click goes not to the card but to the
   * **element under the pointer**. Blocking it only at the card would let the modal backdrop
   * receive the click when dropped outside the board, closing the kanban (confirmed via e2e). The
   * double-action of opening the detail (R2) is blocked at the same spot. Since the click comes in
   * the same task as pointerup, collecting it with a timer leaves the next tap untouched.
   */
  const swallowDragClick = () => {
    const swallow = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };

  const pressListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
  } | null>(null);
  const stopListening = () => {
    const listeners = pressListenersRef.current;
    if (!listeners) return;
    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.cancel);
    pressListenersRef.current = null;
  };
  const listenWhilePressed = () => {
    stopListening();
    const listeners = {
      move: (event: PointerEvent) => pressHandlersRef.current.move(event),
      up: (event: PointerEvent) => pressHandlersRef.current.up(event),
      cancel: (event: PointerEvent) => pressHandlersRef.current.cancel(event),
    };
    pressListenersRef.current = listeners;
    window.addEventListener("pointermove", listeners.move, { passive: false });
    window.addEventListener("pointerup", listeners.up);
    window.addEventListener("pointercancel", listeners.cancel);
  };

  const onMovePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (moveDisabled || event.button !== 0) return;
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const rect = cardRef.current?.getBoundingClientRect();
    grabRef.current = rect
      ? { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width }
      : { x: 0, y: 0, width: 0 };
    // Never capture the pointer. A captured pointer's click gets retargeted to this article
    // instead of the inner detail button, so simply clicking the card would not open the drawer
    // (confirmed in a real browser). Capturing at drag-start doesn't work either — if the pointer
    // leaves the card before the 6px threshold, move never reaches the card and dragging never
    // even starts. Only listen for window move/up while the pointer is pressed.
    listenWhilePressed();
  };

  const onMovePointerMove = (event: PointerEvent) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!movingRef.current && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6)
      return;
    if (!movingRef.current) start();
    event.preventDefault();
    const grab = grabRef.current;
    if (grab) {
      setPreview({
        grabX: grab.x,
        grabY: grab.y,
        pointerX: event.clientX,
        pointerY: event.clientY,
        width: grab.width,
        title: task.title,
        subtitle: assignee ?? t("kanban.card.unassigned"),
      });
    }
    if (cardRef.current) autoScrollKanbanBoard(cardRef.current, event.clientX);
    const column = columnAtPoint(event.clientX, event.clientY);
    if (column?.dataset.column === task.status) {
      targetRef.current = null;
      const root = moveRoot();
      if (root) markMoveTarget(null, root);
    } else if (column) {
      selectTarget(column);
    } else {
      targetRef.current = null;
      const root = moveRoot();
      if (root) markMoveTarget(null, root);
    }
  };

  const onMovePointerUp = (event: PointerEvent) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    stopListening();
    pointerRef.current = null;
    if (!movingRef.current) return;
    swallowDragClick();
    const column = columnAtPoint(event.clientX, event.clientY);
    const target = columnStatus(column ?? document.createElement("div"));
    if (!column || !target) return cancel("outside");
    if (target === task.status) return cancel("same-column");
    if (targetRef.current !== target) selectTarget(column);
    onMoveInteraction?.({ type: "submit", taskId: task.id, source: task.status, target });
    announce("kanban.move.requested", { column: t(`kanban.column.${target}`) });
    finish();
  };

  const onMovePointerCancel = (event: PointerEvent) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (movingRef.current) swallowDragClick();
    stopListening();
    pointerRef.current = null;
    cancel("pointer-cancel");
  };

  // A window listener stays attached once set, so a ref keeps it calling the latest render's handler.
  const pressHandlersRef = useRef({
    move: onMovePointerMove,
    up: onMovePointerUp,
    cancel: onMovePointerCancel,
  });
  // If the card disappears while pressed (board refresh, a move confirming), tear down the window listener so it doesn't linger.
  useEffect(() => stopListening, []);
  useEffect(() => {
    pressHandlersRef.current = {
      move: onMovePointerMove,
      up: onMovePointerUp,
      cancel: onMovePointerCancel,
    };
  });

  const onMoveKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (moveDisabled) return;
    if (!movingRef.current) {
      if (event.key === " ") {
        event.preventDefault();
        start();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel("escape");
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const root = moveRoot();
      if (!root) return cancel("target-missing");
      const columns = directMoveColumns(root, task.status);
      const currentStatus = targetRef.current ?? task.status;
      const index = columns.findIndex((column) => column.dataset.column === currentStatus);
      const next = columns[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (next?.dataset.column === task.status) {
        targetRef.current = null;
        markMoveTarget(null, root);
        announce("kanban.move.target", { column: t(`kanban.column.${task.status}`) });
      } else if (next) {
        selectTarget(next);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = targetRef.current;
      const root = moveRoot();
      if (
        !root ||
        !target ||
        !directMoveColumns(root, task.status).some((column) => column.dataset.column === target)
      ) {
        cancel("target-missing");
        return;
      }
      onMoveInteraction?.({ type: "submit", taskId: task.id, source: task.status, target });
      announce("kanban.move.requested", { column: t(`kanban.column.${target}`) });
      finish();
    }
  };

  return (
    <article
      ref={cardRef}
      data-task-id={task.id}
      data-card-dragging={isMoving ? "true" : undefined}
      onPointerDown={onMovePointerDown}
      className={`group/card relative w-full rounded-lg border text-xs transition-colors ${
        moveDisabled ? "" : "cursor-grab touch-none active:cursor-grabbing"
      } ${isMoving ? "opacity-40" : ""} ${
        selected
          ? "border-info bg-info/10"
          : "border-border bg-surface hover:bg-surface-raised hover:border-border"
      }`}
    >
      <button
        type="button"
        data-card-detail={task.id}
        onClick={() => onOpen(task.id)}
        className="w-full p-2.5 pr-9 text-left"
      >
        <div className="font-semibold text-text leading-snug break-words">{task.title}</div>
        <div
          className="text-[10px] text-text-secondary"
          data-card-structure={isSwarmStructureCard(task) ? "swarm-root" : undefined}
        >
          {isSwarmStructureCard(task)
            ? t("kanban.card.swarmRoot")
            : task.review
              ? t(`kanban.review.${task.review.policy.mode}`)
              : t("kanban.review.legacy")}
        </div>
        <div className="mt-1 text-[11px] text-text-muted truncate">
          {assignee ?? t("kanban.card.unassigned")}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
          {task.priority ? (
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-text-secondary">
              {t("kanban.card.priority", { value: task.priority })}
            </span>
          ) : null}
          {progress ? (
            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-text-secondary">
              {t("kanban.card.progress", { value: progress })}
            </span>
          ) : null}
          {warning ? (
            <span
              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 ${SEVERITY_CLASS[warning.severity]}`}
              title={warning.severity}
            >
              <AlertTriangle className="w-3 h-3" />
              {t("kanban.card.warnings", { count: warning.count })}
            </span>
          ) : null}
          {running ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-success">
              <Play className="w-3 h-3" />
              {t("kanban.card.running", { elapsed: formatElapsed(elapsed ?? 0) })}
            </span>
          ) : null}
          {commentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-text-dim">
              <MessageSquare className="w-3 h-3" />
              {commentCount}
            </span>
          ) : null}
          {linkCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-text-dim">
              <GitBranch className="w-3 h-3" />
              {linkCount}
            </span>
          ) : null}
        </div>
      </button>
      <button
        ref={handleRef}
        type="button"
        data-card-move-handle={task.id}
        disabled={moveDisabled}
        aria-label={t("kanban.move.handle", { title: task.title })}
        aria-describedby={`kanban-move-help-${task.id}`}
        aria-pressed={isMoving}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onMoveKeyDown}
        onBlur={(event) => {
          if (movingRef.current && event.relatedTarget !== event.currentTarget)
            cancel("focus-loss");
        }}
        className="absolute right-1.5 top-1.5 rounded p-1 text-text-dim opacity-0 transition-opacity hover:bg-surface-raised focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:opacity-40 group-hover/card:opacity-100"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <span id={`kanban-move-help-${task.id}`} className="sr-only">
        {t("kanban.move.instructions")}
      </span>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <KanbanDragPreview state={preview} />
    </article>
  );
}
