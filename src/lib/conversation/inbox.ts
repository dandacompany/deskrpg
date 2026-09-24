// The floor-grant queue. Pure — knows nothing about adapters, the transcript, or time.
//
// What this class replaces: the old engine kept only one mention alive when draining the
// command queue, and silently dropped the rest with no log (conversation-engine.ts
// drainCommands). The NPC that was called never even knew it had been called, and to the
// user it looked like "I called Danbi but Haneul speaks instead." Here, mentions stay queued
// and go out in order.

export type GrantSource = "user" | "mention";

export class FloorInbox {
  /** FIFO. At most one per NPC — duplicate mentions collapse. */
  private mentions: string[] = [];
  /** Only one user mention is kept (the last one wins). */
  private user: string | null = null;

  push(npcId: string, source: GrantSource): void {
    if (source === "user") {
      // A person's rapid successive clicks mean "no, this one instead," not "make both speak."
      this.user = npcId;
      // Absorbs the case where the same NPC would otherwise speak once for the user mention
      // and again for a pending mention.
      this.mentions = this.mentions.filter((id) => id !== npcId);
      return;
    }
    // Collapses if already queued — preserving the order it first arrived in. Since the
    // transcript is shared, that NPC's turn prompt will carry both mentions as recent
    // utterances anyway.
    if (this.mentions.includes(npcId)) return;
    this.mentions.push(npcId);
  }

  /**
   * Pops the next speaker. `null` if there is none.
   *
   * A user mention comes first if present, and skips the `isEligible` check — since a human
   * explicitly directed it, it bypasses the quota.
   *
   * Mentions are popped FIFO, skipping any that aren't eligible and reporting them via
   * `onSkipped`. Never dropping one silently is the whole reason this class exists.
   */
  take(isEligible: (npcId: string) => boolean, onSkipped: (npcId: string) => void): string | null {
    if (this.user !== null) {
      const npcId = this.user;
      this.user = null;
      return npcId;
    }
    while (this.mentions.length > 0) {
      const npcId = this.mentions.shift()!;
      if (isEligible(npcId)) return npcId;
      onSkipped(npcId);
    }
    return null;
  }

  pendingCount(): number {
    return this.mentions.length + (this.user === null ? 0 : 1);
  }

  clear(): void {
    this.mentions = [];
    this.user = null;
  }
}
