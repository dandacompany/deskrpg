/**
 * What an employee is doing, as one ordered list — the D08 state map.
 *
 * Several things can be true at once (running two cards while a tool approval waits). The list keeps all of
 * them for the navigator; the 3D name tag shows only the first. The order is **what a person should know
 * first**: that we can't know at all, then what waits on a person, then what is merely happening.
 *
 * A card that failed once and is being retried by itself is not here — nobody has anything to do about it,
 * and the card detail already says it will retry (D05).
 *
 * Pure and dependency-free — safe for the client bundle and shared with the renderer.
 */

export type NpcStateKind =
  | "unknown"
  | "awaiting_approval"
  | "stopped_after_failures"
  | "response_failed"
  | "responding"
  | "working"
  | "reporting";

/** Priority order; lower index wins the name tag. */
export const NPC_STATE_PRIORITY: readonly NpcStateKind[] = [
  "unknown",
  "awaiting_approval",
  "stopped_after_failures",
  "response_failed",
  "responding",
  "working",
  "reporting",
];

/**
 * Whether we can see the gateway right now: the poller's last verdict (`gateway:health`) or, while this
 * screen's own socket is down, `socket_down`. Null before the first verdict — that is not shown as unknown,
 * or every page load would flash grey.
 */
export type NpcConnection =
  "ok" | "unreachable" | "unauthorized" | "unknown" | "socket_down" | null;

export type NpcStateInput = {
  connection: NpcConnection;
  /** Pending tool approvals for this employee plus cards this employee submitted for approval. */
  approvals: number;
  /** This employee's cards blocked after failing in a row. */
  failedCards: number;
  responseFailed: boolean;
  responding: boolean;
  workingCount: number;
  reporting: boolean;
};

export function isConnectionUnknown(connection: NpcConnection): boolean {
  return connection !== null && connection !== "ok";
}

/**
 * Every state that applies, in priority order.
 *
 * While the connection is unknown, the live states (`responding`, `working`, `reporting`) are dropped: they
 * come from a stream that has stopped, so they are the last known value, not the current one. States that wait
 * on a person stay — the approval or the blocked card is still there when the gateway comes back.
 */
export function npcStates(input: NpcStateInput): NpcStateKind[] {
  const unknown = isConnectionUnknown(input.connection);
  const present: Record<NpcStateKind, boolean> = {
    unknown,
    awaiting_approval: input.approvals > 0,
    stopped_after_failures: input.failedCards > 0,
    response_failed: input.responseFailed,
    responding: !unknown && input.responding,
    working: !unknown && input.workingCount > 0,
    reporting: !unknown && input.reporting,
  };
  return NPC_STATE_PRIORITY.filter((kind) => present[kind]);
}

/** The one state the name tag shows, or null for an idle employee. */
export function primaryNpcState(input: NpcStateInput): NpcStateKind | null {
  return npcStates(input)[0] ?? null;
}
