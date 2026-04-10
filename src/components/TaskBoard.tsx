"use client";

import { useState, useMemo, useCallback } from "react";
import TaskCard from "./TaskCard";
import type { Task } from "./TaskCard";
import TaskCreateForm from "./TaskCreateForm";
import NpcAssignModal from "./NpcAssignModal";
import DroppableColumn from "./DroppableColumn";
import DraggableTaskCard from "./DraggableTaskCard";
import { useT } from "@/lib/i18n";
import { ClipboardList, X, Clock, Loader, CheckCircle, PauseCircle, Inbox } from "lucide-react";
import type { Socket } from "socket.io-client";

interface NpcInfo {
  id: string;
  name: string;
  isActive: boolean;
}

interface TaskBoardProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  onDeleteTask?: (taskId: string) => void;
  onRequestReportTask?: (taskId: string) => void;
  onResumeTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  tasks: Task[];
  socket: Socket | null;
  npcs?: NpcInfo[];
}

const COLUMNS = [
  { status: "backlog", labelKey: "task.backlog", colorClass: "text-text-muted", bgClass: "bg-text-muted/20", Icon: Inbox },
  { status: "pending", labelKey: "task.pending", colorClass: "text-npc", bgClass: "bg-npc/20", Icon: Clock },
  { status: "in_progress", labelKey: "task.inProgress", colorClass: "text-danger", bgClass: "bg-danger/20", Icon: Loader },
  { status: "stalled", labelKey: "task.stalled", colorClass: "text-warning", bgClass: "bg-warning/20", Icon: PauseCircle },
  { status: "done", labelKey: "task.done", colorClass: "text-success", bgClass: "bg-success/20", Icon: CheckCircle },
] as const;

export default function TaskBoard({
  channelId,
  isOpen,
  onClose,
  tasks,
  onDeleteTask,
  onRequestReportTask,
  onResumeTask,
  onCompleteTask,
  socket,
  npcs = [],
}: TaskBoardProps) {
  const t = useT();
  const [filterNpc, setFilterNpc] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [assignModal, setAssignModal] = useState<{
    taskId: string;
    taskTitle: string;
    toStatus: string;
  } | null>(null);

  const npcList = useMemo(() => {
    const map = new Map<string, string>();
    tasks.forEach((task) => {
      if (task.npcId && task.npcName && !map.has(task.npcId)) {
        map.set(task.npcId, task.npcName);
      }
    });
    return Array.from(map.entries());
  }, [tasks]);

  const filtered = filterNpc ? tasks.filter((t) => t.npcId === filterNpc) : tasks;

  const groupedTasks = useMemo(() => ({
    backlog: filtered.filter((t) => t.status === "backlog"),
    pending: filtered.filter((t) => t.status === "pending"),
    in_progress: filtered.filter((t) => t.status === "in_progress"),
    stalled: filtered.filter((t) => t.status === "stalled"),
    done: filtered.filter((t) => t.status === "complete" || t.status === "cancelled"),
  }), [filtered]);

  const npcOptions = useMemo(() => {
    return npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      inProgressCount: tasks.filter((t) => t.npcId === npc.id && t.status === "in_progress").length,
      pendingCount: tasks.filter((t) => t.npcId === npc.id && t.status === "pending").length,
      isActive: npc.isActive,
    }));
  }, [npcs, tasks]);

  const handleCreateTask = useCallback((title: string, summary: string) => {
    if (!socket) return;
    socket.emit("task:create", { channelId, title, summary: summary || undefined });
    setShowCreateForm(false);
  }, [socket, channelId]);

  const handleDrop = useCallback((taskId: string, fromStatus: string, toStatus: string) => {
    if (!socket) return;

    const actualToStatus = toStatus === "done" ? "complete" : toStatus;
    const actualFromStatus = fromStatus === "done" ? "complete" : fromStatus;
    if (actualFromStatus === actualToStatus) return;

    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const needsNpc = !task.npcId && actualToStatus !== "backlog" && actualToStatus !== "cancelled";
    if (needsNpc) {
      setAssignModal({ taskId, taskTitle: task.title, toStatus: actualToStatus });
      return;
    }

    socket.emit("task:move", { taskId, toStatus: actualToStatus });
  }, [socket, tasks]);

  const handleAssignFromModal = useCallback((npcId: string) => {
    if (!socket || !assignModal) return;
    socket.emit("task:move", { taskId: assignModal.taskId, toStatus: assignModal.toStatus, npcId });
    setAssignModal(null);
  }, [socket, assignModal]);

  const handleAssignClick = useCallback((taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setAssignModal({ taskId, taskTitle: task.title, toStatus: "pending" });
  }, [tasks]);

  if (!isOpen) return null;

  return (
    <div className="theme-game fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-surface-raised rounded-xl border border-border w-[95vw] max-w-[1100px] h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-title text-text flex items-center gap-1.5">
              <ClipboardList className="w-4 h-4" />{t("task.board")}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setFilterNpc(null)}
                className={`px-2 py-0.5 rounded text-[10px] ${
                  !filterNpc ? "bg-primary text-white" : "bg-surface text-text-muted"
                }`}
              >
                {t("common.all")}
              </button>
              {npcList.map(([id, name]) => (
                <button
                  key={id}
                  onClick={() => setFilterNpc(id)}
                  className={`px-2 py-0.5 rounded text-[10px] ${
                    filterNpc === id ? "bg-primary text-white" : "bg-surface text-text-muted"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {/* Kanban Columns */}
        <div className="flex-1 flex gap-2 p-3 overflow-hidden">
          {COLUMNS.map((col) => {
            const colTasks = groupedTasks[col.status as keyof typeof groupedTasks] || [];
            return (
              <DroppableColumn
                key={col.status}
                status={col.status}
                onDrop={handleDrop}
                header={
                  <div className={`text-[11px] ${col.colorClass} font-bold mb-2 flex justify-between`}>
                    <span className="flex items-center gap-1">
                      <col.Icon className="w-3.5 h-3.5" />{t(col.labelKey)}
                    </span>
                    <span className={`${col.bgClass} px-1.5 rounded`}>{colTasks.length}</span>
                  </div>
                }
              >
                {col.status === "backlog" && (
                  showCreateForm ? (
                    <TaskCreateForm
                      onSubmit={handleCreateTask}
                      onCancel={() => setShowCreateForm(false)}
                    />
                  ) : (
                    <button
                      onClick={() => setShowCreateForm(true)}
                      className="w-full border border-dashed border-primary/50 rounded-lg py-2 text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition mb-1"
                    >
                      + {t("task.createNew")}
                    </button>
                  )
                )}
                {colTasks.map((task) => (
                  <DraggableTaskCard key={task.id} taskId={task.id} status={col.status}>
                    <TaskCard
                      task={task}
                      showNpcName
                      compact
                      onDelete={onDeleteTask}
                      onRequestReport={onRequestReportTask}
                      onResume={onResumeTask}
                      onComplete={onCompleteTask}
                      onAssign={handleAssignClick}
                    />
                  </DraggableTaskCard>
                ))}
              </DroppableColumn>
            );
          })}
        </div>

        {/* Drag hint */}
        <div className="px-4 py-2 text-center text-[10px] text-text-dim border-t border-border">
          {t("task.dragHint")}
        </div>
      </div>

      {/* NPC Assign Modal */}
      {assignModal && (
        <NpcAssignModal
          taskTitle={assignModal.taskTitle}
          npcs={npcOptions}
          onAssign={handleAssignFromModal}
          onCancel={() => setAssignModal(null)}
        />
      )}
    </div>
  );
}
