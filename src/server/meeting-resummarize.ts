/**
 * Regenerates the summary of saved minutes.
 *
 * After a meeting ends, neither the broker nor the summary adapter remains. So among the employees who attended,
 * it's handed again to the first one **still in the channel whose adapter resolves**. The session is kept separate
 * from the meeting session — if the summary prompt mixed into that employee's conversation context, their next
 * utterance would be contaminated.
 */
import type { NpcAdapter } from "../lib/adapters/types";
import type { OutcomeParticipant, ParsedMeetingOutcome } from "../lib/meeting-outcome";
import type { ResummarizeInput } from "../lib/meeting-registry";

type NpcRef = { id: string; name: string };

export type ResummarizerDeps<Npc extends NpcRef> = {
  getNpcConfigsForChannel: (channelId: string) => Promise<Npc[]>;
  resolveAdapter: (
    npc: Npc,
    ctx: { sessionScope: string; userId: string },
  ) => Promise<{ adapter: NpcAdapter; sessionKey: string } | { excluded: unknown }>;
  generateMeetingSummary: (
    adapter: NpcAdapter,
    sessionKey: string,
    topic: string,
    transcript: string,
    participants?: OutcomeParticipant[],
    locale?: string | null,
  ) => Promise<ParsedMeetingOutcome>;
};

export function createResummarizer<Npc extends NpcRef>(deps: ResummarizerDeps<Npc>) {
  return async function resummarize(input: ResummarizeInput): Promise<ParsedMeetingOutcome> {
    const present = new Map(
      (await deps.getNpcConfigsForChannel(input.channelId)).map((npc) => [npc.id, npc]),
    );
    for (const participant of input.participants) {
      const npc = present.get(participant.npcId);
      if (!npc) continue;
      const resolved = await deps.resolveAdapter(npc, {
        sessionScope: `minutes-${input.minutesId}-summary`,
        userId: input.userId,
      });
      if (!("adapter" in resolved)) continue;
      return deps.generateMeetingSummary(
        resolved.adapter,
        resolved.sessionKey,
        input.topic,
        input.transcript,
        input.participants,
        input.locale,
      );
    }
    // Retrying gives the same result — distinguish it from a failure.
    return { status: "skipped", keyTopics: [], conclusions: null, outcome: null };
  };
}
