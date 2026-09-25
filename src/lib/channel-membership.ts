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
