/**
 * The body of "retry summary". The route stays thin, and the judgment happens here.
 *
 * Since the transcript is already in the minutes, there's no need to reopen the meeting.
 * The adapter that actually runs the summary lives in the socket server and is reached
 * through the `meeting-registry.ts` hook.
 */
import type { MeetingOutcome, ParsedMeetingOutcome } from "./meeting-outcome";
import type { ResummarizeInput } from "./meeting-registry";

export type MinutesForSummary = {
  id: string;
  channelId: string;
  topic: string;
  transcript: string;
  initiatorId: string | null;
  participants: Array<{ id: string; name: string; type: string }>;
  summaryStatus: string;
  outcome: MeetingOutcome | null;
};

export type ResummarizeMinutesDeps = {
  loadMinutes: (minutesId: string) => Promise<MinutesForSummary | null>;
  loadChannelOwner: (channelId: string) => Promise<string | null>;
  /** The hook plugged in by the socket server. If absent (tests, early CLI), the summary
   * can't be run. */
  resummarize: ((input: ResummarizeInput) => Promise<ParsedMeetingOutcome>) | undefined;
  saveSummary: (minutesId: string, summary: ParsedMeetingOutcome) => Promise<void>;
};

export type ResummarizeMinutesResult =
  | { ok: true; summary: ParsedMeetingOutcome }
  | {
      ok: false;
      status: 403 | 404 | 409 | 503;
      errorCode: "forbidden" | "not_found" | "already_registered" | "summarizer_unavailable";
    };

export async function resummarizeMinutes(
  args: { minutesId: string; userId: string; locale?: string | null },
  deps: ResummarizeMinutesDeps,
): Promise<ResummarizeMinutesResult> {
  const minutes = await deps.loadMinutes(args.minutesId);
  if (!minutes) return { ok: false, status: 404, errorCode: "not_found" };

  const ownerId = await deps.loadChannelOwner(minutes.channelId);
  const canManage =
    (ownerId !== null && ownerId === args.userId) ||
    (minutes.initiatorId !== null && minutes.initiatorId === args.userId);
  if (!canManage) return { ok: false, status: 403, errorCode: "forbidden" };

  // If the card has already been created, swapping out the draft would make the minutes and
  // the board disagree with each other.
  if (minutes.outcome?.registered)
    return { ok: false, status: 409, errorCode: "already_registered" };

  if (!deps.resummarize) return { ok: false, status: 503, errorCode: "summarizer_unavailable" };

  const summary = await deps.resummarize({
    minutesId: minutes.id,
    channelId: minutes.channelId,
    userId: args.userId,
    topic: minutes.topic,
    transcript: minutes.transcript,
    participants: minutes.participants
      .filter((participant) => participant.type === "npc")
      .map((participant) => ({ npcId: participant.id, name: participant.name })),
    locale: args.locale,
  });
  await deps.saveSummary(minutes.id, summary);
  return { ok: true, summary };
}
