/** How many people and NPCs the meeting room has spots for — seats, then standing spots. */
export type MeetingCapacity = { seats: number; standing: number };

/**
 * How many participants will not get a meeting spot and attend from where they stand. The server no longer refuses a
 * full room; this only lets the opener know before starting. Unknown capacity says nothing.
 */
export function meetingOverflow(
  capacity: MeetingCapacity | null,
  npcCount: number,
  peopleInRoom: number,
): number {
  if (!capacity) return 0;
  return Math.max(0, npcCount + Math.max(1, peopleInRoom) - capacity.seats - capacity.standing);
}
