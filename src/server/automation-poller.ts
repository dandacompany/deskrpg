/**
 * Automation event poller (T5, R23·R24·E6·E7).
 *
 * For each bound channel, periodically reads the plugin's change list (`/deskrpg/events?board=…&cursor=…`) and
 * hands it to the event sink `ingest()`. The browser never calls Hermes directly (R26) — this poller is the
 * only thing inside the server that pulls events.
 *
 * - The baseline token lives per channel (+gateway) in `channel_kanban_boards.event_cursor`.
 *   Without a token (first connection, gateway swap) it calls without a cursor, takes only the "now" token and
 *   **does not replay the past** (R23). If the plugin returns 400 `unknown_cursor`, it restarts the same way
 *   (E7).
 * - Interval: short when the channel has connected sockets (default 5s), long otherwise (default 60s). Right
 *   after an on-screen action, `pollNow(channelId)` runs once immediately (R24).
 * - Failures are not thrown but recorded in `last_error`. On success it clears it to null and stamps
 *   `last_polled_at` (E6).
 * - A failed board ensure (`board_name_synced_at` never stamped) is retried every tick — once the plugin is
 *   installed, the next tick creates the board (R5). If name sync failed after a channel rename
 *   (`board_name_synced_at` earlier than the channel's `updated_at`), a tick that passes the gate re-syncs it
 *   once (R2).
 * - Every timer is `unref()` — they don't hold the test runner or CLI exit.
 *
 * The pure single tick (`pollChannelOnce`) is kept separate from the timer registry (`createAutomationPoller`).
 * Tests call the former directly; the server uses the process-global instance of the latter.
 */

import { withChannelAutomationLock } from "@/lib/channel-automation-lock";
import { EventCarrierError, recoverEventCarrierHandoff } from "@/lib/event-carrier-handoff";
import { eq } from "drizzle-orm";
import type { Server } from "socket.io";

import { channelGatewayBindings, channelKanbanBoards, channels, db, nowForDb } from "@/db";
import { registerAutomationHooks, unregisterAutomationHooks } from "@/lib/automation-registry";
import type { PluginEvent } from "@/lib/hermes/deskrpg-plugin-types";
import {
  ensureChannelBoard,
  ensureChannelCarrier,
  listChannelBoards,
  resolveChannelBoard,
  syncBoardName,
  type ChannelBoardRow,
  type ResolvedChannelBoard,
} from "@/lib/kanban-boards";
import type { RoomMessage } from "@/lib/chat-rooms-policy";
import { broadcastRoomMessage } from "./room-socket";
import {
  createLiveIngestDeps,
  getWorkingSnapshot,
  ingest,
  type IngestDeps,
} from "./automation-events";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const POLL_DEFAULTS = {
  /** When the channel has connected sockets */
  activeMs: envInt("AUTOMATION_POLL_ACTIVE_MS", 5_000),
  /** When nobody is there */
  idleMs: envInt("AUTOMATION_POLL_IDLE_MS", 60_000),
  /** Number of events to fetch per page */
  pageLimit: envInt("AUTOMATION_POLL_PAGE_LIMIT", 200),
  /** Cap on pages followed via `has_more` — keeps one tick from growing unbounded */
  maxPages: envInt("AUTOMATION_POLL_MAX_PAGES", 10),
} as const;

// ---------------------------------------------------------------------------
// Single tick
// ---------------------------------------------------------------------------

