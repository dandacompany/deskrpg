/**
 * Private room notices. A notice with `audience` (today only `approval_blocked`) is meant for one
 * user — the person who ordered the blocked run. Every server path that reads or sends room
 * messages filters it for everyone else; the client never has to hide it.
 */
import { isNull, like, notLike, or, sql, type SQL } from "drizzle-orm";

import { chatRoomMessages } from "@/db";
import type { RoomMessage, RoomNotice } from "@/lib/chat-rooms-policy";

export function noticeAudience(notice: RoomNotice | null | undefined): string | null {
  return notice && "audience" in notice && typeof notice.audience === "string"
    ? notice.audience
    : null;
}

/** A null viewer (an NPC transcript, a system reader) sees no private notice. */
export function isVisibleTo(
  message: Pick<RoomMessage, "notice">,
  viewerUserId: string | null,
): boolean {
  const audience = noticeAudience(message.notice);
  return audience === null || audience === viewerUserId;
}

// `notice_json` is `JSON.stringify(notice)`, so a private notice holds `"audience":"<id>"` verbatim
// (a quote inside another string field is escaped and cannot match). The SQL narrows the rows;
// `isVisibleTo` stays the exact check on what is returned.
const PRIVATE_PATTERN = '%"audience":%';
const audiencePattern = (viewerUserId: string) => `%"audience":${JSON.stringify(viewerUserId)}%`;

/** WHERE condition: rows of `chat_room_messages` the viewer may see. */
export function visibleToSql(viewerUserId: string | null): SQL {
  const column = chatRoomMessages.noticeJson;
  const open = or(isNull(column), notLike(column, PRIVATE_PATTERN))!;
  return viewerUserId ? or(open, like(column, audiencePattern(viewerUserId)))! : open;
}

/** The same condition for a raw-SQL alias of `chat_room_messages` (e.g. `m2` in a subquery). */
export function visibleToRawSql(alias: string, viewerUserId: string | null): SQL {
  const column = sql.raw(`${alias}.notice_json`);
  return viewerUserId
    ? sql`(${column} IS NULL OR ${column} NOT LIKE ${PRIVATE_PATTERN} OR ${column} LIKE ${audiencePattern(viewerUserId)})`
    : sql`(${column} IS NULL OR ${column} NOT LIKE ${PRIVATE_PATTERN})`;
}
