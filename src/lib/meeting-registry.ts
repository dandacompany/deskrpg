/**
 * Meeting hook registry — the only path by which routes (`src/app/**`) reach the socket server's adapter.
 *
 * Same pattern as `automation-registry.ts`. Routes never import `src/server/**`
 * (`app-server-boundary.test.ts`). The real implementation is plugged into `globalThis` when the
 * socket server starts.
 */
import type { OutcomeParticipant, ParsedMeetingOutcome } from "./meeting-outcome";

export type ResummarizeInput = {
  minutesId: string;
  channelId: string;
  userId: string;
  topic: string;
  transcript: string;
  /** Employees who attended the meeting. Candidates both for producing the summary and for follow-up work. */
  participants: OutcomeParticipant[];
  /** Language of the new summary — the requester's (null when the request carries no language cookie). */
  locale?: string | null;
};

export type MeetingHooks = {
  /** Regenerates the summary from the stored transcript. Doesn't touch the DB — the route is what writes. */
  resummarize(input: ResummarizeInput): Promise<ParsedMeetingOutcome>;
};

const KEY = "__deskrpg_meeting_hooks__";
const g = globalThis as typeof globalThis & Record<string, MeetingHooks | undefined>;

export function registerMeetingHooks(hooks: MeetingHooks): void {
  g[KEY] = hooks;
}

export function unregisterMeetingHooks(): void {
  g[KEY] = undefined;
}

export function getMeetingHooks(): MeetingHooks | undefined {
  const hooks = g[KEY];
  return hooks && typeof hooks === "object" ? hooks : undefined;
}
