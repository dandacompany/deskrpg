/**
 * Delivery-target rows for the cron forms. Hermes lists the gateway's connected platforms plus one
 * `bot-chat:<profile>` target per profile on the whole gateway, named `Bot Chat (<profile>)`. A
 * channel offers only its own employees' bot chats, labelled with the employee's name; a target
 * the job already uses always stays so it can be unchecked.
 */
import type { CronDeliveryTarget } from "@/lib/hermes/deskrpg-plugin-types";

const BOT_CHAT_PREFIX = "bot-chat:";

export type ChannelProfile = { profileName: string; npcName: string };

export type DeliverRow = {
  id: string;
  kind: "local" | "platform" | "botChat";
  target: CronDeliveryTarget | null;
  /** For bot-chat targets: the Hermes profile, and the employee's name when it is in this channel. */
  profileName?: string;
  npcName?: string;
};

export function deliverRows(
  targets: CronDeliveryTarget[],
  chosen: string[],
  /** This channel's employees. Without it, every bot-chat target is offered. */
  channelProfiles?: ChannelProfile[],
): DeliverRow[] {
  const known = new Map(targets.map((t) => [t.id, t]));
  const names = channelProfiles
    ? new Map(channelProfiles.map((p) => [p.profileName, p.npcName]))
    : null;
  const ids = Array.from(new Set(["local", ...known.keys(), ...chosen]));
  const rows = ids.flatMap((id): DeliverRow[] => {
    const target = known.get(id) ?? null;
    if (id === "local") return [{ id, kind: "local", target }];
    if (!id.startsWith(BOT_CHAT_PREFIX)) return [{ id, kind: "platform", target }];
    const profileName = id.slice(BOT_CHAT_PREFIX.length);
    const npcName = names?.get(profileName);
    if (names && !npcName && !chosen.includes(id)) return [];
    return [{ id, kind: "botChat", target, profileName, ...(npcName ? { npcName } : {}) }];
  });
  const order = { local: 0, platform: 1, botChat: 2 } as const;
  return rows.sort((a, b) => order[a.kind] - order[b.kind]);
}
