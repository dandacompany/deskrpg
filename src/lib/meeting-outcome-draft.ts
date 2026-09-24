/**
 * A draft a human touches up before registering a meeting outcome.
 *
 * The first-pass editing scope is only selection, title, and assignee. The body and order
 * are fixed afterward in Kanban, once registered — this keeps the end-of-meeting screen
 * from turning into an editor.
 */
import type { MeetingOutcome } from "./meeting-outcome";
import { tenantSlugFromName } from "./tenant-slug";

export type OutcomeDraftItem = {
  /** The original index within `outcome.followUps`. The registration idempotency key
   * (`meeting:{id}:{index}`) uses this value. */
  index: number;
  selected: boolean;
  title: string;
  npcId: string | null;
  after: number[];
};

export type OutcomeDraft = {
  items: OutcomeDraftItem[];
  /** If left empty, registers with no subproject (tenant). */
  subprojectName: string;
};

export type OutcomeRegistration = {
  tenant: { slug: string; name: string } | null;
  items: Array<{ index: number; title: string; npcId: string | null; after: number[] }>;
};

export function createOutcomeDraft(outcome: MeetingOutcome): OutcomeDraft {
  return {
    items: outcome.followUps.map((followUp, index) => ({
      index,
      selected: true,
      title: followUp.title,
      npcId: followUp.assigneeNpcId,
      after: followUp.after,
    })),
    subprojectName: outcome.project?.name ?? "",
  };
}

export function updateDraftItem(
  draft: OutcomeDraft,
  index: number,
  patch: Partial<Pick<OutcomeDraftItem, "selected" | "title" | "npcId">>,
): OutcomeDraft {
  return {
    ...draft,
    items: draft.items.map((item) => (item.index === index ? { ...item, ...patch } : item)),
  };
}

export function draftToRegistration(draft: OutcomeDraft): OutcomeRegistration {
  const kept = draft.items.filter((item) => item.selected && item.title.trim());
  const keptIndexes = new Set(kept.map((item) => item.index));
  const name = draft.subprojectName.trim();
  const slug = tenantSlugFromName(name);
  return {
    tenant: slug ? { slug, name } : null,
    items: kept.map((item) => ({
      index: item.index,
      title: item.title.trim(),
      npcId: item.npcId,
      // Waiting on an item excluded from selection would leave that card unable to ever start.
      after: item.after.filter((target) => keptIndexes.has(target)),
    })),
  };
}
