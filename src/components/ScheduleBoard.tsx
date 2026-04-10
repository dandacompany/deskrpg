"use client";

import ScheduleListPanel from "./ScheduleListPanel";
import { useT } from "@/lib/i18n";
import { Timer, X } from "lucide-react";
import type { Socket } from "socket.io-client";

interface NpcInfo {
  id: string;
  name: string;
}

interface ScheduleBoardProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  socket: Socket | null;
  npcs: NpcInfo[];
}

export default function ScheduleBoard({ channelId, isOpen, onClose, socket, npcs }: ScheduleBoardProps) {
  const t = useT();
  if (!isOpen) return null;

  return (
    <div className="theme-game fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-raised rounded-xl border border-border w-[95vw] max-w-[700px] h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex justify-between items-center">
          <span className="text-title text-text flex items-center gap-1.5">
            <Timer className="w-4 h-4" />
            {t("schedule.boardTitle")}
          </span>
          <button onClick={onClose} className="text-text-muted hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <ScheduleListPanel channelId={channelId} socket={socket} npcs={npcs} />
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 text-center text-[10px] text-text-dim border-t border-border">
          {t("schedule.boardHint")}
        </div>
      </div>
    </div>
  );
}
