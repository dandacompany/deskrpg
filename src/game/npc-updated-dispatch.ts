/**
 * **Two shapes** flow through the `npc:updated` socket event.
 *
 * - The old shape `{ npcId, name?, direction?, appearance? }` — sent by appearance/direction edits
 *   (`socket-handlers.ts`).
 * - The new shape `{ npc: ProjectedNpc }` — sent by the roster toggle (`npc-roster-socket.ts`).
 *
 * While the scene's listener looked only at `data.npcId`, the new shape was **silently ignored**. A clocked-out
 * NPC kept standing on other people's screens, and no error occurred. So the decision is pulled
 * out of the simulation into a pure function — the decision alone can be checked in node without a socket.
 */

export type LegacyNpcUpdatedPayload = {
  npcId?: string;
  name?: string;
  direction?: string;
  appearance?: unknown;
};

export type ProjectedNpcLike = {
  id: string;
  name: string;
  positionX: number | null;
  positionY: number | null;
  direction: string | null;
  appearance?: unknown;
  active: boolean;
};

export type NpcUpdatedPayload = LegacyNpcUpdatedPayload & { npc?: ProjectedNpcLike | null };

export type NpcUpdatedAction =
  | { kind: "ignore" }
  | { kind: "remove"; npcId: string }
  | {
      kind: "update";
      npcId: string;
      fields: { name?: string; direction?: string; appearance?: unknown };
    }
  | {
      kind: "spawn";
      npc: {
        id: string;
        name: string;
        positionX: number;
        positionY: number;
        direction: string;
        appearance?: unknown;
      };
    };

/**
 * @param hasSprite Whether a sprite with that id already exists in the scene.
 */
export function decideNpcUpdate(
  data: NpcUpdatedPayload | null | undefined,
  hasSprite: (npcId: string) => boolean,
): NpcUpdatedAction {
  if (!data) return { kind: "ignore" };

  const npc = data.npc;
  if (npc) {
    if (!npc.id) return { kind: "ignore" };
    // NPCs who clocked out or lost their seat are removed from the map. Drawing an NPC without a seat
    // sends the sprite to a NaN position because the coordinates are null.
    if (!npc.active || npc.positionX === null || npc.positionY === null) {
      return { kind: "remove", npcId: npc.id };
    }
    if (hasSprite(npc.id)) {
      return {
        kind: "update",
        npcId: npc.id,
        fields: {
          name: npc.name,
          direction: npc.direction ?? undefined,
          appearance: npc.appearance,
        },
      };
    }
    return {
      kind: "spawn",
      npc: {
        id: npc.id,
        name: npc.name,
        positionX: npc.positionX,
        positionY: npc.positionY,
        direction: npc.direction || "down",
        appearance: npc.appearance,
      },
    };
  }

  if (!data.npcId || !hasSprite(data.npcId)) return { kind: "ignore" };
  return {
    kind: "update",
    npcId: data.npcId,
    fields: { name: data.name, direction: data.direction, appearance: data.appearance },
  };
}
