/**
 * Whether this channel's gateway is **reachable right now**, as last seen by the automation poller.
 *
 * The header's "AI connection" badge only knows the channel is bound, and `npc:working` freezes at its last
 * value when the event stream stops — so a dead gateway looked like a calm office. The poller already talks to
 * the gateway every tick (5s active / 60s idle); this folds that tick's outcome into four states and
 * broadcasts `gateway:health` **only when the state changes**. A joining socket gets the current value once.
 *
 * Process memory only, like `npc:working`: after a restart the state is `unknown` until the first tick.
 */

import type { PollOutcome } from "./automation-poller";

export const GATEWAY_HEALTH_EVENT = "gateway:health" as const;

export type GatewayHealthState = "ok" | "unreachable" | "unauthorized" | "unknown";

export type GatewayHealthPayload = {
  state: GatewayHealthState;
  /** Epoch ms when this state began. */
  since: number;
};

/** Poll failures that say nothing about reachability — the channel has no usable gateway, or a gate refused. */
const NOT_A_REACHABILITY_SIGNAL: ReadonlySet<string> = new Set([
  "unbound",
  "gateway_not_bound",
  "channel_not_found",
  "no_board",
  "plugin_absent",
  "plugin_upgrade_required",
  "plugin_unknown",
]);

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["unreachable", "timeout"]);

/** The gate's own code for a rejected owner key (`gate-error-status.ts`), besides a raw 401 from a board poll. */
const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(["plugin_unauthorized"]);

/**
 * One tick's outcome → state, or null to leave the state as it was.
 *
 * A tick that polls several boards counts as reachable if **any** board answered — one broken board is a board
 * problem, not an unreachable gateway.
 */
export function healthFromPollOutcome(outcome: PollOutcome): GatewayHealthState | null {
  if (outcome.ok) return "ok";
  const boards = outcome.boards ?? [];
  if (boards.some((board) => board.ok)) return "ok";
  const failures = boards.length > 0 ? boards.filter((board) => !board.ok) : [outcome];
  const first = failures[0] as { code: string; status?: number };
  if (
    failures.some(
      (f) => (f as { status?: number }).status === 401 || UNAUTHORIZED_CODES.has(f.code),
    )
  )
    return "unauthorized";
  if (UNREACHABLE_CODES.has(first.code)) return "unreachable";
  if (NOT_A_REACHABILITY_SIGNAL.has(first.code)) return null;
  return "unknown";
}

type Emit = (channelId: string, event: string, payload: unknown) => void;

export type GatewayHealthStore = Map<string, GatewayHealthPayload>;

const defaultStore: GatewayHealthStore = new Map();

/** Records a tick's state and broadcasts only on change. */
export function recordGatewayHealth(
  channelId: string,
  state: GatewayHealthState | null,
  emit: Emit,
  now: number = Date.now(),
  store: GatewayHealthStore = defaultStore,
): void {
  if (state === null) return;
  const previous = store.get(channelId);
  if (previous?.state === state) return;
  const payload: GatewayHealthPayload = { state, since: now };
  store.set(channelId, payload);
  emit(channelId, GATEWAY_HEALTH_EVENT, payload);
}

/** The current value for a joining socket, or null before the first tick. */
export function getGatewayHealth(
  channelId: string,
  store: GatewayHealthStore = defaultStore,
): GatewayHealthPayload | null {
  return store.get(channelId) ?? null;
}

/** For tests — simulates a process restart. */
export function resetGatewayHealthForTests(store: GatewayHealthStore = defaultStore): void {
  store.clear();
}