export type PollOnceDeps = {
  resolveBoard: typeof resolveChannelBoard;
  ensureBoard: typeof ensureChannelBoard;
  /** **All** boards attached to the channel. Each board has its own cursor, so one tick covers them all. */
  readRows: typeof listChannelBoards;
  /** Revives a channel whose carrier count dropped to 0 — self-healing by the reader. */
  ensureCarrier: typeof ensureChannelCarrier;
  /** Re-establishes "working" from the board after a restart. Once per channel per process lifetime. */
  resyncWorking(
    channelId: string,
    rows: ChannelBoardRow[],
    resolved: Extract<ResolvedChannelBoard, { ok: true }>,
    deps: PollOnceDeps,
  ): Promise<void>;
  /** Channel name and last modified time — to judge whether the board name sync is lagging (R2). */
  readChannel(channelId: string): Promise<{ name: string; updatedAt: Date | string | null } | null>;
  syncBoardName: typeof syncBoardName;
  /** Writes by **binding row id**. Writing by channel_id would overwrite the other boards' cursors too. */
  saveRow(
    boardLinkId: string,
    patch: { eventCursor?: string; lastError: string | null },
  ): Promise<void>;
  makeIngestDeps(ctx: { channelId: string; gatewayId: string; boardSlug: string }): IngestDeps;
  ingest: typeof ingest;
  pageLimit: number;
  maxPages: number;
};

/** Result for one board. */
export type BoardPollOutcome =
  | {
      ok: true;
      boardSlug: string;
      events: number;
      pages: number;
      cursor: string;
      restarted: boolean;
    }
  | { ok: false; boardSlug: string; code: string; reason: string };

/**
 * Result of one channel tick. `events` is the sum over boards and `cursor` is the **event-receiving board**'s —
 * so callers expecting a per-channel result keep their meaning. Per-board results are in `boards`.
 */
export type PollOutcome =
  | {
      ok: true;
      events: number;
      pages: number;
      cursor: string;
      restarted: boolean;
      boards?: BoardPollOutcome[];
    }
  | { ok: false; code: string; reason: string; boards?: BoardPollOutcome[] };

async function saveBoardRow(
  boardLinkId: string,
  patch: { eventCursor?: string; lastError: string | null },
) {
  const now = nowForDb();
  await db
    .update(channelKanbanBoards)
    .set({
      ...(patch.eventCursor === undefined ? {} : { eventCursor: patch.eventCursor }),
      lastError: patch.lastError,
      lastPolledAt: now,
      updatedAt: now,
    })
    .where(eq(channelKanbanBoards.id, boardLinkId));
}

async function readChannelNameAndUpdatedAt(
  channelId: string,
): Promise<{ name: string; updatedAt: Date | string | null } | null> {
  const [row] = await db
    .select({ name: channels.name, updatedAt: channels.updatedAt })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return row ? { name: row.name, updatedAt: row.updatedAt } : null;
}

/** SQLite gives an ISO string, PostgreSQL a Date — both to milliseconds. null if unreadable. */
function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether the board name lags the channel name — true if the sync time is missing or earlier than the channel's
 * `updated_at`. If the channel's `updated_at` is unknown (old row), it's considered in sync as long as a sync
 * time exists.
 */
export function boardNameStale(
  row: Pick<ChannelBoardRow, "boardNameSyncedAt">,
  channelUpdatedAt: Date | string | null,
): boolean {
  const synced = toMillis(row.boardNameSyncedAt);
  if (synced === null) return true;
  const updated = toMillis(channelUpdatedAt);
  return updated !== null && synced < updated;
}

export function createDefaultPollDeps(
  emit: Pick<IngestDeps, "emitChannel" | "emitRoomMessage">,
): PollOnceDeps {
  return {
    resolveBoard: resolveChannelBoard,
    ensureBoard: ensureChannelBoard,
    readRows: listChannelBoards,
    ensureCarrier: ensureChannelCarrier,
    resyncWorking: resyncWorkingFromBoards,
    readChannel: readChannelNameAndUpdatedAt,
    syncBoardName,
    saveRow: saveBoardRow,
    makeIngestDeps: (ctx) =>
      createLiveIngestDeps({
        gatewayId: ctx.gatewayId,
        boardSlug: ctx.boardSlug,
        emitChannel: emit.emitChannel,
        emitRoomMessage: emit.emitRoomMessage,
      }),
    ingest,
    pageLimit: POLL_DEFAULTS.pageLimit,
    maxPages: POLL_DEFAULTS.maxPages,
  };
}

