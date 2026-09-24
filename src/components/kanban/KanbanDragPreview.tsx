"use client";
import { createPortal } from "react-dom";

export interface KanbanDragPreviewState {
  /** Cursor position within the card at the moment it was grabbed. Keeping this steady is what keeps the card from jumping out of the hand. */
  grabX: number;
  grabY: number;
  pointerX: number;
  pointerY: number;
  width: number;
  title: string;
  subtitle: string;
}

/**
 * A copy of the card that follows the pointer. The original card stays in place, dimmed (R2), and
 * only this copy moves. Only `transform` changes, so layout isn't recomputed every frame.
 * Not rendered for keyboard moves, since there are no pointer coordinates.
 */
export default function KanbanDragPreview({ state }: { state: KanbanDragPreviewState | null }) {
  if (!state || typeof document === "undefined") return null;
  const x = state.pointerX - state.grabX;
  const y = state.pointerY - state.grabY;
  return createPortal(
    <div
      data-kanban-drag-preview=""
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-50 rounded-lg border border-info bg-surface-raised p-2.5 text-xs shadow-lg"
      style={{
        // The tilt is layered on by CSS's separate `rotate` property, so reduced-motion can turn off just that.
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: state.width > 0 ? `${state.width}px` : undefined,
      }}
    >
      <div className="font-semibold text-text leading-snug break-words">{state.title}</div>
      <div className="mt-1 text-[11px] text-text-muted truncate">{state.subtitle}</div>
    </div>,
    document.body,
  );
}
