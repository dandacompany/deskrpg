/**
 * The `Cards`/`Cron` tab badges in the employee chat window — the "not yet seen" count and
 * the history of viewing it.
 *
 * Counting is done by a pure function (`npc-panel-reads-count.ts`); what's decided here is
 * how it's combined. One core rule: **the two badges never take each other down.** Board
 * lookup is a long chain requiring gateway, plugin, and board acquisition to all succeed, so
 * it always fails on an install with no plugin, while cron notices are DeskRPG's own room
 * messages and stay fine even then. So each lookup is wrapped separately, and only the
 * failing side falls back to 0.
 *
 * The board side is viewed through the **read-only branch**
 * (`resolveKanbanChannelContextForRead`). Since badges are polled periodically, if this path
 * went as far as `ensureChannelBoard` like the main path does, it would repeatedly try to
 * create a Hermes board the user never asked for. The permission gates (login, member,
 * gateway, plugin) are the same as the main path.
 *
 * The Cards tab can't use a time watermark — `KanbanTask` has no `updated_at`. So it
 * accumulates seen card ids, and every write prunes them down to the intersection with the
 * currently assigned cards (`pruneSeenIds`).
 */

import { and, eq } from "drizzle-orm";

import {
  chatRoomMessages,
  chatRooms,
  db,
  hermesProfiles,
  isPostgres,
  npcPanelReads,
  npcs,
} from "@/db";
import { assignedCards } from "@/lib/npc-assigned-cards";
import { parseRoomNotice } from "@/lib/chat-rooms-policy";
import { resolveKanbanChannelContextForRead } from "@/lib/kanban-access";
import { pruneSeenIds, unseenCardCount, unseenCronCount } from "@/lib/npc-panel-reads-count";

export type PanelTab = "cron" | "cards";

export const PANEL_TABS: readonly PanelTab[] = ["cron", "cards"];

export function isPanelTab(value: unknown): value is PanelTab {
  return typeof value === "string" && (PANEL_TABS as readonly string[]).includes(value);
}

export type PanelTarget = { channelId: string; userId: string; npcId: string };

export type PanelReadRow = { seenAt: string | null; seenIds: string[] };

/**
 * Means one badge source is blocked. It carries a status code, but the route never turns
 * this into a response — for a badge, "unknown means 0" is the right answer, and returning
 * 400/428/503 would make even the other badge disappear too.
 */
