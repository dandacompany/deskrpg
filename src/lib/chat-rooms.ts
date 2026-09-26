import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  chatRooms,
  chatRoomMembers,
  chatRoomMessages,
  channels,
  users,
  npcs,
  hermesProfiles,
  nowForDb,
} from "@/db";
import { isUniqueViolation } from "./db-unique-violation";
import { uuidv7 } from "./uuid-v7";
import { projectNpcRow } from "./npc-projection";
import {
  parseRoomNotice,
  sortRooms,
  toRoomPreview,
  type ReplyPolicy,
  type RoomMessage,
  type RoomNotice,
  type RoomSummary,
} from "./chat-rooms-policy";

export type { RoomMessage, RoomNotice, RoomRow } from "./chat-rooms-policy";
import type { RoomRow } from "./chat-rooms-policy";
import { translateServer } from "@/lib/i18n/server";
import { isVisibleTo, visibleToRawSql, visibleToSql } from "@/lib/room-audience";

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function toRoomRow(row: typeof chatRooms.$inferSelect): RoomRow {
  return {
    id: row.id,
    channelId: row.channelId,
    kind: row.kind as RoomRow["kind"],
    name: row.name,
    replyPolicy: row.replyPolicy as ReplyPolicy,
    createdBy: row.createdBy,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string),
    lastMessageAt: row.lastMessageAt
      ? row.lastMessageAt instanceof Date
        ? row.lastMessageAt
        : new Date(row.lastMessageAt as unknown as string)
      : null,
  };
}

function toRoomMessage(row: typeof chatRoomMessages.$inferSelect): RoomMessage {
  return {
    id: row.id,
    roomId: row.roomId,
    senderKind: row.senderKind as RoomMessage["senderKind"],
    senderId: row.senderId ?? null,
    senderName: row.senderName,
    content: row.content,
    createdAt: toIso(row.createdAt as unknown as Date | string)!,
    notice: parseRoomNotice(row.noticeJson),
  };
}

/** There's exactly one office room per channel. Create it if missing, and re-query on a
 * unique violation (a race). */
export async function ensureOfficeRoom(channelId: string, ownerId: string): Promise<RoomRow> {
  const [existing] = await db
    .select()
    .from(chatRooms)
    .where(and(eq(chatRooms.channelId, channelId), eq(chatRooms.kind, "office")))
    .limit(1);
  if (existing) return toRoomRow(existing);

  try {
    const [created] = await db
      .insert(chatRooms)
      .values({
        channelId,
        kind: "office",
        // The screen names the office room from its kind (`t("room.office")`); this stored value is only a
        // fallback, so it is language-neutral. Rows created before this change keep their old name.
        name: "Office",
        replyPolicy: "mention",
        createdBy: ownerId,
      })
      .returning();
    return toRoomRow(created);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [row] = await db
      .select()
      .from(chatRooms)
      .where(and(eq(chatRooms.channelId, channelId), eq(chatRooms.kind, "office")))
      .limit(1);
    if (!row) throw err;
    return toRoomRow(row);
  }
}

/**
 * The office room's `created_by` must be the **channel owner** (spec ①). The trigger that
 * creates the room is `room:list`, which anyone can call, so using the caller as-is would
 * make the first guest to enter a pre-migration channel the owner of the office room.
 */
export async function getChannelOwnerId(channelId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return row?.ownerId ?? null;
}

export async function getRoom(roomId: string): Promise<RoomRow | null> {
  const [row] = await db.select().from(chatRooms).where(eq(chatRooms.id, roomId)).limit(1);
  return row ? toRoomRow(row) : null;
}

