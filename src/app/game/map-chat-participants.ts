/**
 * Per room, the NPCs that took part in this conversation.
 *
 * Closing the chat room sends NPCs that were beside us back to their seats, and when the user sends a message again
 * every participant of **that room** comes back — so "who were the participants" must be held even after the panel
 * closes. NPCs called via the context menu are not participants (that is 1:1).
 *
 * Why split per room: an NPC called in a planning room must not come back because someone spoke in the office room.
 */
export class MapChatParticipants {
  private readonly byRoom = new Map<string, Set<string>>();

  noteCalled(roomId: string | null | undefined, npcId: string, reason?: string): void {
    if (reason !== "map-chat" || !roomId) return;
    let ids = this.byRoom.get(roomId);
    if (!ids) {
      ids = new Set<string>();
      this.byRoom.set(roomId, ids);
    }
    ids.add(npcId);
  }

  /**
   * The user explicitly sent them back — do not call them again on the next message.
   * Sending back is an action on the map, not in a room, so remove them from **every room**.
   */
  dismiss(npcId: string): void {
    for (const ids of this.byRoom.values()) ids.delete(npcId);
  }

  /** Those to call again: participants of that room who are not beside us now (went back to their seats). */
  recallTargets(roomId: string | null | undefined, present: ReadonlySet<string>): string[] {
    if (!roomId) return [];
    return [...(this.byRoom.get(roomId) ?? [])].filter((id) => !present.has(id));
  }
}
