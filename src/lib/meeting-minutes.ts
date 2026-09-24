import { parseDbArray } from "./db-json";
import type { MeetingOutcome } from "./meeting-outcome";

type MeetingParticipant = {
  id: string;
  name: string;
  type: string;
  agentId?: string;
};

type MeetingMinutesRecord = {
  participants?: unknown;
  keyTopics?: unknown;
  outcomeJson?: unknown;
};

/** PG returns an object, SQLite returns a string. Treated as no result if the shape is wrong. */
function readOutcome(stored: unknown): MeetingOutcome | null {
  let value = stored;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<MeetingOutcome>;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.followUps)) return null;
  return { ...candidate, project: candidate.project ?? null } as MeetingOutcome;
}

/**
 * The return type is spelled out explicitly. Leaving it to inference collapses into an
 * intersection type that can't be spread/overwritten when the caller passes a literal
 * object, becoming `never` — in tests, `normalized.participants` blew up with "does not
 * exist on type 'never'".
 */
export function normalizeMeetingMinutesRecord<T extends MeetingMinutesRecord>(
  record: T,
): Omit<T, "participants" | "keyTopics" | "outcomeJson"> & {
  participants: MeetingParticipant[];
  keyTopics: string[];
  outcome: MeetingOutcome | null;
} {
  // TS can't narrow the generic T's rest via an Omit intersection — assert it by destructuring all three keys together.
  const { outcomeJson, participants, keyTopics, ...rest } = record;
  return {
    ...(rest as Omit<T, "participants" | "keyTopics" | "outcomeJson">),
    outcome: readOutcome(outcomeJson),
    participants: parseDbArray<MeetingParticipant>(participants),
    keyTopics: parseDbArray<string>(keyTopics).filter(
      (topic): topic is string => typeof topic === "string",
    ),
  };
}
