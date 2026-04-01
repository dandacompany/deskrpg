import { parseDbArray } from "./db-json";

type MeetingParticipant = {
  id: string;
  name: string;
  type: string;
  agentId?: string;
};

type MeetingMinutesRecord = {
  participants?: unknown;
  keyTopics?: unknown;
};

export function normalizeMeetingMinutesRecord<T extends MeetingMinutesRecord>(record: T) {
  return {
    ...record,
    participants: parseDbArray<MeetingParticipant>(record.participants),
    keyTopics: parseDbArray<string>(record.keyTopics).filter((topic): topic is string => typeof topic === "string"),
  };
}
