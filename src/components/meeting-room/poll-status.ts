export interface PollRaiseItem {
  name: string;
  reason?: string;
}

export function formatPollRaises(raises: Array<string | PollRaiseItem> | undefined): string[] {
  if (!Array.isArray(raises)) return [];

  return raises
    .map((raise) => {
      if (typeof raise === "string") return raise;
      if (raise && typeof raise.name === "string") return raise.name;
      return null;
    })
    .filter((name): name is string => Boolean(name));
}

/** Broker passes contain NPC IDs; legacy payloads may already contain display names. */
export function formatPollPasses(
  passes: readonly string[] | undefined,
  npcs: readonly { id: string; name: string }[],
  unknownName: string,
): string[] {
  const names = new Map(npcs.map((npc) => [npc.id, npc.name]));
  return (passes ?? []).map(
    (value) => names.get(value) ?? (npcs.some((npc) => npc.name === value) ? value : unknownName),
  );
}

/**
 * The locale key for the poll status note, or null when there is nothing to add. The server
 * sends `polling` when a poll starts, which the heading already says; any other value is a
 * status this client does not know, shown as a generic phrase rather than its raw code.
 */
export function pollStatusNoteKey(status: unknown): string | null {
  if (typeof status !== "string" || status === "" || status === "polling") return null;
  return "meeting.pollStatus.other";
}
