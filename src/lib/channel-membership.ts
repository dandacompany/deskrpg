/**
 * Channel membership for code that also runs inside the socket server. `cron-access.ts` answers
 * the same question for REST routes but imports `next/server`, which the standalone socket
 * server cannot load (see server-runtime-imports.test.ts).
 */
import { and, eq } from "drizzle-orm";

import { channelMembers, channels, db } from "@/db";

/** The channel owner or a row in channel_members. A missing channel is false. */
export async function isChannelMember(channelId: string, userId: string): Promise<boolean> {
  const [channel] = await db
    .select({ ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return false;
  if (channel.ownerId === userId) return true;
  const [member] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  return !!member;
}

export type ChannelMemberAccessResult =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 404;
      errorCode: "not_a_member" | "channel_not_found";
      error: string;
    };

export type ChannelMemberAccessDeps = {
  loadChannelOwner: (channelId: string) => Promise<string | null>;
  loadMembership: (channelId: string, userId: string) => Promise<boolean>;
};

/**
 * The owner-or-member check as a route answer: 404 for a missing channel, 403 for a non-member.
 * Meeting minutes, the NPC roster and anything else a channel member may read share it.
 */
export async function resolveChannelMemberAccess(args: {
  userId: string;
  channelId: string;
  deps: ChannelMemberAccessDeps;
}): Promise<ChannelMemberAccessResult> {
  const ownerId = await args.deps.loadChannelOwner(args.channelId);
  if (!ownerId) {
    return {
      ok: false,
      status: 404,
      errorCode: "channel_not_found",
      error: "Channel not found",
    };
  }

  if (ownerId === args.userId) {
    return { ok: true };
  }

  const isMember = await args.deps.loadMembership(args.channelId, args.userId);
  if (!isMember) {
    return {
      ok: false,
      status: 403,
      errorCode: "not_a_member",
      error: "Not a member",
    };
  }

  return { ok: true };
}
