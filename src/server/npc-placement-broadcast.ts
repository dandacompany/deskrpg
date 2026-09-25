/**
 * Announces NPCs the server seated on its own (hiring, quick start, clocking in) to the maps
 * already open in that channel. It reuses `npc:updated { npc }` — the event the roster toggle
 * sends — so a client spawns the sprite and rereads its lists exactly as it does for a clock-in.
 */
import { selectNpcById as selectNpcByIdDefault } from "../lib/npc-projection";

type PlacementIo = { to(room: string): { emit(event: string, payload: unknown): void } };

type PlacementDeps = {
  selectNpcById?: (
    npcId: string,
  ) => Promise<({ channelId: string } & Record<string, unknown>) | null>;
  /** Drops the channel's room runtimes and motion layout so the new NPC is heard and walks. */
  invalidate: (channelId: string) => void;
};

export async function broadcastPlacedNpcs(
  io: PlacementIo,
  channelId: string,
  npcIds: string[],
  deps: PlacementDeps,
): Promise<void> {
  const selectNpcById = deps.selectNpcById ?? selectNpcByIdDefault;
  deps.invalidate(channelId);
  for (const npcId of npcIds) {
    const npc = await selectNpcById(npcId);
    if (!npc || npc.channelId !== channelId) continue;
    io.to(channelId).emit("npc:updated", { npc });
  }
}
