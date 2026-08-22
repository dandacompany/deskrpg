"use client";

interface TaskInlineCardProps {
  taskId: string;
  npcTaskId: string;
  title: string;
  status: string;
  onClick?: (npcTaskId: string) => void;
}

const STATUS_STYLES: Record<string, { border: string; text: string; icon: string }> = {
  pending: { border: "border-l-text-muted", text: "text-text-muted", icon: "\u23F3" },
  in_progress: { border: "border-l-warning", text: "text-warning", icon: "\uD83D\uDD04" },
  stalled: { border: "border-l-danger", text: "text-danger", icon: "\u23F8" },
  complete: { border: "border-l-success", text: "text-success", icon: "\u2705" },
  cancelled: { border: "border-l-text-dim", text: "text-text-dim", icon: "\u274C" },
};

export default function TaskInlineCard({
  taskId,
  npcTaskId,
  title,
  status,
  onClick,
}: TaskInlineCardProps) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending;

  return (
    <button
      onClick={() => onClick?.(npcTaskId)}
      className={`w-full text-left my-1 px-3 py-2 rounded-md border-l-3 ${style.border} bg-bg/60 hover:bg-surface transition-colors cursor-pointer`}
    >
      <div className={`text-xs font-semibold ${style.text}`}>
        {style.icon} {title}
      </div>
      <div className="text-[10px] text-text-dim mt-0.5">{status} · 클릭하여 태스크 대화 →</div>
    </button>
  );
}
