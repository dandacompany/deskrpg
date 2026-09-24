import type { RoomSummary } from "@/lib/chat-rooms-policy";

/**
 * Removes NPCs/people who are **already in the room** from the invite screen's candidates.
 *
 * Without this filter, names that are already members would be listed unchecked, and
 * picking and inviting them would do nothing (the server silently ignores duplicates).
 * That looks like "I invited them but it didn't work." When `room` is absent
 * (creating a new room), returns the candidates as-is.
 *
 * When `selfUserId` is given, the user themself is always excluded from the user
 * candidates — whether creating a room or inviting, the creator/inviter is already
 * a member so there's no reason to pick them (for a new room, `room` is null so the
 * member filter doesn't apply).
 */
export function candidatesForInvite<N extends { id: string }, U extends { id: string }>(
  room: RoomSummary | null | undefined,
  npcs: N[],
  users: U[],
  selfUserId?: string | null,
): { npcs: N[]; users: U[] } {
  const withoutSelf = selfUserId ? users.filter((user) => user.id !== selfUserId) : users;
  if (!room) return { npcs, users: withoutSelf };
  const npcMembers = new Set(
    room.members.filter((member) => member.kind === "npc").map((member) => member.id),
  );
  const userMembers = new Set(
    room.members.filter((member) => member.kind === "user").map((member) => member.id),
  );
  return {
    npcs: npcs.filter((npc) => !npcMembers.has(npc.id)),
    users: withoutSelf.filter((user) => !userMembers.has(user.id)),
  };
}