export class PanelSourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (${status})`);
    this.name = "PanelSourceError";
  }
}

export type BadgeDeps = {
  /** Assigned card ids — throws `PanelSourceError` if any of gateway/plugin/board is blocked. */
  loadAssignedCardIds(target: PanelTarget): Promise<string[]>;
  /** Timestamps (ISO, not necessarily ascending) of cron-result notices this NPC left in this
   * channel. */
  loadCronNoticeTimes(target: PanelTarget): Promise<string[]>;
  loadPanelRead(target: PanelTarget, tab: PanelTab): Promise<PanelReadRow | null>;
  savePanelRead(
    target: PanelTarget,
    tab: PanelTab,
    patch: { seenAt: Date; seenIds?: string[] },
  ): Promise<void>;
  now(): Date;
};

export type PanelBadges = { cards: number; cron: number };

/** A failed source folds down to 0 — so one side's silence doesn't mask the other. */
async function countOrZero(count: () => Promise<number>): Promise<number> {
  try {
    return await count();
  } catch (err) {
    if (err instanceof PanelSourceError) return 0;
    throw err;
  }
}

export async function readBadges(target: PanelTarget, deps: BadgeDeps): Promise<PanelBadges> {
  const [cards, cron] = await Promise.all([
    countOrZero(async () => {
      const assigned = await deps.loadAssignedCardIds(target);
      const read = await deps.loadPanelRead(target, "cards");
      return unseenCardCount(assigned, read?.seenIds ?? []);
    }),
    countOrZero(async () => {
      const times = await deps.loadCronNoticeTimes(target);
      const read = await deps.loadPanelRead(target, "cron");
      return unseenCronCount(times, read?.seenAt ?? null);
    }),
  ]);
  return { cards, cron };
}

/**
 * Records that a tab was opened. For `cards`, marks every currently assigned card as seen
 * and drops any id no longer assigned. For `cron`, only bumps `seenAt` — `seenIds` is left
 * untouched (that belongs to the cards tab). If assigned cards can't be fetched, `seenIds`
 * is left as-is and only `seenAt` is bumped — this neither marks something unseen as seen
 * nor forgets something already seen.
 */
export async function markTabSeen(
  input: PanelTarget & { tab: PanelTab },
  deps: BadgeDeps,
): Promise<void> {
  const { tab, ...target } = input;
  const seenAt = deps.now();
  if (tab === "cron") {
    await deps.savePanelRead(target, tab, { seenAt });
    return;
  }
  let assigned: string[] | null = null;
  try {
    assigned = await deps.loadAssignedCardIds(target);
  } catch (err) {
    if (!(err instanceof PanelSourceError)) throw err;
  }
  const existing = (await deps.loadPanelRead(target, tab))?.seenIds ?? [];
  const seenIds = assigned
    ? pruneSeenIds(assigned, [...new Set([...existing, ...assigned])])
    : existing;
  await deps.savePanelRead(target, tab, { seenAt, seenIds });
}

// ---------------------------------------------------------------------------
// Real wiring — Hermes board · room notices · `npc_panel_reads`
// ---------------------------------------------------------------------------

/** The profile name of the NPC in this channel. `npcs.name` is not read. */
async function npcProfileName(target: PanelTarget): Promise<string> {
  const [row] = await db
    .select({ profileName: hermesProfiles.profileName })
    .from(npcs)
    .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
    .where(and(eq(npcs.id, target.npcId), eq(npcs.channelId, target.channelId)))
    .limit(1);
  if (!row) throw new PanelSourceError(404, "npc_not_found");
  return row.profileName;
}

async function loadAssignedCardIds(target: PanelTarget): Promise<string[]> {
  const gate = await resolveKanbanChannelContextForRead({
    userId: target.userId,
    channelId: target.channelId,
  });
  if (!gate.ok) throw new PanelSourceError(gate.response.status, "board_unavailable");
  const profileName = await npcProfileName(target);
  const board = await gate.ctx.client.kanban.getBoard(gate.ctx.boardSlug);
  if (!board.ok) throw new PanelSourceError(board.status, "board_unavailable");
  return assignedCards(board.data, profileName).map((task) => task.id);
}

async function loadCronNoticeTimes(target: PanelTarget): Promise<string[]> {
  const rows = await db
    .select({ noticeJson: chatRoomMessages.noticeJson, createdAt: chatRoomMessages.createdAt })
    .from(chatRoomMessages)
    .innerJoin(chatRooms, eq(chatRooms.id, chatRoomMessages.roomId))
    .where(
      and(
        eq(chatRooms.channelId, target.channelId),
        eq(chatRoomMessages.senderKind, "npc"),
        eq(chatRoomMessages.senderId, target.npcId),
      ),
    );
  return rows
    .filter((row) => parseRoomNotice(row.noticeJson)?.kind === "cron_result")
    .map((row) => new Date(row.createdAt).toISOString());
}

async function loadPanelRead(target: PanelTarget, tab: PanelTab): Promise<PanelReadRow | null> {
  const [row] = await db
    .select({ seenAt: npcPanelReads.seenAt, seenIds: npcPanelReads.seenIds })
    .from(npcPanelReads)
    .where(
      and(
        eq(npcPanelReads.userId, target.userId),
        eq(npcPanelReads.npcId, target.npcId),
        eq(npcPanelReads.tab, tab),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    seenAt: row.seenAt ? new Date(row.seenAt).toISOString() : null,
    seenIds: parseSeenIds(row.seenIds),
  };
}

/** Broken JSON folds down to "nothing seen" — the badge just shows a bit high, but the
 * screen still works. */
function parseSeenIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function savePanelRead(
  target: PanelTarget,
  tab: PanelTab,
  patch: { seenAt: Date; seenIds?: string[] },
): Promise<void> {
  const seenAt = toDbTimestamp(patch.seenAt);
  const seenIds = patch.seenIds ? JSON.stringify(patch.seenIds) : undefined;
  await db
    .insert(npcPanelReads)
    .values({
      userId: target.userId,
      npcId: target.npcId,
      tab,
      seenAt,
      seenIds: seenIds ?? null,
    })
    .onConflictDoUpdate({
      target: [npcPanelReads.userId, npcPanelReads.npcId, npcPanelReads.tab],
      set: { seenAt, ...(seenIds === undefined ? {} : { seenIds }) },
    });
}

/** The PG driver wants a `Date`; SQLite's TEXT column wants an ISO string (same rule as
 * `nowForDb`). */
function toDbTimestamp(value: Date): Date {
  return (isPostgres ? value : value.toISOString()) as unknown as Date;
}

export const liveBadgeDeps: BadgeDeps = {
  loadAssignedCardIds,
  loadCronNoticeTimes,
  loadPanelRead,
  savePanelRead,
  now: () => new Date(),
};
