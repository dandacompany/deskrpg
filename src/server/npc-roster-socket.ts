import { setNpcActive as setNpcActiveDefault } from "../lib/npc-roster";
import { selectNpcById as selectNpcByIdDefault } from "../lib/npc-projection";

type RosterSocket = {
  id: string;
  on(event: string, handler: (payload: unknown) => unknown): void;
  emit(event: string, payload: unknown): void;
};

type RosterIo = {
  to(room: string): { emit(event: string, payload: unknown): void };
};

/** Discussion broker — `config.participants` is the authority on which NPCs actually sit in this meeting. */
type MeetingBrokerLike = { config: { participants: Array<{ npcId: string }> } };

export type RegisterNpcRosterHandlersArgs = {
  io: RosterIo;
  socket: RosterSocket;
  deps: {
    /** Channels with a running discussion — keyed by `channelId`. The value holds the participant list. */
    activeBrokers: Map<string, MeetingBrokerLike>;
    user: { userId: string };
    isChannelOwner: (channelId: string, userId: string) => Promise<boolean>;
    setNpcActive?: (npcId: string, active: boolean) => Promise<void>;
    selectNpcById?: (npcId: string) => Promise<{ channelId: string } | null>;
  };
};

/**
 * Clocks one NPC in or out.
 *
 * It's a socket rather than REST because the meeting state lives only in the socket handler's closure
 * (`activeBrokers`) — routes can't see it. Removing a participant from the map mid-meeting leaves the
 * in-progress turn with nowhere to go, so only clocking out is blocked (clocking in is always allowed).
 *
 * The authority on "is this NPC in a meeting" is **the broker's `config.participants`**. A discussion does not
 * take all of the channel's NPCs — only the subset `start-discussion` filtered with `selectedNpcIds`
 * become participants (meeting-discussion.ts:477-480). So a channel-level check
 * (`activeBrokers.has(channelId)`) would also lock NPCs that weren't invited to the meeting.
 *
 * The participants in `meetingRooms` are **human socket.ids** and must not be used here.
 * Looking up by NPC id is always false, and conversely checking "is it non-empty" lets one person with the
 * meeting panel open block the owner's clock-out indefinitely (the room is never deleted).
 */
export function registerNpcRosterHandlers({ io, socket, deps }: RegisterNpcRosterHandlersArgs) {
  const {
    activeBrokers,
    user,
    isChannelOwner,
    setNpcActive = setNpcActiveDefault,
    selectNpcById = selectNpcByIdDefault,
  } = deps;

  socket.on("npc:set-active", async (payload: unknown) => {
    const { channelId, npcId, active } = (payload ?? {}) as {
      channelId?: string;
      npcId?: string;
      active?: boolean;
    };
    if (!channelId || !npcId || typeof active !== "boolean") return;

    if (!(await isChannelOwner(channelId, user.userId))) {
      socket.emit("npc:set-active:error", { npcId, errorCode: "forbidden" });
      return;
    }

    // Channel ownership grants rights only over that channel's NPCs. Using npcId unchecked would let
    // someone with just their own channel clock out NPCs in another's channel.
    const target = await selectNpcById(npcId);
    if (!target || target.channelId !== channelId) {
      socket.emit("npc:set-active:error", { npcId, errorCode: "npc_not_found" });
      return;
    }

    if (!active && isNpcInMeeting(activeBrokers, channelId, npcId)) {
      socket.emit("npc:set-active:error", { npcId, errorCode: "npc_in_meeting" });
      return;
    }

    await setNpcActive(npcId, active);
    const npc = await selectNpcById(npcId);
    // Notify the whole channel — other viewers' maps also have to add or remove the sprite.
    io.to(channelId).emit("npc:updated", { npc });
  });
}

function isNpcInMeeting(
  activeBrokers: Map<string, MeetingBrokerLike>,
  channelId: string,
  npcId: string,
): boolean {
  const participants = activeBrokers.get(channelId)?.config.participants;
  return participants?.some((p) => p.npcId === npcId) ?? false;
}
