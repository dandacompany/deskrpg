/**
 * The report queue — extracts "who should come and speak" from office room notices.
 *
 * The actor is **the viewing browser**, not the server. `npc:call` is a socket handler that determines its target
 * with `targetPlayerId: socket.id` (`src/server/npc-coordination.ts`), so automation events have no one
 * to walk to. So the browser that received the notice fires the existing call itself — if nobody is
 * connected, the move is skipped and only the notice stays in the room, which is the right behavior.
 *
 * Only pure functions here. This file goes into the client bundle, so it does not use `node:*` or `@/db`.
 */
import type { RoomMessage, RoomNotice } from "@/lib/chat-rooms-policy";

export type ReportKind = "card_review" | "card_blocked" | "card_done" | "cron_failed";

export type ReportItem = {
  messageId: string;
  npcId: string;
  npcName: string;
  kind: ReportKind;
  /** Only card reports have a value. Cron failures have no card to open. */
  cardId: string | null;
  boardSlug: string | null;
  /** Only cron failures have a value — this report opens the cron history, not a card. */
  jobId: string | null;
  cardTitle: string;
  /** The notice body (locale-independent fallback — card title, result body). Used for the summary at the top of the report dialog. */
  summary: string;
  createdAt: string;
};

/**
 * What was acknowledged. Acknowledgment is **per report** (`ids`).
 *
 * It used to keep only one `createdAt` of the last acknowledged notice (a watermark), so acknowledging a later report
 * acknowledged **other employees'** reports before it without them ever coming. `through` is backward compatibility for reading
 * old values saved back then — everything before that time counts as acknowledged. It is not written anew.
 */
export type ReportAck = { through: string | null; ids: readonly string[] };

export const EMPTY_REPORT_ACK: ReportAck = { through: null, ids: [] };

/** Cap on stored ids. Oldest are dropped first — dropped reports have already been pushed out of the queue as the room notices aged. */
const MAX_ACK_IDS = 500;

/** Read the value stored in the browser. Accepts both the old string watermark and the new JSON. */
export function parseReportAck(raw: string | null): ReportAck {
  if (!raw) return EMPTY_REPORT_ACK;
  if (!raw.startsWith("{")) return { through: raw, ids: [] };
  try {
    const value = JSON.parse(raw) as { through?: unknown; ids?: unknown };
    return {
      through: typeof value.through === "string" ? value.through : null,
      ids: Array.isArray(value.ids)
        ? value.ids.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return EMPTY_REPORT_ACK;
  }
}

export function serializeReportAck(ack: ReportAck): string {
  return JSON.stringify({ through: ack.through, ids: ack.ids });
}

/** Acknowledge only this one report. Other reports are not touched. */
export function acknowledgeReport(ack: ReportAck, messageId: string): ReportAck {
  if (ack.ids.includes(messageId)) return ack;
  return { through: ack.through, ids: [...ack.ids, messageId].slice(-MAX_ACK_IDS) };
}

export function isReportAcknowledged(
  ack: ReportAck,
  message: { id: string; createdAt: string },
): boolean {
  return ack.ids.includes(message.id) || (ack.through !== null && message.createdAt <= ack.through);
}

/** Pick only the notices that become reports and decide their kind. Successful cron jobs and ordinary messages are not reports. */
function reportKindOf(notice: RoomNotice | null | undefined): ReportKind | null {
  if (!notice) return null;
  if (
    notice.kind === "card_review" ||
    notice.kind === "card_blocked" ||
    notice.kind === "card_done"
  )
    return notice.kind;
  if (notice.kind === "cron_result" && notice.status === "error") return "cron_failed";
  return null;
}

/**
 * Unacknowledged reports in order of occurrence.
 *
 * - Acknowledged reports (`ReportAck`) are excluded. Per report, and anything before the old watermark counts as acknowledged too.
 * - NPCs not on the map are excluded — there is nobody to walk over.
 * - Notices replaced by a system message because the assigned NPC is asleep (`senderId === null`) are excluded too. The notice
 *   stays in the room, so the user does not miss it.
 */
export function pendingReports(
  messages: readonly RoomMessage[],
  acknowledged: ReportAck,
  presentNpcIds: readonly string[],
): ReportItem[] {
  const present = new Set(presentNpcIds);
  const items: ReportItem[] = [];
  for (const message of messages) {
    const kind = reportKindOf(message.notice);
    if (!kind) continue;
    const npcId = message.senderId;
    if (!npcId || !present.has(npcId)) continue;
    if (isReportAcknowledged(acknowledged, message)) continue;
    const notice = message.notice as Extract<RoomNotice, { npcName: string }>;
    const isCard = kind !== "cron_failed";
    items.push({
      messageId: message.id,
      npcId,
      npcName: notice.npcName || message.senderName,
      kind,
      cardId: isCard ? ((notice as { cardId: string }).cardId ?? null) : null,
      boardSlug: isCard ? ((notice as { boardSlug: string }).boardSlug ?? null) : null,
      jobId: isCard ? null : ((notice as { jobId: string }).jobId ?? null),
      cardTitle: isCard
        ? (notice as { cardTitle: string }).cardTitle
        : (notice as { jobName: string }).jobName,
      summary: message.content,
      createdAt: message.createdAt,
    });
  }
  return items.sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.messageId.localeCompare(b.messageId)
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  );
}
