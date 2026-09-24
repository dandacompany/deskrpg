/**
 * Meeting outcome room notice — when a meeting that produced follow-up work ends, one
 * line is left in the office room.
 *
 * A meeting is not an automation event (it doesn't go through the Hermes event stream /
 * cursor). So this goes out the same path as approval notices rather than the event sink
 * (`ingest`): the row is written by `appendRoomMessage`, and broadcast via the
 * `automation-registry` hook.
 *
 * **The functions here never throw.** A notice showing up late carries a different
 * weight than the meeting minutes not being saved, or registration failing.
 */
import { requestEmitRoomMessage } from "@/lib/automation-registry";
import { appendRoomMessage, ensureOfficeRoom, getChannelOwnerId } from "@/lib/chat-rooms";
import type { RoomNotice } from "@/lib/chat-rooms-policy";
import type {
  MeetingOutcome,
  MeetingOutcomeRegistered,
  MeetingSummaryStatus,
} from "@/lib/meeting-outcome";
import { rewriteRoomNotices } from "@/lib/room-notice-rewrite";

export type MeetingOutcomeNotice = Extract<RoomNotice, { kind: "meeting_outcome" }>;

/**
 * The condition isn't "did the meeting end" but **"is there follow-up work to
 * register"**. A summarization failure is different from zero follow-ups, but neither
 * is announced in the room — retrying is left to the meeting screen and the minutes.
 */
export function shouldAnnounceOutcome(
  outcome: MeetingOutcome | null | undefined,
  summaryStatus: MeetingSummaryStatus,
): boolean {
  return summaryStatus === "ok" && !!outcome && outcome.followUps.length > 0;
}

/** Carries only ids and counts. Project/subproject names can change, so no copy is kept here. */
export function buildMeetingOutcomeNotice(input: {
  minutesId: string;
  topic: string;
  outcome: MeetingOutcome;
}): MeetingOutcomeNotice {
  return {
    kind: "meeting_outcome",
    minutesId: input.minutesId,
    topic: input.topic,
    followUpCount: input.outcome.followUps.length,
    recommended: input.outcome.project?.recommended === true,
  };
}

export async function announceMeetingOutcome(input: {
  channelId: string;
  minutesId: string | null | undefined;
  topic: string;
  outcome: MeetingOutcome | null | undefined;
  summaryStatus: MeetingSummaryStatus;
}): Promise<void> {
  try {
    if (!input.minutesId || !input.outcome) return;
    if (!shouldAnnounceOutcome(input.outcome, input.summaryStatus)) return;
    const ownerId = await getChannelOwnerId(input.channelId);
    if (!ownerId) return;
    const room = await ensureOfficeRoom(input.channelId, ownerId);
    const message = await appendRoomMessage({
      roomId: room.id,
      senderKind: "system",
      senderId: null,
      senderName: "",
      // A locale-agnostic fallback. The renderer builds the actual sentence in the viewer's language.
      content: input.topic,
      notice: buildMeetingOutcomeNotice({
        minutesId: input.minutesId,
        topic: input.topic,
        outcome: input.outcome,
      }),
    });
    requestEmitRoomMessage(room.id, message);
  } catch (error) {
    console.warn(
      "[meeting] Failed to post the meeting outcome notice",
      { channelId: input.channelId },
      error,
    );
  }
}

/**
 * Once registration finishes, the result is rewritten onto **the same line** — the
 * renderer doesn't re-read the minutes, and scrolling back to an old message still shows
 * that moment's result. Resolution is not something the client hides.
 */
export async function markMeetingOutcomeNoticeRegistered(input: {
  channelId: string;
  minutesId: string;
  registered: MeetingOutcomeRegistered;
}): Promise<void> {
  await rewriteRoomNotices({
    channelId: input.channelId,
    needle: input.minutesId,
    // LIKE only narrows the candidates — it could be a substring of a different meeting id, so match exactly.
    update: (notice) =>
      notice.kind === "meeting_outcome" && notice.minutesId === input.minutesId
        ? {
            ...notice,
            resolved: {
              boardSlug: input.registered.boardSlug,
              tenant: input.registered.tenant,
              taskCount: input.registered.taskIds.length,
              by: input.registered.by,
              at: input.registered.at,
            },
          }
        : null,
  });
}