export async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ roomId: chatRoomMembers.roomId })
    .from(chatRoomMembers)
    .where(
      and(
        eq(chatRoomMembers.roomId, roomId),
        eq(chatRoomMembers.memberKind, "user"),
        eq(chatRoomMembers.memberId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function memberDisplayNames(
  roomIds: string[],
): Promise<Map<string, { kind: "user" | "npc"; id: string; name: string }[]>> {
  const result = new Map<string, { kind: "user" | "npc"; id: string; name: string }[]>();
  if (roomIds.length === 0) return result;

  const members = await db
    .select()
    .from(chatRoomMembers)
    .where(inArray(chatRoomMembers.roomId, roomIds));

  const userIds = [
    ...new Set(members.filter((m) => m.memberKind === "user").map((m) => m.memberId)),
  ];
  const npcIds = [...new Set(members.filter((m) => m.memberKind === "npc").map((m) => m.memberId))];

  const userNames = new Map<string, string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const r of rows) userNames.set(r.id, r.nickname);
  }

  const npcNames = new Map<string, string>();
  if (npcIds.length > 0) {
    const rows = await db
      .select({ npc: npcs, profile: hermesProfiles })
      .from(npcs)
      .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
      .where(inArray(npcs.id, npcIds));
    for (const r of rows) {
      const projected = projectNpcRow(r.npc, r.profile, "");
      npcNames.set(r.npc.id, projected.name);
    }
  }

  for (const m of members) {
    const list = result.get(m.roomId) ?? [];
    const name =
      m.memberKind === "user"
        ? (userNames.get(m.memberId) ?? m.memberId)
        : (npcNames.get(m.memberId) ?? m.memberId);
    list.push({ kind: m.memberKind as "user" | "npc", id: m.memberId, name });
    result.set(m.roomId, list);
  }
  return result;
}

/**
 * One latest message per room — reduces what used to be N+1 queries (one per room) to a
 * single query. A correlated subquery (NOT EXISTS) that says "no row in the same room comes
 * after this one lexicographically by (created_at, id)" picks exactly one latest row per
 * room — this is standard SQL on both PG/SQLite, so no dialect branching is needed. If
 * messages share the same room and the same timestamp (common since SQLite's created_at is
 * millisecond-precision), the one with the larger id is treated as the latest — since
 * `appendRoomMessage` embeds **UUIDv7** (the top 48 bits are Unix milliseconds, plus a
 * monotonically increasing counter within the same millisecond), id order equals creation
 * order. Back when it was v4, this rule picked the winner at random.
 * The `chat_room_messages`/column names inside the subquery are raw SQL, but they're fixed
 * strings with no user input mixed in, so there's no binding-safety issue.
 */
async function lastMessages(
  roomIds: string[],
  viewerUserId: string | null,
): Promise<Map<string, RoomMessage>> {
  const result = new Map<string, RoomMessage>();
  if (roomIds.length === 0) return result;

  const rows = await db
    .select()
    .from(chatRoomMessages)
    .where(
      and(
        inArray(chatRoomMessages.roomId, roomIds),
        // A private notice for someone else is neither the preview nor what hides an older preview.
        visibleToSql(viewerUserId),
        sql`NOT EXISTS (
          SELECT 1 FROM chat_room_messages m2
          WHERE m2.room_id = chat_room_messages.room_id
            AND ${visibleToRawSql("m2", viewerUserId)}
            AND (
              m2.created_at > chat_room_messages.created_at
              OR (m2.created_at = chat_room_messages.created_at AND m2.id > chat_room_messages.id)
            )
        )`,
      ),
    );

  for (const row of rows) {
    const message = toRoomMessage(row);
    if (isVisibleTo(message, viewerUserId)) result.set(row.roomId, message);
  }
  return result;
}

function toSummary(
  room: RoomRow,
  membersByRoom: Map<string, { kind: "user" | "npc"; id: string; name: string }[]>,
  lastByRoom: Map<string, RoomMessage>,
): RoomSummary {
  const last = lastByRoom.get(room.id);
  return {
    id: room.id,
    kind: room.kind,
    name: room.name,
    replyPolicy: room.replyPolicy,
    createdBy: room.createdBy,
    lastMessageAt: toIso(room.lastMessageAt) ?? toIso(room.createdAt),
    members: membersByRoom.get(room.id) ?? [],
    ...(last
      ? {
          lastMessage: toRoomPreview(last),
        }
      : {}),
  };
}

/** The one office room, plus every group room where I'm a user member. */
export async function listRoomsForUser(channelId: string, userId: string): Promise<RoomSummary[]> {
  const office = await db
    .select()
    .from(chatRooms)
    .where(and(eq(chatRooms.channelId, channelId), eq(chatRooms.kind, "office")))
    .limit(1);

  const myGroupMemberships = await db
    .select({ roomId: chatRoomMembers.roomId })
    .from(chatRoomMembers)
    .where(and(eq(chatRoomMembers.memberKind, "user"), eq(chatRoomMembers.memberId, userId)));
  const myRoomIds = myGroupMemberships.map((m) => m.roomId);

  const groups =
    myRoomIds.length === 0
      ? []
      : await db
          .select()
          .from(chatRooms)
          .where(
            and(
              eq(chatRooms.channelId, channelId),
              eq(chatRooms.kind, "group"),
              inArray(chatRooms.id, myRoomIds),
            ),
          );

  const rooms = [...office, ...groups].map(toRoomRow);
  const roomIds = rooms.map((r) => r.id);
  const [membersByRoom, lastByRoom] = await Promise.all([
    memberDisplayNames(roomIds),
    lastMessages(roomIds, userId),
  ]);
  const summaries = rooms.map((r) => toSummary(r, membersByRoom, lastByRoom));
  return sortRooms(summaries);
}

/** If `name` is an empty string, join the NPC names instead (max 60 chars). createdBy
 * automatically becomes a user member. */
export async function createRoom(args: {
  channelId: string;
  name: string;
  createdBy: string;
  npcIds: string[];
  userIds: string[];
  /** The creator's language, for the fallback name. Omitted keeps Korean; null (no cookie) gets English. */
  locale?: string | null;
}): Promise<RoomRow> {
  let name = args.name.trim();
  if (!name) {
    const npcRows =
      args.npcIds.length === 0
        ? []
        : await db
            .select({ npc: npcs, profile: hermesProfiles })
            .from(npcs)
            .innerJoin(hermesProfiles, eq(hermesProfiles.id, npcs.hermesProfileId))
            .where(inArray(npcs.id, args.npcIds));
    const names = npcRows.map((r) => projectNpcRow(r.npc, r.profile, "").name);
    const fallback = translateServer(
      args.locale === undefined ? "ko" : args.locale,
      "room.defaultName",
    );
    name = (names.join(", ") || fallback).slice(0, 60);
  }

  const [created] = await db
    .insert(chatRooms)
    .values({
      channelId: args.channelId,
      kind: "group",
      name,
      replyPolicy: "members",
      createdBy: args.createdBy,
    })
    .returning();

  const userIds = [...new Set([args.createdBy, ...args.userIds])];
  await addMembers(created.id, args.createdBy, args.npcIds, userIds);

  return toRoomRow(created);
}

/** Duplicates are ignored. */
export async function addMembers(
  roomId: string,
  invitedBy: string,
  npcIds: string[],
  userIds: string[],
): Promise<void> {
  const existing = await db
    .select({ memberKind: chatRoomMembers.memberKind, memberId: chatRoomMembers.memberId })
    .from(chatRoomMembers)
    .where(eq(chatRoomMembers.roomId, roomId));
  const existingKeys = new Set(existing.map((m) => `${m.memberKind}:${m.memberId}`));

  const rows: (typeof chatRoomMembers.$inferInsert)[] = [];
  for (const id of npcIds) {
    if (existingKeys.has(`npc:${id}`)) continue;
    existingKeys.add(`npc:${id}`);
    rows.push({ roomId, memberKind: "npc", memberId: id, invitedBy });
  }
  for (const id of userIds) {
    if (existingKeys.has(`user:${id}`)) continue;
    existingKeys.add(`user:${id}`);
    rows.push({ roomId, memberKind: "user", memberId: id, invitedBy });
  }
  if (rows.length === 0) return;
  await db.insert(chatRoomMembers).values(rows);
}

export async function removeUserMember(roomId: string, userId: string): Promise<void> {
  await db
    .delete(chatRoomMembers)
    .where(
      and(
        eq(chatRoomMembers.roomId, roomId),
        eq(chatRoomMembers.memberKind, "user"),
        eq(chatRoomMembers.memberId, userId),
      ),
    );
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  await db.update(chatRooms).set({ name }).where(eq(chatRooms.id, roomId));
}

export async function deleteRoom(roomId: string): Promise<void> {
  await db.delete(chatRooms).where(eq(chatRooms.id, roomId));
}

/** User members of a group room — who hears about its new lines while another room is open. */
export async function roomUserMemberIds(roomId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: chatRoomMembers.memberId })
    .from(chatRoomMembers)
    .where(and(eq(chatRoomMembers.roomId, roomId), eq(chatRoomMembers.memberKind, "user")));
  return rows.map((r) => r.memberId);
}

