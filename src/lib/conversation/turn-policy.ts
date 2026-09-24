// Per-conversation-mode turn policy. Pure functions — no I/O, no adapter, socket, or DB.

export type ConversationMode = "peer" | "meeting" | "group";

export type Participant = {
  npcId: string;
  displayName: string;
  /** Is this participant inside the conversation area and eligible to speak (spec §3.5 seated gate) */
  seated: boolean;
  turnCount: number;
  lastSpokeAt: number;
};

/** peer is a 2-person round-robin, so raising a hand isn't needed (spec D10). */
export function needsPolling(mode: ConversationMode): boolean {
  return mode !== "peer";
}

export function eligibleParticipants(
  all: Participant[],
  remainingTurns: (npcId: string) => number,
): Participant[] {
  return all.filter((x) => x.seated && remainingTurns(x.npcId) > 0);
}

export function selectNextSpeaker(
  mode: ConversationMode,
  candidates: Participant[],
  lastSpeakerId: string | null,
): Participant | null {
  if (candidates.length === 0) return null;

  if (mode === "peer") {
    const other = candidates.find((c) => c.npcId !== lastSpeakerId);
    return other ?? candidates[0];
  }

  // meeting / group — the participant who has gone longest without speaking (fairness, D9)
  return candidates.reduce((oldest, c) => (c.lastSpokeAt < oldest.lastSpokeAt ? c : oldest));
}
