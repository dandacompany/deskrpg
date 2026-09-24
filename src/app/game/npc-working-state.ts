/**
 * The map's "working" state (R27) — folds the channel socket's `npc:working` per NPC.
 *
 * The server (`automation-events.ts`) fires only when the value changes, and on connect (`player:join`) it gives a snapshot of only
 * the NPCs working now. So the client's default is "not working", and `working:false`
 * removes the entry. There are no optimistic updates (R26) — this map holds only what the server said.
 *
 * It imports no server modules — the client bundle boundary (`client-bundle-boundary.test.ts`).
 */

export type NpcWorkingPayload = {
  npcId: string;
  working: boolean;
  sources: { runningCards: number; cronRuns: number };
};

export type NpcWorkingMap = Readonly<Record<string, NpcWorkingPayload>>;

export const EMPTY_NPC_WORKING: NpcWorkingMap = Object.freeze({});

/** null if it is not a payload shape — values from the socket are not trusted as is. */
export function parseNpcWorkingPayload(raw: unknown): NpcWorkingPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<NpcWorkingPayload>;
  if (typeof p.npcId !== "string" || !p.npcId || typeof p.working !== "boolean") return null;
  const sources = p.sources && typeof p.sources === "object" ? p.sources : null;
  return {
    npcId: p.npcId,
    working: p.working,
    sources: {
      runningCards: typeof sources?.runningCards === "number" ? sources.runningCards : 0,
      cronRuns: typeof sources?.cronRuns === "number" ? sources.cronRuns : 0,
    },
  };
}

/** Fold one payload. If nothing changed, return the same object to save a render. */
export function reduceNpcWorking(map: NpcWorkingMap, payload: NpcWorkingPayload): NpcWorkingMap {
  const current = map[payload.npcId];
  if (!payload.working) {
    if (!current) return map;
    const next = { ...map };
    delete next[payload.npcId];
    return next;
  }
  if (
    current &&
    current.sources.runningCards === payload.sources.runningCards &&
    current.sources.cronRuns === payload.sources.cronRuns
  )
    return map;
  return { ...map, [payload.npcId]: payload };
}

/** The ids of NPCs working now — the form handed to the map simulation. */
export function workingNpcIds(map: NpcWorkingMap): string[] {
  return Object.keys(map).filter((id) => map[id].working);
}

/**
 * **How many items** each NPC is running (cards + cron).
 *
 * The server already sends this number as `sources`, but the map folded it into an id list, so an employee running two
 * cards looked like one on screen. Hermes's per-profile concurrency limit is unlimited unless configured
 * (`kanban_db_dispatch.py`), so two or more is not unusual.
 */
export function workingNpcCounts(map: NpcWorkingMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, payload] of Object.entries(map)) {
    if (!payload.working) continue;
    out[id] = payload.sources.runningCards + payload.sources.cronRuns;
  }
  return out;
}
