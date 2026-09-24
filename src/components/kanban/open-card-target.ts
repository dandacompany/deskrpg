/**
 * Routes "open this card" to whichever of the kanban modal's two props applies.
 *
 * `initialTaskId` is only read on mount (`KanbanBoardModal.tsx:45`), so it never reaches an
 * already-open board — in that case bumping `focusRequest`'s `seq` is what moves the selection
 * (see the comment on line 52 of the same file). So this splits on whether the board was already
 * open at the moment of the click.
 */

import { nextKanbanFocus, type KanbanFocusRequest } from "@/app/game/artifact-entry";

export type OpenCardTarget = {
  initialTaskId: string | null;
  focusRequest: KanbanFocusRequest | null;
};

export function openCardTarget(input: {
  boardOpen: boolean;
  taskId: string;
  prev?: OpenCardTarget | null;
}): OpenCardTarget {
  if (!input.boardOpen) return { initialTaskId: input.taskId, focusRequest: null };
  return {
    initialTaskId: null,
    focusRequest: nextKanbanFocus(input.prev?.focusRequest ?? null, input.taskId),
  };
}
