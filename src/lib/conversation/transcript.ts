// A record of conversation turns. Pure — the timestamp is injected by the caller (for test
// determinism).

export type Turn = {
  seq: number;
  speakerId: string;
  displayName: string;
  content: string;
  timestamp: number;
};

/** The speakerId for a user's remark. Used to decide the role in Hermes's
 * conversation_history. */
export const USER_SPEAKER_ID = "user";

export class Transcript {
  private readonly turns: Turn[] = [];
  private readonly counts = new Map<string, number>();
  private readonly lastSpoke = new Map<string, number>();

  add(speakerId: string, displayName: string, content: string, now: number): Turn {
    const turn: Turn = {
      seq: this.turns.length + 1,
      speakerId,
      displayName,
      content,
      timestamp: now,
    };
    this.turns.push(turn);
    this.counts.set(speakerId, (this.counts.get(speakerId) ?? 0) + 1);
    this.lastSpoke.set(speakerId, now);
    return turn;
  }

  all(): Turn[] {
    return [...this.turns];
  }

  recent(n: number): Turn[] {
    return this.turns.slice(-n);
  }

  turnCountFor(speakerId: string): number {
    return this.counts.get(speakerId) ?? 0;
  }

  lastSpokeAt(speakerId: string): number {
    return this.lastSpoke.get(speakerId) ?? 0;
  }

  /**
   * Serializes into the shape of Hermes /v1/runs's conversation_history.
   * A user's remark gets role="user"; an NPC's remark gets role="assistant".
   * Why the speaker's name is prefixed onto content: in multi-party conversation, the model
   * needs to know who said what, and role alone can't distinguish between NPCs.
   */
  toConversationHistory(limit: number): Array<{ role: string; content: string }> {
    return this.recent(limit).map((t) => ({
      role: t.speakerId === USER_SPEAKER_ID ? "user" : "assistant",
      content: `${t.displayName}: ${t.content}`,
    }));
  }
}
