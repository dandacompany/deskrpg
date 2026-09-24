/**
 * Automation hook registry — the boundary between the Next app code and the socket server (`src/server/*`).
 *
 * API routes (`src/app/**`) and their body (`src/lib/**`) only ever look at **this file**. When
 * the socket server comes up (`startAutomationPollers`), it plugs the real implementation into
 * `globalThis`, and routes read whatever is plugged in. Same pattern as `rpc-registry.ts`.
 *
 * Why it isn't imported directly: `@/server/automation-poller` drags in `socket-handlers.ts`,
 * and that file's `.js`-extension relative imports are meant for the tsx runtime, which breaks
 * the Next/Turbopack bundle build with "Module not found." This boundary is guarded by
 * `app-server-boundary.test.ts`.
 *
 * If nothing is plugged in (tests, early CLI, or the poller failed to start), everything is
 * silently a no-op — same promise as R24 that a polling failure never leaks into a REST response.
 */

/** Same shape as `NpcWorkingPayload` in `src/server/automation-events.ts`. Redeclared here to avoid importing the server module. */
export type AutomationWorkingPayload = {
  npcId: string;
  working: boolean;
  sources: { runningCards: number; cronRuns: number };
};

export type AutomationHooks = {
  /** Immediate poll right after an action (R24). null if there's no poller. Result shape is `PollOutcome` from `automation-poller.ts`. */
  pollNow(channelId: string): Promise<unknown>;
  /** Re-reads the poller table when a binding is created or released. */
  refreshPollers(): Promise<void>;
  /** A snapshot of NPCs currently "working" (R27). */
  getWorkingSnapshot(channelId: string): AutomationWorkingPayload[];
  /**
   * Broadcasts an already-stored room message to that room.
   *
   * Notices generated inside DeskRPG (approval requests, etc.) aren't Hermes events, so they
   * can't ride the event sink. The row is written by `appendRoomMessage`; this hook **only
   * broadcasts** — if the hook is missing, it silently passes through, but the row is already in
   * the DB so it appears when the user opens the room.
   */
  emitRoomMessage(roomId: string, message: unknown): void;
};

const KEY = "__deskrpg_automation_hooks__";
const g = globalThis as typeof globalThis & Record<string, AutomationHooks | undefined>;

export function registerAutomationHooks(hooks: AutomationHooks): void {
  g[KEY] = hooks;
}

export function unregisterAutomationHooks(): void {
  g[KEY] = undefined;
}

export function getAutomationHooks(): AutomationHooks | undefined {
  const hooks = g[KEY];
  return hooks && typeof hooks === "object" ? hooks : undefined;
}

/** Requests an immediate poll. Resolves to null if there's no hook — same as what the old `pollNow` did with no poller. */
export function requestPollNow(channelId: string): Promise<unknown> {
  const hooks = getAutomationHooks();
  return hooks ? hooks.pollNow(channelId) : Promise.resolve(null);
}

export function requestRefreshPollers(): Promise<void> {
  const hooks = getAutomationHooks();
  return hooks ? hooks.refreshPollers() : Promise.resolve();
}

export function readWorkingSnapshot(channelId: string): AutomationWorkingPayload[] {
  const hooks = getAutomationHooks();
  return hooks ? hooks.getWorkingSnapshot(channelId) : [];
}

/**
 * Broadcasts a stored room message. A silent no-op if there's no hook — **a broadcast failure
 * must never fail the action that produced the notice (e.g. creating an approval).** A notice
 * showing up late and an approval failing to be created are not the same weight.
 */
export function requestEmitRoomMessage(roomId: string, message: unknown): void {
  const hooks = getAutomationHooks();
  if (!hooks) return;
  try {
    hooks.emitRoomMessage(roomId, message);
  } catch {
    // The caller keeps going even if the socket broadcast breaks.
  }
}

/** Test-only — clears the plugged-in hooks. */
export function resetAutomationHooksForTests(): void {
  unregisterAutomationHooks();
}
