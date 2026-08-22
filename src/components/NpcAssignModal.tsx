"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { Bot, X } from "lucide-react";

interface NpcOption {
  id: string;
  name: string;
  inProgressCount: number;
  pendingCount: number;
  isActive: boolean;
}

interface NpcAssignModalProps {
  taskTitle: string;
  npcs: NpcOption[];
  onAssign: (npcId: string) => void;
  onCancel: () => void;
}

export default function NpcAssignModal({
  taskTitle,
  npcs,
  onAssign,
  onCancel,
}: NpcAssignModalProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-surface-raised rounded-xl border border-border w-[340px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex justify-between items-center">
          <span className="text-title text-text">{t("task.selectNpc")}</span>
          <button onClick={onCancel} className="text-text-muted hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 text-caption text-text-muted">
          {t("task.selectNpcDescription", { title: taskTitle })}
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-1.5">
          {npcs.map((npc) => (
            <button
              key={npc.id}
              onClick={() => npc.isActive && setSelectedId(npc.id)}
              disabled={!npc.isActive}
              className={`w-full flex items-center gap-2.5 p-2.5 rounded-lg transition ${
                !npc.isActive
                  ? "opacity-40 cursor-not-allowed bg-surface"
                  : selectedId === npc.id
                    ? "bg-surface border-2 border-primary"
                    : "bg-surface hover:bg-surface-raised border-2 border-transparent"
              }`}
            >
              <div className="w-8 h-8 bg-primary/30 rounded-full flex items-center justify-center">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 text-left">
                <div className="text-caption font-bold text-text">{npc.name}</div>
                <div className="text-[10px] text-text-muted">
                  {t("task.npcWorkload", {
                    inProgress: npc.inProgressCount,
                    pending: npc.pendingCount,
                  })}
                </div>
              </div>
              <div className={`text-[10px] ${npc.isActive ? "text-success" : "text-danger"}`}>
                ● {npc.isActive ? t("task.npcActive") : t("task.npcInactive")}
              </div>
            </button>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-border flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-2 text-caption bg-surface text-text-muted rounded-lg hover:bg-surface-raised"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => selectedId && onAssign(selectedId)}
            disabled={!selectedId}
            className="flex-1 px-3 py-2 text-caption bg-primary text-white rounded-lg hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("task.assign")}
          </button>
        </div>
      </div>
    </div>
  );
}
