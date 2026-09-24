/**
 * State for the artifact entry points — the artifacts modal (open, close, events) and the "결과물 저장됨" chip in NPC conversations.
 * GamePageClient folds the socket `artifact:event` into this. Pure functions without a screen, so pinned separately.
 */

import type { SourceTarget } from "@/components/artifacts/artifact-view-model";

export type ArtifactSocketEvent = {
  channelId?: string;
  event?: {
    kind?: string;
    payload?: {
      artifact_id?: string;
      title?: string;
      profile?: string;
      source_kind?: string;
    };
  };
};

export type ArtifactsModalState = {
  show: boolean;
  /** Number of events received while the modal is open — when it rises the modal rereads with a debounce. */
  refreshTick: number;
  /** The last event received while the modal is open (for reflecting deletes and new versions). */
  lastEvent: { kind: string; artifactId: string } | null;
  initial: { artifactId?: string; taskId?: string } | null;
  /** An event count that keeps rising regardless of whether the modal is open — the signal for kanban cards' artifact section to reread. */
  eventSeq: number;
};

export type ArtifactsModalAction =
  | { type: "open"; initial?: { artifactId?: string; taskId?: string } }
  | { type: "close" }
  | { type: "event"; kind?: string; artifactId?: string };

export const INITIAL_ARTIFACTS_MODAL: ArtifactsModalState = {
  show: false,
  refreshTick: 0,
  lastEvent: null,
  initial: null,
  eventSeq: 0,
};

/**
 * The modal mounts fresh and reads from scratch every time it opens. So opening and closing clears tick and the last event,
 * and events while closed are not accumulated on the modal side — so a new modal does not replay old events or do a
 * pointless debounced reread right after mounting.
 */
export function reduceArtifactsModal(
  state: ArtifactsModalState,
  action: ArtifactsModalAction,
): ArtifactsModalState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        show: true,
        initial: action.initial ?? null,
        refreshTick: 0,
        lastEvent: null,
      };
    case "close":
      return { ...state, show: false, initial: null, refreshTick: 0, lastEvent: null };
    case "event": {
      const eventSeq = state.eventSeq + 1;
      if (!state.show) return { ...state, eventSeq };
      return {
        ...state,
        eventSeq,
        refreshTick: state.refreshTick + 1,
        lastEvent:
          action.kind && action.artifactId
            ? { kind: action.kind, artifactId: action.artifactId }
            : state.lastEvent,
      };
    }
  }
}

export type ArtifactChip = { artifactId: string; title: string };

/**
 * Add a chip when an artifact was saved in the open NPC conversation. Only when it is `artifact.created|versioned`, the origin is
 * chat, and the profile belongs to the NPC currently in conversation — the same artifact only once (a new version only updates the title).
 */
export function nextArtifactChips(
  prev: ArtifactChip[],
  data: ArtifactSocketEvent,
  openProfile: string | null | undefined,
): ArtifactChip[] {
  const kind = data.event?.kind;
  const payload = data.event?.payload;
  if (kind !== "artifact.created" && kind !== "artifact.versioned") return prev;
  if (!payload?.artifact_id || payload.source_kind !== "chat") return prev;
  if (!openProfile || payload.profile !== openProfile) return prev;
  const title = payload.title || payload.artifact_id;
  const index = prev.findIndex((chip) => chip.artifactId === payload.artifact_id);
  if (index === -1) return [...prev, { artifactId: payload.artifact_id, title }];
  if (prev[index].title === title) return prev;
  return prev.map((chip, i) => (i === index ? { ...chip, title } : chip));
}

/**
 * A request to kanban to "expand this card". Even if the board is already open, a rising `seq` makes the board change its selection
 * — requesting the same card again (even if the user opened another card meanwhile) becomes a new request.
 */
export type KanbanFocusRequest = { taskId: string; seq: number };

export function nextKanbanFocus(
  prev: KanbanFocusRequest | null,
  taskId: string,
): KanbanFocusRequest {
  return { taskId, seq: (prev?.seq ?? 0) + 1 };
}

export type SourceNavigation = {
  closeKanban: boolean;
  closeCron: boolean;
  open:
    | { type: "chat"; npcId: string; npcName: string }
    | { type: "kanban"; taskId: string }
    | { type: "cron"; jobId: string | null };
};

/**
 * The artifact viewer's "go to source". The artifacts modal is always closed (left as is when null), and other modals covering
 * the destination are closed too — the dialog sits under kanban (z-50) and cron, and when kanban and cron overlap
 * one Escape closes both. If the channel has no NPC for that profile (fired, etc.) there is nowhere to go: null.
 */
export function planSourceNavigation(
  target: SourceTarget,
  npcs: ReadonlyArray<{ id: string; name: string; profileName: string | null | undefined }>,
): SourceNavigation | null {
  if (target.type === "chat") {
    const npc = npcs.find((n) => n.profileName === target.profile);
    if (!npc) return null;
    return {
      closeKanban: true,
      closeCron: true,
      open: { type: "chat", npcId: npc.id, npcName: npc.name },
    };
  }
  if (target.type === "kanban") {
    return { closeKanban: false, closeCron: true, open: { type: "kanban", taskId: target.taskId } };
  }
  return { closeKanban: true, closeCron: false, open: { type: "cron", jobId: target.jobId } };
}
