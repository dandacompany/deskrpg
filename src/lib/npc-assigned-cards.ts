import type { KanbanBoard, KanbanTask, KanbanTaskStatus } from "@/lib/hermes/deskrpg-plugin-types";
import { taskTimeMs } from "@/lib/plugin-time";

/**
 * The status-group order — smaller comes first. The vocabulary is `KANBAN_TASK_STATUSES`
 * (there's no status like `in_progress` — running is `running`). The spec only says
 * "running → waiting → done," so `blocked` is grouped with the rest.
 */
function rank(status: KanbanTaskStatus): number {
  if (status === "running") return 0;
  if (status === "done") return 2;
  if (status === "archived") return 3;
  return 1;
}

/** Only the cards on the board assigned to this profile, ordered running → rest → done → archived, newest-first within each group. */
export function assignedCards(board: KanbanBoard, npcProfile: string): KanbanTask[] {
  const mine = board.columns.flatMap((c) => c.tasks).filter((t) => t.assignee === npcProfile);
  return mine.sort((a, b) => {
    const byRank = rank(a.status) - rank(b.status);
    if (byRank !== 0) return byRank;
    // A Kanban timestamp is either epoch seconds or an ISO string — never compared as a string, always read through `taskTimeMs`.
    return (taskTimeMs(b.created_at) ?? 0) - (taskTimeMs(a.created_at) ?? 0);
  });
}
