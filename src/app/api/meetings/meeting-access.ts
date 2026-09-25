import type { ChannelMemberAccessDeps } from "@/lib/channel-membership";

export type MeetingMinutesOwnerAccessResult =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 404;
      errorCode: "channel_not_found" | "not_channel_owner";
      error: string;
    };

export async function resolveMeetingMinutesOwnerAccess(args: {
  userId: string;
  channelId: string;
  deps: ChannelMemberAccessDeps;
}): Promise<MeetingMinutesOwnerAccessResult> {
  const ownerId = await args.deps.loadChannelOwner(args.channelId);
  if (!ownerId) {
    return {
      ok: false,
      status: 404,
      errorCode: "channel_not_found",
      error: "Channel not found",
    };
  }

  if (ownerId !== args.userId) {
    return {
      ok: false,
      status: 403,
      errorCode: "not_channel_owner",
      error: "Only the channel owner can delete meeting minutes",
    };
  }

  return { ok: true };
}

/**
 * Whether one can register a meeting's result or have its summary redone. Same as the criterion for
 * controlling a meeting (`canControlMeeting` — the host or the channel owner).
 */
export function canManageMeetingMinutes(args: {
  userId: string;
  ownerId: string | null;
  minutes: { initiatorId: string | null };
}): boolean {
  if (args.ownerId && args.ownerId === args.userId) return true;
  return Boolean(args.minutes.initiatorId) && args.minutes.initiatorId === args.userId;
}
