/**
 * How far each user has read each conversation, and which reports they acknowledged
 * (`conversation_reads`).
 *
 * - `room` — a chat room (office or group), `targetId` = room id.
 * - `dm` — a 1:1 conversation with an employee, `targetId` = NPC id.
 * - `report` — the "보고 N건" queue of a channel, `targetId` = channel id. `readAt` is the old
 *   watermark (`through`) and `seenIds` the reports acknowledged one by one.
 *
 * The read point only moves forward and never past now, so two tabs racing, or a clock ahead of
 * the server's, can't un-read or pre-read anything.
 */
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { chatMessages, chatRoomMessages, conversationReads, db, isPostgres } from "@/db";
import type { RoomSummary } from "@/lib/chat-rooms-policy";
import type { DmThread } from "@/lib/dm-threads";
import { visibleToSql } from "@/lib/room-audience";

export type ReadKind = "room" | "dm";
export type StoredReportAck = { through: string | null; ids: string[] };

/** A report watermark of "nothing" is stored as the epoch — the column is NOT NULL. */
const EPOCH = new Date(0);
/** Same cap as the browser record it replaces (`report-queue.ts`). */
const MAX_REPORT_ACK_IDS = 500;

/** The PG driver wants a `Date`; SQLite's TEXT column wants an ISO string (same rule as `nowForDb`). */
function toDb(value: Date): Date {
  return (isPostgres ? value : value.toISOString()) as unknown as Date;
}

function toIso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

// Both dialects accept `excluded` and a CASE on the conflict row, so one statement keeps the
// larger of the stored and the incoming point without a read-then-write race.
const FORWARD_ONLY = sql`CASE WHEN excluded.read_at > conversation_reads.read_at THEN excluded.read_at ELSE conversation_reads.read_at END`;

/** Moves the read point to `at` (clamped to now) unless it is already later. Returns the point now stored. */
export async function markConversationRead(input: {
  userId: string;
  kind: ReadKind;
  targetId: string;
  at: Date;
}): Promise<string> {
  const now = new Date();
  const at = input.at.getTime() > now.getTime() ? now : input.at;
  await db
    .insert(conversationReads)
    .values({ userId: input.userId, kind: input.kind, targetId: input.targetId, readAt: toDb(at) })
    .onConflictDoUpdate({
      target: [conversationReads.userId, conversationReads.kind, conversationReads.targetId],
      set: { readAt: FORWARD_ONLY as unknown as Date },
    });
  const marks = await readMarks(input.userId, input.kind, [input.targetId]);
  return marks.get(input.targetId) ?? at.toISOString();
}

/** The read point of each target that has one (ISO). */
export async function readMarks(
  userId: string,
  kind: ReadKind,
  targetIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (targetIds.length === 0) return result;
  const rows = await db
    .select({ targetId: conversationReads.targetId, readAt: conversationReads.readAt })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.userId, userId),
        eq(conversationReads.kind, kind),
        inArray(conversationReads.targetId, targetIds),
      ),
    );
  for (const row of rows) result.set(row.targetId, toIso(row.readAt));
  return result;
}

/**
 * Gives every target without a read point one at `now`. A conversation first seen now starts
 * read — otherwise the day this ships, every room and DM with history would light up at once.
 */
export async function ensureReadBaselines(
  userId: string,
  kind: ReadKind,
  targetIds: string[],
  now: Date = new Date(),
): Promise<void> {
  if (targetIds.length === 0) return;
  await db
    .insert(conversationReads)
    .values(targetIds.map((targetId) => ({ userId, kind, targetId, readAt: toDb(now) })))
    .onConflictDoNothing();
}

/** Keeps only the rooms/employees that have something unread. */
function nonZero(entries: [string, number][]): Map<string, number> {
  return new Map(entries.filter(([, n]) => n > 0));
}

// One count per conversation, each bounded by a **literal** read point. Joining the read point in
// instead makes PostgreSQL scan every message of every room (measured: a seq scan of all 60k rows),
// while a literal bound turns into a range scan on `(room_id, created_at)` /
// `(character_id, npc_id, created_at)`. A viewer has a handful of rooms and employees, so the extra
// round trips are cheap next to scanning the whole history on every list.

/** Per room: messages after my read point, not sent by me, that I may see. Rooms with none are absent. */
export async function roomUnreadCounts(
  userId: string,
  roomIds: string[],
): Promise<Map<string, number>> {
  if (roomIds.length === 0) return new Map();
  const marks = await readMarks(userId, "room", roomIds);
  const entries = await Promise.all(
    roomIds.map(async (roomId): Promise<[string, number]> => {
      const mark = marks.get(roomId);
      const [row] = await db
        .select({ n: sql`count(*)` })
        .from(chatRoomMessages)
        .where(
          and(
            eq(chatRoomMessages.roomId, roomId),
            ...(mark ? [gt(chatRoomMessages.createdAt, toDb(new Date(mark)))] : []),
            visibleToSql(userId),
            or(
              ne(chatRoomMessages.senderKind, "user"),
              isNull(chatRoomMessages.senderId),
              ne(chatRoomMessages.senderId, userId),
            ),
          ),
        );
      return [roomId, Number(row?.n ?? 0)];
    }),
  );
  return nonZero(entries);
}

