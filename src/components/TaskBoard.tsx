"use client";

import { useState, useMemo } from "react";
import TaskCard from "./TaskCard";
import type { Task } from "./TaskCard";
import { useT } from "@/lib/i18n";
import { ClipboardList, X, Clock, Loader, CheckCircle, PauseCircle } from "lucide-react";

interface TaskBoardProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  onDeleteTask?: (taskId: string) => void;
  onRequestReportTask?: (taskId: string) => void;
  onResumeTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
  tasks: Task[];
}

export default function TaskBoard({
  isOpen,
  onClose,
  tasks,
  onDeleteTask,
  onRequestReportTask,
  onResumeTask,
  onCompleteTask,
}: TaskBoardProps) {
  const t = useT();
  const [filterNpc, setFilterNpc] = useState<string | null>(null);

  const npcList = useMemo(() => {
    const map = new Map<string, string>();
    tasks.forEach((task) => {
      const npcId = task.npcId;
      const npcName = task.npcName || t("common.unknown");
      if (npcId && !map.has(npcId)) map.set(npcId, npcName);
    });
    return Array.from(map.entries());
  }, [tasks, t]);

  const filtered = filterNpc ? tasks.filter((t) => t.npcId === filterNpc) : tasks;

  const pending = filtered.filter((t) => t.status === "pending");
  const inProgress = filtered.filter((t) => t.status === "in_progress");
  const stalled = filtered.filter((t) => t.status === "stalled");
  const done = filtered.filter((t) => t.status === "complete" || t.status === "cancelled");

  if (!isOpen) return null;

  return (
    <div className="theme-game fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-surface-raised rounded-xl border border-border w-[90vw] max-w-[900px] h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-title text-text flex items-center gap-1.5"><ClipboardList className="w-4 h-4" />{t("task.board")}</span>
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
        <div className="flex-1 flex gap-3 p-3 overflow-hidden">
          {/* Pending */}
          <div className="flex-1 bg-surface rounded-lg p-2.5 flex flex-col">
            <div className="text-[11px] text-npc font-bold mb-2 flex justify-between">
              <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{t("task.pending")}</span>
              <span className="bg-npc/20 px-1.5 rounded">{pending.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {pending.map((t) => (
                <TaskCard key={t.id} task={t} showNpcName compact onDelete={onDeleteTask} onRequestReport={onRequestReportTask} onResume={onResumeTask} onComplete={onCompleteTask} />
              ))}
            </div>
          </div>

          {/* In Progress */}
          <div className="flex-1 bg-surface rounded-lg p-2.5 flex flex-col">
            <div className="text-[11px] text-danger font-bold mb-2 flex justify-between">
              <span className="flex items-center gap-1"><Loader className="w-3.5 h-3.5" />{t("task.inProgress")}</span>
              <span className="bg-danger/20 px-1.5 rounded">{inProgress.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {inProgress.map((t) => (
                <TaskCard key={t.id} task={t} showNpcName compact onDelete={onDeleteTask} onRequestReport={onRequestReportTask} onResume={onResumeTask} onComplete={onCompleteTask} />
              ))}
            </div>
          </div>

          {/* Stalled */}
          <div className="flex-1 bg-surface rounded-lg p-2.5 flex flex-col">
            <div className="text-[11px] text-warning font-bold mb-2 flex justify-between">
              <span className="flex items-center gap-1"><PauseCircle className="w-3.5 h-3.5" />{t("task.stalled")}</span>
              <span className="bg-warning/20 px-1.5 rounded">{stalled.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {stalled.map((t) => (
                <TaskCard key={t.id} task={t} showNpcName compact onDelete={onDeleteTask} onRequestReport={onRequestReportTask} onResume={onResumeTask} onComplete={onCompleteTask} />
              ))}
            </div>
          </div>

          {/* Done */}
          <div className="flex-1 bg-surface rounded-lg p-2.5 flex flex-col">
            <div className="text-[11px] text-success font-bold mb-2 flex justify-between">
              <span className="flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" />{t("task.done")}</span>
              <span className="bg-success/20 px-1.5 rounded">{done.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {done.map((t) => (
                <TaskCard key={t.id} task={t} showNpcName compact onDelete={onDeleteTask} onRequestReport={onRequestReportTask} onResume={onResumeTask} onComplete={onCompleteTask} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
