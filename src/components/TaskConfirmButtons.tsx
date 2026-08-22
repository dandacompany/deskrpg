"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";

/** Phrases that trigger the confirm widget (all locales) */
const CONFIRM_PATTERNS = [
  "태스크로 등록할까요",
  "태스크로 등록할까",
  "register this as a task",
  "タスクとして登録しますか",
  "登记为任务吗",
  "登記為任務嗎",
];

/** Check if an NPC message contains a task registration confirmation prompt */
export function isTaskConfirmPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return CONFIRM_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

interface TaskConfirmButtonsProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export default function TaskConfirmButtons({ onConfirm, onCancel }: TaskConfirmButtonsProps) {
  const t = useT();
  const [clicked, setClicked] = useState<"confirm" | "cancel" | null>(null);

  if (clicked) {
    return (
      <div className="flex gap-2 mt-1.5">
        <span
          className={`text-xs px-3 py-1 rounded ${clicked === "confirm" ? "bg-primary/30 text-primary" : "bg-surface text-text-dim"}`}
        >
          {clicked === "confirm" ? `✅ ${t("task.registered")}` : `❌ ${t("task.cancelled")}`}
        </span>
      </div>
    );
  }

  return (
    <div className="flex gap-2 mt-1.5">
      <button
        onClick={() => {
          setClicked("confirm");
          onConfirm();
        }}
        className="text-xs px-3 py-1 rounded bg-primary hover:bg-primary-hover text-white font-semibold transition"
      >
        📋 {t("task.register")}
      </button>
      <button
        onClick={() => {
          setClicked("cancel");
          onCancel();
        }}
        className="text-xs px-3 py-1 rounded bg-surface-raised hover:bg-surface text-text-muted font-semibold transition"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