/**
 * Polls one channel for one tick. Never throws — failures stay only in `last_error` and
 * the return value (E6).
 */
/**
 * Channels in this process whose "working" state has already been re-established.
 *
 * The condition must not be "if the channel state is empty" — `ingest` deletes the entry when work finishes
 * (`if (!payload.working) state.work.delete(npcId)` in `automation-events.ts`), so that condition is always true
 * even for idle channels, and a channel with nothing going on would query the board every tick.
 * The set dies with the process, so it runs exactly once per restart.
 *
 * **Only added on a tick that read the board successfully.** Restarts often coincide with deploys, so the gateway
 * may be briefly unreachable at the very moment this runs — marking before reading would mean the channel is never
 * retried for the process lifetime, silently failing in exactly the scenario re-establishing exists for.
 */
const resyncedChannels = new Set<string>();
/** Channels currently being re-established. Keeps two overlapping ticks of the same channel from creating the
 * synthetic event twice. */
const resyncInFlight = new Set<string>();

/** For tests — simulates the process lifetime boundary. */
export function resetWorkingResyncForTests(channelId?: string) {
  if (channelId === undefined) {
    resyncedChannels.clear();
    resyncInFlight.clear();
  } else {
    resyncedChannels.delete(channelId);
    resyncInFlight.delete(channelId);
  }
}

/**
 * Re-establishes "working" **from the board** after a restart (design 2026-09-21 npc-working-state, decision A-1).
 *
 * The source of truth for this state is process memory, so one restart wipes it, and the poller only reads past
 * the cursor, so a past `task.run.started` never arrives again — left alone, a card would be running while the
 * screen says "nobody is working". The board's `running` column still holds the assignee and start time, so
 * we rebuild from that.
 *
 * **`npc:working` is not emitted here.** To keep the invariant that only `ingest` broadcasts
 * (`src/server/AGENTS.md`), the cards read are turned into **synthetic events shaped like** `task.run.started`
 * and fed through the normal path. So dedup (`state.seen`) and diff broadcasting (`lastEmitted`) apply as usual,
 * and the **real** `task.run.finished` arriving later closes it with the same `task_id`.
 *
 * Event ids are deterministic — random ones would be rebroadcast every tick.
 */
async function resyncWorkingFromBoards(
  channelId: string,
  rows: ChannelBoardRow[],
  resolved: Extract<ResolvedChannelBoard, { ok: true }>,
  deps: PollOnceDeps,
): Promise<void> {
  if (resyncedChannels.has(channelId) || resyncInFlight.has(channelId)) return;
  resyncInFlight.add(channelId);
  try {
    let readAll = true;
    for (const row of rows) {
      const view = await resolved.ownerClient.kanban.getBoard(row.boardSlug, {
        includeArchived: false,
      });
      if (!view.ok) {
        // This tick ends in failure — don't mark it; retry on the next tick.
        readAll = false;
        continue;
      }
      const events: PluginEvent[] = [];
      for (const column of view.data.columns) {
        for (const task of column.tasks) {
          if (task.status !== "running" || !task.assignee) continue;
          events.push({
            id: `resync:${row.boardSlug}:${task.id}:${task.started_at ?? ""}`,
            ts: Math.floor(Date.now() / 1000),
            kind: "task.run.started",
            board: row.boardSlug,
            task_id: task.id,
            payload: { assignee: task.assignee, title: task.title },
          });
        }
      }
      if (events.length === 0) continue;
      const ingestDeps = deps.makeIngestDeps({
        channelId,
        gatewayId: resolved.binding.resource.id,
        boardSlug: row.boardSlug,
      });
      await deps.ingest(channelId, events, ingestDeps);
    }
    if (readAll) resyncedChannels.add(channelId);
  } finally {
    resyncInFlight.delete(channelId);
  }
}