export async function roomNpcMemberIds(roomId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: chatRoomMembers.memberId })
    .from(chatRoomMembers)
    .where(and(eq(chatRoomMembers.roomId, roomId), eq(chatRoomMembers.memberKind, "npc")));
  return rows.map((r) => r.memberId);
}

/**
 * Updates the room's last_message_at after inserting.
 * `notice` is the structure for automation notifications (R29·R30) — it's stored as JSON in
 * `notice_json` and read back as `RoomMessage.notice`. Ordinary messages don't pass it
 * (NULL).
 */
export async function appendRoomMessage(args: {
  roomId: string;
  senderKind: "user" | "npc" | "system";
  senderId: string | null;
  senderName: string;
  content: string;
  notice?: RoomNotice | null;
}): Promise<RoomMessage> {
  const [created] = await db
    .insert(chatRoomMessages)
    .values({
      // The DB default (randomUUID / defaultRandom) is v4, which can't serve as a sort key.
      // Embedded at the app level so both dialects use the same rule.
      id: uuidv7(),
      roomId: args.roomId,
      senderKind: args.senderKind,
      senderId: args.senderId,
      senderName: args.senderName,
      content: args.content,
      noticeJson: args.notice ? JSON.stringify(args.notice) : null,
    })
    .returning();
  await db
    .update(chatRooms)
    .set({ lastMessageAt: nowForDb() })
    .where(eq(chatRooms.id, args.roomId));
  return toRoomMessage(created);
}

/**
 * Returns the most recent `limit` messages in oldest-first order.
 *
 * Sorted lexicographically by `(created_at, id)` — the **same rule** as `lastMessages()`'s
 * correlated subquery. If the two functions used different rules, the "last message" shown
 * in the room list and the last line shown when opening the room would disagree. Since id is
 * UUIDv7, this tiebreaker matches creation order.
 *
 * Rows accumulated before v7 was introduced are v4, so ties among them are still random —
 * this doesn't affect new messages, it only leaves the within-one-millisecond order of old
 * conversations unstable.
 */
export async function recentRoomMessages(
  roomId: string,
  limit: number,
  /** Whose view — private notices of others are left out. null (NPC transcripts) sees none. */
  viewerUserId: string | null,
): Promise<RoomMessage[]> {
  const rows = await db
    .select()
    .from(chatRoomMessages)
    .where(and(eq(chatRoomMessages.roomId, roomId), visibleToSql(viewerUserId)))
    .orderBy(desc(chatRoomMessages.createdAt), desc(chatRoomMessages.id))
    .limit(limit);
  return rows
    .reverse()
    .map(toRoomMessage)
    .filter((m) => isVisibleTo(m, viewerUserId));
}
