/**
 * NPCs walking over because they were called via map chat.
 *
 * Why it is needed: a mentioned NPC walks over to the person, and on arrival the default is to open the 1:1 dialog.
 * But an NPC called via map chat answers **in map chat**, so that dialog would cover the very panel
 * where the answer appears. So "did this walk start from map chat" must be held until
 * arrival.
 *
 * The reason is known only at call time and the decision is needed at arrival time — this class is that gap.
 */
export class MapChatWalkers {
  private readonly waiting = new Set<string>();

  /**
   * Record an NPC call. A call without `reason` (context menu) **invalidates** a previous map chat
   * wait — without clearing it, when that NPC arrives the 1:1 dialog the user just explicitly
   * requested gets swallowed. The game scene silently ignores recalls of an NPC already walking,
   * so arrival happens from the original walk and the entry stays alive until then.
   */
  noteCall(npcId: string, reason?: string): void {
    if (reason === "map-chat") this.waiting.add(npcId);
    else this.waiting.delete(npcId);
  }

  /**
   * Consumed only once in arrival handling. `true` means this walk was started by map chat, so
   * do not open the 1:1 dialog. Since it is consumed, the same NPC's next arrival is `false`.
   */
  takeOnArrival(npcId: string): boolean {
    return this.waiting.delete(npcId);
  }

  /** Discard the wait when the walk ends without arrival (returning to the seat, etc.). */
  forget(npcId: string): void {
    this.waiting.delete(npcId);
  }
}
