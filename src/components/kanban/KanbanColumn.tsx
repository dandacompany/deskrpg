"use client";
import { useT } from "@/lib/i18n";
import type { KanbanTask, KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";

import KanbanCard from "./KanbanCard";
import type { KanbanMoveInteractionHandler } from "./kanban-card-move";
import type { BoardNpc } from "./kanban-view-model";

interface KanbanColumnProps {
  name: KanbanTaskStatus;
  tasks: KanbanTask[];
  npcs: readonly BoardNpc[];
  now: number;
  selectedTaskId: string | null;
  onOpen: (taskId: string) => void;
  moveDisabled?: boolean;
  activeMoveTaskId?: string | null;
  getMoveRoot?: () => HTMLElement | null;
  onMoveInteraction?: KanbanMoveInteractionHandler;
}

/** A single column. The name is the server status as-is; only the label is translated (R6). */
export default function KanbanColumn({
  name,
  tasks,
  npcs,
  now,
  selectedTaskId,
  onOpen,
  moveDisabled = false,
  activeMoveTaskId = null,
  getMoveRoot,
  onMoveInteraction,
}: KanbanColumnProps) {
  const t = useT();
  return (
    <section
      data-column={name}
      tabIndex={-1}
      aria-label={t(`kanban.column.${name}`)}
      className="flex w-[220px] flex-shrink-0 flex-col rounded-lg border border-border bg-bg-deep/40"
    >
      <header className="flex items-center justify-between px-2.5 py-2 border-b border-border">
        <span className="text-xs font-bold text-text-secondary">{t(`kanban.column.${name}`)}</span>
        <span className="rounded-full bg-surface-raised px-1.5 text-[10px] text-text-muted">
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-text-dim">{t("kanban.empty")}</div>
        ) : (
          tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              npcs={npcs}
              now={now}
              selected={task.id === selectedTaskId}
              onOpen={onOpen}
              moveDisabled={
                moveDisabled || (activeMoveTaskId !== null && activeMoveTaskId !== task.id)
              }
              getMoveRoot={getMoveRoot}
              onMoveInteraction={onMoveInteraction}
            />
          ))
        )}
      </div>
    </section>
  );
}