/**
 * Polls one board for one tick. Never throws — failures stay only in `last_error` and the return value (E6).
 *
 * **Drops cron events unless this is the event-receiving board.** The plugin's `/deskrpg/events` hands out
 * cursors per board but always mixes in cron gateway-wide with no opt-out (`cron_tail` in `events.py`).
 * So polling N boards separately brings in the same cron event N times. Artifacts can be excluded via `include`,
 * but cron can only be filtered here. Dropped events have been or will be received by the event-receiving board.
 */
async function pollBoardOnce(
  channelId: string,
  row: ChannelBoardRow,
  resolved: Extract<ResolvedChannelBoard, { ok: true }>,
  deps: PollOnceDeps,
): Promise<BoardPollOutcome> {
  const boardSlug = row.boardSlug;
  const gatewayId = resolved.binding.resource.id;
  const ingestDeps = deps.makeIngestDeps({ channelId, gatewayId, boardSlug });
  let cursor: string | null = row.eventCursor;
  let restarted = false;
  let pages = 0;
  let events = 0;
  const errors: string[] = [];

  while (pages < deps.maxPages) {
    pages += 1;
    const res = await resolved.ownerClient.events.poll({
      board: boardSlug,
      cursor: cursor ?? undefined,
      limit: deps.pageLimit,
      // Artifacts are gateway-wide, so only the event-receiving board takes them.
      // Proposal events come from the same `artifact_events` table and the same cursor (`a`) as artifacts, so **the
      // two tokens are always enabled together** — enabling only `artifacts` would advance the cursor while reading
      // artifacts and the proposals in between would never arrive, with no error or log. Proposals are also
      // gateway-wide (no board/channel column), so they're attached only to the receiving board.
      // Older plugins ignore unknown tokens, so no version/capability branching is needed.
      ...(row.isEventCarrier ? { include: "artifacts,card_proposals" } : {}),
    });

    if (!res.ok) {
      // E7. If the plugin doesn't know the cursor, restart from "now" — no replay.
      if (res.failure.code === "unknown_cursor" && cursor !== null) {
        cursor = null;
        restarted = true;
        continue;
      }
      await deps.saveRow(row.id, { lastError: res.failure.code });
      return { ok: false, boardSlug, code: res.failure.code, reason: res.failure.message };
    }

    if (cursor === null) {
      // A response to a cursor-less call only gives the token. Even if events come along, don't replay them (R23).
      cursor = res.data.cursor;
      break;
    }

    cursor = res.data.cursor;
    const usable = row.isEventCarrier
      ? res.data.events
      : res.data.events.filter((event: { kind: string }) => !event.kind.startsWith("cron."));
    if (usable.length > 0) {
      const outcome = await deps.ingest(channelId, usable, ingestDeps);
      events += outcome.processed;
      errors.push(...outcome.errors);
    }
    if (!res.data.has_more) break;
  }

  if (cursor === null) {
    // unknown_cursor hit on the last tick of the page cap — it ended without a token, so the next tick refetches.
    await deps.saveRow(row.id, { lastError: "cursor_unresolved" });
    return {
      ok: false,
      boardSlug,
      code: "cursor_unresolved",
      reason: "page cap reached before a token",
    };
  }
  await deps.saveRow(row.id, {
    eventCursor: cursor,
    lastError: errors.length > 0 ? `ingest_error: ${errors[0]}` : null,
  });
  return { ok: true, boardSlug, events, pages, cursor, restarted };
}

/**
 * Polls one channel for one tick — goes through **every board** attached to the channel. Never throws
 * (E6). The gate and owner client are created only once per channel.
 */
export async function pollChannelOnce(channelId: string, deps: PollOnceDeps): Promise<PollOutcome> {
  return withChannelAutomationLock(channelId, () => pollChannelOnceUnlocked(channelId, deps));
}