/** Per employee: their replies to this character after my read point. Employees with none are absent. */
export async function dmUnreadCounts(
  userId: string,
  characterId: string,
  npcIds: string[],
): Promise<Map<string, number>> {
  if (npcIds.length === 0) return new Map();
  const marks = await readMarks(userId, "dm", npcIds);
  const entries = await Promise.all(
    npcIds.map(async (npcId): Promise<[string, number]> => {
      const mark = marks.get(npcId);
      const [row] = await db
        .select({ n: sql`count(*)` })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.characterId, characterId),
            eq(chatMessages.npcId, npcId),
            ...(mark ? [gt(chatMessages.createdAt, toDb(new Date(mark)))] : []),
            eq(chatMessages.role, "npc"),
          ),
        );
      return [npcId, Number(row?.n ?? 0)];
    }),
  );
  return nonZero(entries);
}

/** The viewer's unread count and read point on each room of their list. First sight sets a baseline. */
export async function attachRoomReads(
  userId: string,
  rooms: RoomSummary[],
): Promise<RoomSummary[]> {
  const ids = rooms.map((room) => room.id);
  await ensureReadBaselines(userId, "room", ids);
  const [counts, marks] = await Promise.all([
    roomUnreadCounts(userId, ids),
    readMarks(userId, "room", ids),
  ]);
  return rooms.map((room) => ({
    ...room,
    unread: counts.get(room.id) ?? 0,
    readAt: marks.get(room.id) ?? null,
  }));
}

/** The same for the viewer's DM lines. */
export async function attachDmReads(
  userId: string,
  characterId: string,
  threads: DmThread[],
): Promise<DmThread[]> {
  const ids = threads.map((thread) => thread.npcId);
  await ensureReadBaselines(userId, "dm", ids);
  const [counts, marks] = await Promise.all([
    dmUnreadCounts(userId, characterId, ids),
    readMarks(userId, "dm", ids),
  ]);
  return threads.map((thread) => ({
    ...thread,
    unread: counts.get(thread.npcId) ?? 0,
    readAt: marks.get(thread.npcId) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Report acknowledgments
// ---------------------------------------------------------------------------

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function reportAckOf(row: { readAt: unknown; seenIds: string | null }): StoredReportAck {
  const at = new Date(row.readAt as string | Date);
  return { through: at.getTime() === 0 ? null : at.toISOString(), ids: parseIds(row.seenIds) };
}

/** The stored acknowledgment, or null when this user never had one here (the browser may hold an old one). */
export async function loadReportAck(
  userId: string,
  channelId: string,
): Promise<StoredReportAck | null> {
  const [row] = await db
    .select({ readAt: conversationReads.readAt, seenIds: conversationReads.seenIds })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.userId, userId),
        eq(conversationReads.kind, "report"),
        eq(conversationReads.targetId, channelId),
      ),
    )
    .limit(1);
  return row ? reportAckOf(row) : null;
}

async function saveReportAck(userId: string, channelId: string, ack: StoredReportAck) {
  const readAt = toDb(ack.through ? new Date(ack.through) : EPOCH);
  const seenIds = JSON.stringify(ack.ids.slice(-MAX_REPORT_ACK_IDS));
  await db
    .insert(conversationReads)
    .values({ userId, kind: "report", targetId: channelId, readAt, seenIds })
    .onConflictDoUpdate({
      target: [conversationReads.userId, conversationReads.kind, conversationReads.targetId],
      set: { readAt, seenIds },
    });
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/**
 * Brings a browser's old record in. Merges with anything already stored — two browsers each
 * importing their leftovers must not erase each other's acknowledgments.
 */
export async function importReportAck(
  userId: string,
  channelId: string,
  incoming: StoredReportAck,
): Promise<StoredReportAck> {
  const current = (await loadReportAck(userId, channelId)) ?? { through: null, ids: [] };
  const through = laterOf(current.through, incoming.through);
  const ids = [...current.ids];
  for (const id of incoming.ids) if (!ids.includes(id)) ids.push(id);
  const merged = { through: through ? new Date(through).toISOString() : null, ids };
  await saveReportAck(userId, channelId, merged);
  return { ...merged, ids: merged.ids.slice(-MAX_REPORT_ACK_IDS) };
}

/** Acknowledges one report. Idempotent. */
export async function acknowledgeReportFor(
  userId: string,
  channelId: string,
  messageId: string,
): Promise<StoredReportAck> {
  const current = (await loadReportAck(userId, channelId)) ?? { through: null, ids: [] };
  if (current.ids.includes(messageId)) return current;
  const next = {
    through: current.through,
    ids: [...current.ids, messageId].slice(-MAX_REPORT_ACK_IDS),
  };
  await saveReportAck(userId, channelId, next);
  return next;
}
