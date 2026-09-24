import type { RoomSummary } from "@/lib/chat-rooms-policy";

/**
 * Decides whether the NPC right-click "그룹 대화로 초대" slots into an existing room or opens the compose screen.
 *
 * Even for a group room, if the channel chat panel is collapsed (= the user is not looking at that room)
 * do not invite — to prevent being quietly invited into a room nobody is looking at. `channelChatVisible`
 * is true only when the panel is open and in room view (`ChatPanel` decides).
 */
export type ContextInviteDecision =
  | { kind: "invite"; roomId: string }
  | { kind: "already-member"; roomId: string }
  | { kind: "compose" };

export function decideContextInvite(args: {
  visible: boolean;
  currentRoom: RoomSummary | null | undefined;
  /** The NPC being invited — if already a member of the room, report it instead of a silent no-op. */
  npcId?: string;
}): ContextInviteDecision {
  const { visible, currentRoom, npcId } = args;
  if (visible && currentRoom?.kind === "group") {
    const alreadyMember =
      npcId != null &&
      currentRoom.members.some((member) => member.kind === "npc" && member.id === npcId);
    if (alreadyMember) return { kind: "already-member", roomId: currentRoom.id };
    return { kind: "invite", roomId: currentRoom.id };
  }
  return { kind: "compose" };
}
