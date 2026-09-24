/**
 * The place that calls `GET /api/npcs`. It is split out of the simulation for two reasons —
 * separate, it can be tested in node by swapping only fetch, and when it goes wrong here it appears as the failure
 * **not a single NPC shows on the map and no error appears**.
 *
 * That failure really happened. When `this.channelId` was empty the old code called `/api/npcs`
 * without a channel (the scene restart path — `pendingChannelData` becomes null once consumed),
 * and when the route returned 400, `data.npcs || []` swallowed it as an empty list.
 */

export type PrefetchedNpc = {
  id: string;
  name: string;
  positionX: number;
  positionY: number;
  direction: string;
  appearance?: unknown;
};

export type NpcPrefetchResult =
  | { ok: true; npcs: PrefetchedNpc[] }
  | { ok: false; reason: "no-channel" | "http-error" | "network-error"; message: string };

/**
 * Read the channel's NPC list. Without a channel it **does not call** — `/api/npcs` without a channel
 * is 400 (`channel_id_required`), and swallowing that as an empty list makes
 * "0 NPCs" look normal to the user.
 */
export async function fetchChannelNpcs(
  channelId: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<NpcPrefetchResult> {
  if (!channelId) {
    return {
      ok: false,
      reason: "no-channel",
      message: "channelId is empty — skipping the NPC prefetch (the map will have no NPCs)",
    };
  }

  try {
    const res = await fetchImpl(`/api/npcs?channelId=${encodeURIComponent(channelId)}`);
    if (!res.ok) {
      return {
        ok: false,
        reason: "http-error",
        message: `GET /api/npcs?channelId=${channelId} responded ${res.status}`,
      };
    }
    const data = (await res.json()) as { npcs?: PrefetchedNpc[] };
    return { ok: true, npcs: data.npcs ?? [] };
  } catch (err) {
    return {
      ok: false,
      reason: "network-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
