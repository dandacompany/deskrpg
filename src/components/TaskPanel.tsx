"use client";

import { useEffect, useState } from "react";
import TaskCard from "./TaskCard";
import type { Task } from "./TaskCard";
import type { Socket } from "socket.io-client";
import { useT } from "@/lib/i18n";

interface TaskPanelProps {
  npcId: string;
  npcName: string;
  socket: Socket | null;
  onDeleteTask?: (taskId: string) => void;
  onRequestReportTask?: (taskId: string) => void;
  onResumeTask?: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void;
}

export default function TaskPanel({
  npcId,
  npcName,
  socket,
  onDeleteTask,
  onRequestReportTask,
  onResumeTask,
  onCompleteTask,
}: TaskPanelProps) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadedNpcId, setLoadedNpcId] = useState<string | null>(null);
  const loading = Boolean(socket && npcId) && loadedNpcId !== npcId;

  useEffect(() => {
    if (!socket || !npcId) return;

    const handleTaskList = ({ tasks: taskList, npcId: responseNpcId }: { tasks: Task[]; npcId: string | null }) => {
      if (responseNpcId !== npcId) return;
      setTasks(taskList);
      setLoadedNpcId(npcId);
    };

    socket.on("task:list-response", handleTaskList);
    socket.emit("task:list", { channelId: null, npcId });
    return () => { socket.off("task:list-response", handleTaskList); };
  }, [socket, npcId]);

  useEffect(() => {
    if (!socket) return;

    const handleTaskUpdated = ({ task }: { task: Task; action: string }) => {
      const taskNpcId = task.npcId;
      if (taskNpcId !== npcId) return;

      setLoadedNpcId(npcId);
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = task;
          return updated;
        }
        return [task, ...prev];
      });
    };

    const handleTaskDeleted = ({ taskId }: { taskId: string }) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    };

    socket.on("task:updated", handleTaskUpdated);
    socket.on("task:deleted", handleTaskDeleted);
    return () => { socket.off("task:updated", handleTaskUpdated); socket.off("task:deleted", handleTaskDeleted); };
  }, [socket, npcId]);

  const handleDelete = (taskId: string) => {
    if (onDeleteTask) {
      onDeleteTask(taskId);
      return;
    }
    if (!socket) return;
    socket.emit("task:delete", { taskId });
  };

  const handleRequestReport = (taskId: string) => {
    if (onRequestReportTask) {
      onRequestReportTask(taskId);
      return;
    }
    if (!socket) return;
    socket.emit("task:request-report", { taskId });
  };

  const handleResume = (taskId: string) => {
    if (onResumeTask) {
      onResumeTask(taskId);
      return;
    }
    if (!socket) return;
    socket.emit("task:resume", { taskId });
  };

  const handleComplete = (taskId: string) => {
    if (onCompleteTask) {
      onCompleteTask(taskId);
      return;
    }
    if (!socket) return;
    socket.emit("task:complete", { taskId });
  };

  const activeTasks = tasks.filter((t) => t.status === "in_progress" || t.status === "pending");
  const stalledTasks = tasks.filter((t) => t.status === "stalled");
  const doneTasks = tasks.filter((t) => t.status === "complete" || t.status === "cancelled");

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-text-muted text-body">{t("common.loading")}</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-body">
        {t("task.noTasks", { name: npcName })}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-2">
      {activeTasks.length > 0 && (
        <>
          <div className="text-micro text-text-dim font-bold px-1">{t("task.active")} ({activeTasks.length})</div>
          {activeTasks.map((task) => (
            <TaskCard key={task.id} task={task} onDelete={handleDelete} onRequestReport={handleRequestReport} onResume={handleResume} onComplete={handleComplete} />
          ))}
        </>
      )}
      {stalledTasks.length > 0 && (
        <>
          <div className="text-micro text-text-dim font-bold px-1 mt-2">{t("task.stalled")} ({stalledTasks.length})</div>
          {stalledTasks.map((task) => (
            <TaskCard key={task.id} task={task} onDelete={handleDelete} onRequestReport={handleRequestReport} onResume={handleResume} onComplete={handleComplete} />
          ))}
        </>
      )}
      {doneTasks.length > 0 && (
        <>
          <div className="text-micro text-text-dim font-bold px-1 mt-2">{t("task.done")} ({doneTasks.length})</div>
          {doneTasks.map((task) => (
            <TaskCard key={task.id} task={task} onDelete={handleDelete} onRequestReport={handleRequestReport} onResume={handleResume} onComplete={handleComplete} />
          ))}
        </>
      )}
    </div>
  );
}
