/**
 * Speaker → appearance. Used by the round avatars in bubbles and headers.
 *
 * Appearance is not carried in messages — it already exists in the channel roster (employees) and the online list (people),
 * so look it up there. Look up by id first, and by name when the id is missing or does not match (old messages may
 * lack `senderId`). `null` when not found — the avatar is drawn with the default display.
 */
export type AvatarSubject = { kind: "npc" | "user"; id?: string | null; name: string };
export type AvatarLookup = (who: AvatarSubject) => unknown;

export type AvatarNpc = { id: string; name: string; appearance?: unknown };
export type AvatarPlayer = { userId?: string | null; name: string; appearance?: unknown };

export function createAvatarLookup(
  npcs: readonly AvatarNpc[],
  players: readonly AvatarPlayer[],
): AvatarLookup {
  return (who) => {
    if (who.kind === "npc") {
      const npc =
        (who.id ? npcs.find((entry) => entry.id === who.id) : undefined) ??
        npcs.find((entry) => entry.name === who.name);
      return npc?.appearance ?? null;
    }
    const player =
      (who.id ? players.find((entry) => entry.userId === who.id) : undefined) ??
      players.find((entry) => entry.name === who.name);
    return player?.appearance ?? null;
  };
}
