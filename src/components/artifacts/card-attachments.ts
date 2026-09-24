import type { ArtifactSummary, KanbanBoardAttachment } from "@/lib/hermes/deskrpg-plugin-types";

import type { ArtifactFilter } from "./ArtifactList";

/** One card attachment appended to the gallery — needs to carry which board it's from to be downloadable. */
export type GalleryAttachment = KanbanBoardAttachment & { boardSlug: string };

/**
 * Picks the card attachments the artifact gallery shows after the artifacts.
 *
 * - **Never shows the same document twice.** Once the worker loads the plugin, the same file
 *   gets caught both as an artifact and as a card attachment. If the same card (`task_id`) has
 *   the same filename, keep only the artifact — an artifact carries versions/preview and shows
 *   more. The check only looks at the **currently loaded** artifacts.
 * - Attachments have no kind/source/employee. If those filters are set, hide them — passing
 *   through something with no basis to filter on would make the filter lie. The kind tab only
 *   shows them under "all" and "file".
 * - If opened from a card (`taskId`), only that card's attachments.
 * - The search term matches against filename and card title.
 */
export function visibleCardAttachments(
  attachments: readonly GalleryAttachment[],
  artifacts: readonly ArtifactSummary[],
  filter: ArtifactFilter,
  taskId: string | null,
): GalleryAttachment[] {
  if (filter.category && filter.category !== "file") return [];
  if (filter.source || filter.profile) return [];
  const shown = new Set(
    artifacts.filter((a) => a.task_id).map((a) => `${a.task_id}\u0000${a.filename}`),
  );
  const q = filter.q?.trim().toLowerCase() ?? "";
  return attachments.filter((a) => {
    if (taskId && a.task_id !== taskId) return false;
    if (shown.has(`${a.task_id}\u0000${a.filename}`)) return false;
    if (!q) return true;
    return a.filename.toLowerCase().includes(q) || (a.task_title ?? "").toLowerCase().includes(q);
  });
}
