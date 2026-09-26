/** Frontend-only presentation boundary. World positions remain server pixel coordinates. */
import type { MapObject } from "../../lib/object-types";
import type { MeetingSpace } from "../meeting-space";
import type { NpcStateKind } from "../../lib/npc-state-map";
export const PIXELS_PER_TILE = 32;
export type ActorSnapshot = {
  id: string;
  userId?: string;
  name: string;
  kind: "player" | "npc" | "remote";
  x: number;
  y: number;
  direction: string;
  walking: boolean;
  /** The source of look definitions (`officeLookId`). The renderer decides colors only from this. */
  appearance?: unknown;
  bubble?: string;
  active?: boolean;
  /** Optional explicit response state; attention bubbles are not streamed responses. */
  phase?: "idle" | "queued" | "thinking" | "streaming" | "done" | "attention";
  /** A kanban card run or cron run is in progress (R27). Drawn only when there is no conversation response indicator. */
  working?: boolean;
  /** The number in progress (cards + cron). A number is attached to the badge only when 2 or more. */
  workingCount?: number;
  /**
   * Every state that applies, most urgent first (D08 `npcStates`). When present it decides the indicator; when
   * absent (players, older callers) the phase/working rule below applies as before.
   */
  states?: readonly NpcStateKind[];
  /** The first state in words, for the tag's tooltip and screen readers (the renderer has no translator). */
  stateLabel?: string;
};
export type MapSnapshot = {
  meetingSpace?: MeetingSpace;
  cols: number;
  rows: number;
  floor: number[][];
  walls: number[][];
  blocked: string[];
  objects: MapObject[];
  tiled: boolean;
  /** Validated office-template metadata, independent of actor appearance. */
  environment?: string;
  /** Optional persisted template version used for backwards-compatible presentation. */
  environmentVersion?: number;
};
/** The game screen's mode. There is no tile editing entry point — only NPC placement and start position selection. */
export type EditorSnapshot = {
  placement: boolean;
  spawn: boolean;
  owner: boolean;
  tiled: boolean;
  /** Filled only in seat change mode — desk seat numbers and occupancy. */
  seatLabels: Array<{ number: number; col: number; row: number; taken: boolean }>;
};
export interface OfficeBridge {
  actors(): ActorSnapshot[];
  mapKey(): string;
  map(): MapSnapshot;
  editor(): EditorSnapshot;
  pointer(
    kind: "move" | "down",
    x: number,
    y: number,
    button: number,
    screenX: number,
    screenY: number,
    actorId?: string,
  ): void;
  walkable(col: number, row: number): boolean;
  /** Includes authoritative reservations that may not have reached the chair yet. */
  seatAvailable?(x: number, z: number): boolean;
  /** Server-pixel reservation ID for the player's current or approaching seat. */
  seatIntent?(): string | null;
  /** Announced when the renderer attaches and detaches. The simulation without a screen has nothing to draw and may ignore it. */
  setPresentation(active: boolean): void;
}
export function pixelToWorld(x: number, y: number) {
  return { x: x / PIXELS_PER_TILE, z: y / PIXELS_PER_TILE };
}
export function worldToPixel(x: number, z: number) {
  return { x: x * PIXELS_PER_TILE, y: z * PIXELS_PER_TILE };
}
/** Exact model/name-label targets take precedence over the legacy proximity fallback. */
export function matchesNpcTarget(
  npc: { id: string; x: number; y: number },
  click: { x: number; y: number; actorId?: string },
) {
  return click.actorId !== undefined
    ? npc.id === click.actorId
    : Math.hypot(npc.x - click.x, npc.y - click.y) < 48;
}

export function overviewDistance(cols: number, rows: number, aspect: number, fovDegrees = 38) {
  const halfVertical = (fovDegrees * Math.PI) / 360;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.1, aspect));
  return (Math.hypot(cols, rows) / 2 / Math.sin(Math.min(halfVertical, halfHorizontal))) * 1.1;
}

/** Preserve server/UI response state without guessing streaming from a report bubble. */
export function actorPresentationPhase(actor: Pick<ActorSnapshot, "phase" | "active" | "bubble">) {
  return actor.phase ?? (actor.active ? "thinking" : actor.bubble ? "attention" : "idle");
}

export type ActorIndicator =
  | "unknown"
  | "awaiting_approval"
  | "stopped_after_failures"
  | "response_failed"
  | "queued"
  | "thinking"
  | "streaming"
  | "working"
  | null;

/**
 * One indicator next to the name tag (R27). The conversation response (queued/thinking/streaming) takes priority, and only without it
 * "working" — both are drawn in the same spot, so they do not overlap.
 */
export function actorIndicator(
  actor: Pick<ActorSnapshot, "phase" | "active" | "bubble" | "working" | "states">,
): ActorIndicator {
  if (actor.states) {
    const first = actor.states[0];
    if (!first || first === "reporting") return null;
    if (first === "responding") {
      const phase = actorPresentationPhase(actor);
      return phase === "queued" || phase === "streaming" ? phase : "thinking";
    }
    return first;
  }
  const phase = actorPresentationPhase(actor);
  if (phase === "queued" || phase === "thinking" || phase === "streaming") return phase;
  return actor.working ? "working" : null;
}

/**
 * The number next to the indicator. Attached **only when 2 or more** — for 1 the badge itself already says it,
 * so a number only adds noise. One employee can run several cards (the per-profile limit is unlimited by default),
 * yet until now the screen showed that as one card.
 */
export function indicatorCountLabel(
  indicator: ActorIndicator,
  actor: Pick<ActorSnapshot, "workingCount">,
): string {
  if (indicator !== "working") return "";
  const count = actor.workingCount ?? 0;
  return count >= 2 ? String(count) : "";
}

/**
 * Nothing about this employee can be known right now (gateway unreachable, or this screen offline). The tag is
 * dimmed so the last known pose and bubble aren't read as the current state.
 */
export function actorStateUnknown(actor: Pick<ActorSnapshot, "states">): boolean {
  return actor.states?.[0] === "unknown";
}

/** Chat messages use user IDs; scene player IDs use socket IDs. Never match names. */
export function speechActorId(actors: Pick<ActorSnapshot, "id" | "userId">[], senderId: string) {
  return (
    actors.find((actor) => actor.id === senderId)?.id ??
    actors.find((actor) => actor.userId === senderId)?.id ??
    senderId
  );
}