async function pollChannelOnceUnlocked(
  channelId: string,
  deps: PollOnceDeps,
): Promise<PollOutcome> {
  try {
    await recoverEventCarrierHandoff(channelId);
    const resolved = await deps.resolveBoard(channelId);
    if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason };
    const gatewayId = resolved.binding.resource.id;

    // If there's no binding row, the gateway changed, or the board has never been ensured (gate/create failure at
    // bind time — `board_name_synced_at` is empty), rebuild starting from the default board (R5).
    // Gate failures are recorded in `last_error` by `ensureBoard`, so they aren't written again here.
    let rows = await deps.readRows(channelId);
    const carrier = rows.find((row) => row.isEventCarrier) ?? rows[0];
    if (!carrier || carrier.gatewayId !== gatewayId || carrier.boardNameSyncedAt === null) {
      const ensured = await deps.ensureBoard(channelId, resolved);
      if (!ensured.ok) return { ok: false, code: ensured.code, reason: ensured.reason };
      rows = await deps.readRows(channelId);
    }

    if (!resolved.pluginGate.ok) {
      for (const row of rows) await deps.saveRow(row.id, { lastError: resolved.pluginGate.code });
      return { ok: false, code: resolved.pluginGate.code, reason: resolved.pluginGate.reason };
    }

    // If carriers dropped to 0, revive them here — otherwise nobody in this channel receives cron events.
    await deps.ensureCarrier(channelId);
    rows = await deps.readRows(channelId);

    // R2. If name sync failed after a channel rename and is still pending, re-sync once per tick. The channel name
    // belongs to the **event-receiving board** (= default board) — other boards have their own per-project names.
    let syncError: string | null = null;
    const channel = await deps.readChannel(channelId);
    const nameTarget = rows.find((row) => row.isEventCarrier);
    if (channel && nameTarget && boardNameStale(nameTarget, channel.updatedAt)) {
      const synced = await deps.syncBoardName(channelId, channel.name, resolved);
      if (!synced.ok) syncError = `board_name_sync: ${synced.code}`;
    }

    const boards: BoardPollOutcome[] = [];
    for (const row of rows) boards.push(await pollBoardOnce(channelId, row, resolved, deps));

    // Re-establish "working" after restart — runs **after polling is drained** (decision A-1).
    // Cursors persist in the DB, so the first poll after restart replays events from while it was down. Doing this
    // first would let a replayed `task.run.finished` **from a previous run** clear the same task_id as the synthetic
    // `started`, flipping a card that is actually running to "idle". Doing it after puts the facts as of that moment
    // last.
    await deps.resyncWorking(channelId, rows, resolved, deps);

    const carrierOutcome = boards.find((b) => b.boardSlug === nameTarget?.boardSlug) ?? boards[0];
    const failed = boards.find((b) => !b.ok);
    if (!carrierOutcome || (!carrierOutcome.ok && failed)) {
      const first = failed as Extract<BoardPollOutcome, { ok: false }> | undefined;
      return {
        ok: false,
        code: first?.code ?? "no_board",
        reason: first?.reason ?? "channel has no board row",
        boards,
      };
    }
    if (!carrierOutcome.ok) {
      return { ok: false, code: carrierOutcome.code, reason: carrierOutcome.reason, boards };
    }

    if (syncError) {
      await deps.saveRow(nameTarget?.id ?? "", { lastError: syncError }).catch(() => {});
    }
    return {
      ok: true,
      events: boards.reduce((sum, b) => sum + (b.ok ? b.events : 0), 0),
      pages: boards.reduce((sum, b) => sum + (b.ok ? b.pages : 0), 0),
      cursor: carrierOutcome.cursor,
      restarted: boards.some((b) => b.ok && b.restarted),
      boards,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[automation-poller] ${channelId} poll failed: ${reason}`);
    return {
      ok: false,
      code: err instanceof EventCarrierError ? err.code : "internal_error",
      reason,
    };
  }
}

// ---------------------------------------------------------------------------
// Timer registry
// ---------------------------------------------------------------------------

export type PollerRegistryDeps = {
  pollOnce(channelId: string): Promise<PollOutcome>;
  listBoundChannelIds(): Promise<string[]>;
  isChannelBound(channelId: string): Promise<boolean>;
  intervals: { activeMs: number; idleMs: number };
  /**
   * How to schedule a wait. Tests inject a fake clock to check intervals without actually waiting.
   * If omitted, the global timers are used.
   */
  timers?: PollerTimers;
};

export type PollerTimers = {
  setTimeout(handler: () => void, delayMs: number): PollerTimerHandle;
  clearTimeout(handle: PollerTimerHandle): void;
};

export type PollerTimerHandle = { unref?: () => void };

const systemTimers: PollerTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Entry = {
  timer: PollerTimerHandle | null;
  active: boolean;
  running: Promise<PollOutcome> | null;
  /** `pollNow` came in again while running — run once more when done. */
  again: boolean;
};

export type AutomationPoller = {
  start(channelId: string): void;
  stop(channelId: string): void;
  has(channelId: string): boolean;
  isActive(channelId: string): boolean;
  /** Changes the interval when connected-socket presence changes. Runs once immediately when switched on. */
  setActive(channelId: string, hasSockets: boolean): Promise<void>;
  /** One tick immediately. If already running, once more after it finishes. */
  pollNow(channelId: string): Promise<PollOutcome>;
  /** Rereads the binding table, starting new channels and stopping unbound ones. */
  refresh(): Promise<void>;
  stopAll(): void;
};

export function createAutomationPoller(deps: PollerRegistryDeps): AutomationPoller {
  const entries = new Map<string, Entry>();
  const timers = deps.timers ?? systemTimers;

  function schedule(channelId: string) {
    const entry = entries.get(channelId);
    if (!entry) return;
    if (entry.timer) timers.clearTimeout(entry.timer);
    const delay = entry.active ? deps.intervals.activeMs : deps.intervals.idleMs;
    entry.timer = timers.setTimeout(() => {
      entry.timer = null;
      void run(channelId);
    }, delay);
    entry.timer.unref?.();
  }

  function run(channelId: string): Promise<PollOutcome> {
    const entry = entries.get(channelId);
    if (!entry) return deps.pollOnce(channelId);
    if (entry.running) {
      entry.again = true;
      return entry.running;
    }
    if (entry.timer) {
      timers.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.running = deps
      .pollOnce(channelId)
      .catch((err): PollOutcome => ({
        ok: false,
        code: "internal_error",
        reason: err instanceof Error ? err.message : String(err),
      }))
      .then((outcome) => {
        entry.running = null;
        // An unbound channel stops ticking — if rebound, refresh/setActive revives it.
        if (!outcome.ok && outcome.code === "unbound") {
          poller.stop(channelId);
          return outcome;
        }
        if (entry.again) {
          entry.again = false;
          void run(channelId);
        } else {
          schedule(channelId);
        }
        return outcome;
      });
    return entry.running;
  }

  const poller: AutomationPoller = {
    start(channelId) {
      if (entries.has(channelId)) return;
      entries.set(channelId, { timer: null, active: false, running: null, again: false });
      schedule(channelId);
    },
    stop(channelId) {
      const entry = entries.get(channelId);
      if (!entry) return;
      if (entry.timer) timers.clearTimeout(entry.timer);
      entries.delete(channelId);
    },
    has: (channelId) => entries.has(channelId),
    isActive: (channelId) => entries.get(channelId)?.active ?? false,
    async setActive(channelId, hasSockets) {
      let entry = entries.get(channelId);
      if (!entry) {
        // It may be a channel bound after the server started — if the table shows it, start here.
        if (!hasSockets || !(await deps.isChannelBound(channelId))) return;
        poller.start(channelId);
        entry = entries.get(channelId)!;
      }
      if (entry.active === hasSockets) return;
      entry.active = hasSockets;
      if (hasSockets) void run(channelId);
      else schedule(channelId);
    },
    async pollNow(channelId) {
      if (!entries.has(channelId)) poller.start(channelId);
      return run(channelId);
    },
    async refresh() {
      const bound = new Set(await deps.listBoundChannelIds());
      for (const channelId of bound) poller.start(channelId);
      for (const channelId of [...entries.keys()]) {
        if (!bound.has(channelId)) poller.stop(channelId);
      }
    },
    stopAll() {
      for (const channelId of [...entries.keys()]) poller.stop(channelId);
    },
  };
  return poller;
}

// ---------------------------------------------------------------------------
// Process-global instance — the socket server starts it; REST routes and socket handlers call it.
// ---------------------------------------------------------------------------

type ChannelIo = Pick<Server, "to">;

let live: AutomationPoller | null = null;

async function listBoundChannelIds(): Promise<string[]> {
  const rows = await db
    .select({ channelId: channelGatewayBindings.channelId })
    .from(channelGatewayBindings);
  return rows.map((r) => r.channelId);
}

async function isChannelBound(channelId: string): Promise<boolean> {
  const [row] = await db
    .select({ channelId: channelGatewayBindings.channelId })
    .from(channelGatewayBindings)
    .where(eq(channelGatewayBindings.channelId, channelId))
    .limit(1);
  return Boolean(row);
}

/**
 * Once when the socket server starts. Starts pollers for every bound channel. Doesn't throw on failure —
 * chat and movement must work even if the poller fails to start.
 */
export async function startAutomationPollers(io: ChannelIo): Promise<AutomationPoller> {
  if (live) return live;
  const pollDeps = createDefaultPollDeps({
    emitChannel: (channelId, event, payload) => io.to(channelId).emit(event, payload),
    emitRoomMessage: (roomId, message) => broadcastRoomMessage(io, roomId, message),
  });
  live = createAutomationPoller({
    pollOnce: (channelId) => pollChannelOnce(channelId, pollDeps),
    listBoundChannelIds,
    isChannelBound,
    intervals: { activeMs: POLL_DEFAULTS.activeMs, idleMs: POLL_DEFAULTS.idleMs },
  });
  // REST routes (kanban, cron, gateway) don't import `@/server/*` directly; they reach this poller through the
  // registry — if the socket server module ended up in the Next bundle the build would break.
  registerAutomationHooks({
    pollNow,
    refreshPollers,
    getWorkingSnapshot,
    emitRoomMessage: (roomId, message) => broadcastRoomMessage(io, roomId, message as RoomMessage),
  });
  try {
    await live.refresh();
  } catch (err) {
    console.warn(
      `[automation-poller] initial discovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return live;
}

export function stopAutomationPollers(): void {
  live?.stopAll();
  live = null;
  unregisterAutomationHooks();
}

/** When a binding is created or removed (called by the gateway route). No-op if the poller doesn't exist yet. */
export async function refreshPollers(): Promise<void> {
  await live?.refresh();
}

export function startChannelPoller(channelId: string): void {
  live?.start(channelId);
}

export function stopChannelPoller(channelId: string): void {
  live?.stop(channelId);
}

/** Reports whether the channel has connected sockets. Runs one tick immediately when switched on (R24). */
export async function setChannelActive(channelId: string, hasSockets: boolean): Promise<void> {
  await live?.setActive(channelId, hasSockets);
}

/** One immediate poll right after an on-screen action (R24). Called by REST routes. null if there's no poller. */
export async function pollNow(channelId: string): Promise<PollOutcome | null> {
  return live ? live.pollNow(channelId) : null;
}
