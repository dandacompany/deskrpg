/**
 * Rewrites a notice line already sitting in a room **using the same id** and rebroadcasts it.
 *
 * Used by notices that resolve inside DeskRPG, like registration and approval. Keeping
 * the resolved state on the notice itself means the renderer doesn't have to re-read
 * another table, and scrolling back to a past message still shows that moment's result.
 * The broadcast lets an already-open screen swap a button for its result without a
 * refresh (`room-state` swaps the changed notice for the same id in place).
 *
 * **Doesn't throw.** A stale notice and a failed registration/approval carry different weight.
 */
import { and, eq, like } from "drizzle-orm";

import { chatRoomMessages, chatRooms, db } from "@/db";
import { requestEmitRoomMessage } from "@/lib/automation-registry";
import { parseRoomNotice, type RoomNotice } from "@/lib/chat-rooms-policy";

export async function rewriteRoomNotices(input: {
  channelId: string;
  /** A string that narrows candidates via LIKE (the id carried in the notice). `update` makes the exact judgment. */
  needle: string;
  /** Returns the new notice if this notice should change, otherwise null. */
  update: (notice: RoomNotice) => RoomNotice | null;
}): Promise<number> {
  let rewritten = 0;
  try {
    const rows = await db
      .select({
        id: chatRoomMessages.id,
        roomId: chatRoomMessages.roomId,
        senderKind: chatRoomMessages.senderKind,
        senderId: chatRoomMessages.senderId,
        senderName: chatRoomMessages.senderName,
        content: chatRoomMessages.content,
        createdAt: chatRoomMessages.createdAt,
        noticeJson: chatRoomMessages.noticeJson,
      })
      .from(chatRoomMessages)
      .innerJoin(chatRooms, eq(chatRooms.id, chatRoomMessages.roomId))
      .where(
        and(
          eq(chatRooms.channelId, input.channelId),
          like(chatRoomMessages.noticeJson, `%${input.needle}%`),
        ),
      );
    for (const row of rows) {
      const notice = parseRoomNotice(row.noticeJson);
      const next = notice ? input.update(notice) : null;
      if (!next) continue;
      await db
        .update(chatRoomMessages)
        .set({ noticeJson: JSON.stringify(next) })
        .where(eq(chatRoomMessages.id, row.id));
      rewritten += 1;
      requestEmitRoomMessage(row.roomId, {
        id: row.id,
        roomId: row.roomId,
        senderKind: row.senderKind,
        senderId: row.senderId,
        senderName: row.senderName,
        content: row.content,
        createdAt:
          row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        notice: next,
      });
    }
  } catch (error) {
    console.warn(
      "[room-notice] failed to rewrite the notice",
      { channelId: input.channelId },
      error,
    );
  }
  return rewritten;
}
