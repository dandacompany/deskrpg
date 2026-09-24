"use client";
/**
 * The modal shell for the channel cron screen (R15). `CronPanel` only renders the content,
 * so the backdrop/dialog/ESC are attached here — the same convention as `KanbanBoardModal`.
 * The socket subscription (`cron:event`) is handled by the panel itself.
 */
import { useEffect } from "react";

import { useT } from "@/lib/i18n";

import CronPanel, { type CronEventSource, type CronPanelNpc } from "./CronPanel";

export interface CronModalProps {
  channelId: string;
  /** The channel's active NPCs — the name is the profile display name (not `npcs.name`). */
  npcs: CronPanelNpc[];
  socket?: CronEventSource | null;
  onToast?: (message: string) => void;
  onClose: () => void;
  /** Room notice's "open history" — opens with that job's run history (R30). */
  initialJobId?: string | null;
}

export default function CronModal({
  channelId,
  npcs,
  socket = null,
  onToast,
  onClose,
  initialJobId = null,
}: CronModalProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="cron-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("cron.title")}
        className="bg-bg border border-border rounded-xl shadow-2xl w-[96vw] max-w-[1200px] h-[88dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <CronPanel
          channelId={channelId}
          npcs={npcs}
          socket={socket}
          onToast={onToast}
          onClose={onClose}
          initialJobId={initialJobId}
          className="flex-1"
        />
      </div>
    </div>
  );
}
