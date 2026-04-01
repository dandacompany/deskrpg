"use client";

import type { ReactNode } from "react";

interface MeetingSidebarProps {
  participantCount: number;
  title: string;
  width: number;
  actions?: ReactNode;
  statusBar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
}

export default function MeetingSidebar({
  participantCount,
  title,
  width,
  actions,
  statusBar,
  children,
  footer,
  onResizeStart,
  isResizing = false,
}: MeetingSidebarProps) {
  return (
    <div
      className="relative flex flex-col border-l border-border bg-bg/95 shrink-0 h-full overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div
        className="absolute inset-y-0 left-0 z-30 w-4 -translate-x-1/2 cursor-col-resize touch-none"
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize group chat sidebar"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80" />
        <div
          className={`absolute left-1/2 top-1/2 h-16 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border transition ${
            isResizing
              ? "border-primary/80 bg-primary/50 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]"
              : "border-border/80 bg-surface-raised/90 hover:border-primary/60 hover:bg-primary/30"
          }`}
        />
      </div>

      <div className="px-4 py-2 border-b border-border bg-surface/80 flex items-center justify-between flex-shrink-0">
        <div>
          <span className="text-title text-text-secondary">{title}</span>
          <span className="text-caption text-text-dim ml-2">
            {participantCount}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {actions}
        </div>
      </div>

      {statusBar ? (
        <div className="px-3 py-1.5 bg-surface border-b border-border text-caption text-text-muted">
          {statusBar}
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {children}
      </div>

      {footer ? (
        <div className="flex-shrink-0">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
