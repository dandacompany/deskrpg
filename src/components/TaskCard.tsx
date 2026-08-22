"use client";

import { useT } from "@/lib/i18n";
import { Clock, Circle, Check, X as XIcon, Bot, PauseCircle, Inbox } from "lucide-react";
import Badge from "./ui/Badge";

interface Task {
  id: string;
  npcId?: string;
  npcTaskId?: string;
  title: string;
  summary: string | null;
  status: string;
  npcName?: string;
  autoNudgeCount?: number;
  autoNudgeMax?: number;
  lastNudgedAt?: string | null;
  lastReportedAt?: string | null;
  stalledAt?: string | null;
  stalledReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

interface TaskCardProps {
  task: Task;
  showNpcName?: boolean;
  compact?: boolean;
  onDelete?: (taskId: string) => void;
  onRequestReport?: (taskId: string) => void;
  onResume?: (taskId: string) => void;
  onAssign?: (taskId: string) => void;
  onComplete?: (taskId: string) => void;
  onClick?: (taskId: string) => void;
}

const STATUS_CONFIG: Record<
  string,
  { color: string; border: string; icon: React.ReactNode; labelKey: string }
> = {
  backlog: {
    labelKey: "task.backlog",
    color: "text-text-muted",
    border: "border-l-text-dim",
    icon: <Inbox className="w-3 h-3 inline" />,
  },
  pending: {
    labelKey: "task.pending",
    color: "text-npc",
    border: "border-l-npc",
    icon: <Clock className="w-3 h-3 inline" />,
  },
  in_progress: {
    labelKey: "task.inProgress",
    color: "text-danger",
    border: "border-l-danger",
    icon: <Circle className="w-3 h-3 inline" />,
  },
  stalled: {
    labelKey: "task.stalled",
    color: "text-warning",
    border: "border-l-warning",
    icon: <PauseCircle className="w-3 h-3 inline" />,
  },
  complete: {
    labelKey: "task.complete",
    color: "text-success",
    border: "border-l-success",
    icon: <Check className="w-3 h-3 inline" />,
  },
  cancelled: {
    labelKey: "task.cancelled",
    color: "text-text-muted",
    border: "border-l-text-muted",
    icon: <XIcon className="w-3 h-3 inline" />,
  },
};

export default function TaskCard({
  task,
  showNpcName = false,
  compact = false,
  onDelete,
  onRequestReport,
  onResume,
  onAssign,
  onComplete,
  onClick,
}: TaskCardProps) {
  const t = useT();
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const npcName = task.npcName || "";
  const npcTaskId = task.npcTaskId || "";
  const updatedAt = task.updatedAt || task.createdAt || "";
  const isFinished = task.status === "complete" || task.status === "cancelled";
  const nudgeCount = task.autoNudgeCount ?? 0;
  const nudgeMax = task.autoNudgeMax ?? 5;
  const nudgeLabel =
    task.status === "stalled"
      ? t("task.stalledCount", { count: nudgeCount, max: nudgeMax })
      : task.status === "pending" || task.status === "in_progress"
        ? t("task.autoNudgeCount", { count: nudgeCount, max: nudgeMax })
        : "";

  function formatTimestamp(dateStr: string): string {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  return (
    <div
      className={`bg-surface rounded-lg p-2.5 border-l-[3px] ${config.border} ${
        isFinished ? "opacity-60" : ""
      } ${onClick ? "cursor-pointer hover:bg-surface-raised" : ""}`}
      onClick={onClick ? () => onClick(task.id) : undefined}
    >
      <div className="flex justify-between items-center mb-1">
        <span className={`text-[12px] font-bold ${config.color}`}>
          {config.icon} {t(config.labelKey)}
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-text-dim">{npcTaskId}</span>
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              className="text-text-dim hover:text-danger text-[12px] ml-1"
              title={t("common.delete")}
            >
              x
            </button>
          )}
        </div>
      </div>
      <div className="text-text text-caption font-bold mb-1">{task.title}</div>
      {!compact && task.summary && (
        <div className="text-text-muted text-[12px] mb-1.5 line-clamp-2">{task.summary}</div>
      )}
      {nudgeLabel ? <div className="mb-1.5 text-[11px] text-text-dim">{nudgeLabel}</div> : null}
      <div className="mb-2 flex flex-wrap gap-1.5">
        {(task.status === "pending" ||
          task.status === "in_progress" ||
          task.status === "stalled") &&
        onComplete ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onComplete(task.id);
            }}
            className="rounded bg-success/20 px-2 py-1 text-[12px] text-success hover:bg-success/30"
          >
            {t("task.markComplete")}
          </button>
        ) : null}
        {(task.status === "pending" ||
          task.status === "in_progress" ||
          task.status === "stalled") &&
        onRequestReport ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRequestReport(task.id);
            }}
            className="rounded bg-primary/20 px-2 py-1 text-[12px] text-primary hover:bg-primary/30"
          >
            {t("task.requestReport")}
          </button>
        ) : null}
        {task.status === "stalled" && onResume ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onResume(task.id);
            }}
            className="rounded bg-warning/20 px-2 py-1 text-[12px] text-warning hover:bg-warning/30"
          >
            {t("task.resume")}
          </button>
        ) : null}
        {task.status === "backlog" && onAssign ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAssign(task.id);
            }}
            className="rounded bg-primary/20 px-2 py-1 text-[12px] text-primary hover:bg-primary/30"
          >
            {t("task.assign")}
          </button>
        ) : null}
      </div>
      <div className="flex justify-between items-center text-[11px] text-text-dim">
        {showNpcName &&
          (npcName ? (
            <Badge variant="npc" size="sm">
              <Bot className="w-3 h-3" />
              {npcName}
            </Badge>
          ) : (
            <span className="text-[11px] text-text-dim">{t("task.unassigned")}</span>
          ))}
        <span>{formatTimestamp(updatedAt)}</span>
      </div>
    </div>
  );
}

export type { Task };
