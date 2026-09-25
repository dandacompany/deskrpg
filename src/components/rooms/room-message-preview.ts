import type { RoomPreview } from "@/lib/chat-rooms-policy";
import { markdownToPlainLine } from "@/lib/markdown-plain";

/**
 * The text a room list shows for its last message. A cron result with no output is stored with an empty body, so
 * the preview names the outcome in the viewer's language instead. Anything with a body — including rows stored in
 * Korean before that change — is shown as it is, as one line of plain text (the room renders it as markdown).
 */
export function roomMessagePreview(
  lastMessage: Pick<RoomPreview, "content" | "notice">,
  t: (key: string) => string,
): string {
  if (lastMessage.content.trim() || lastMessage.notice?.kind !== "cron_result")
    return markdownToPlainLine(lastMessage.content);
  return t(
    lastMessage.notice.status === "error" ? "room.cronResult.failed" : "room.cronResult.empty",
  );
}
