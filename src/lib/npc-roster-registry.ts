/**
 * NPC roster hook — how lib code that seats employees (hiring, quick start, clocking in) tells the
 * socket server, without importing it, that a channel's map gained NPCs. Same boundary as
 * `automation-registry.ts`: the socket server plugs the implementation into `globalThis` at
 * startup; with nothing plugged in (tests, CLI, a Next-only process) the call is a no-op.
 */

export type NpcsPlacedNotifier = (channelId: string, npcIds: string[]) => void;

const KEY = "__deskrpg_npc_roster_notifier__";
const g = globalThis as typeof globalThis & Record<string, NpcsPlacedNotifier | undefined>;

export function registerNpcsPlacedNotifier(notify: NpcsPlacedNotifier | undefined): void {
  g[KEY] = notify;
}

/** Newly seated NPCs of a channel. Never throws — a failed broadcast must not fail the hire. */
export function notifyNpcsPlaced(channelId: string, npcIds: string[]): void {
  const notify = g[KEY];
  if (typeof notify !== "function" || npcIds.length === 0) return;
  try {
    notify(channelId, npcIds);
  } catch (err) {
    console.error("[roster] placement broadcast failed", { channelId, err });
  }
}
