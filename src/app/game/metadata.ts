import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { channelMembers, channels, db, groupMembers } from "@/db";
import { verifyJWT } from "@/lib/jwt";
import { summarizeChannelDetailAccess } from "@/lib/rbac/channel-access";

const GAME_PAGE_FALLBACK_TITLE = "DeskRPG";

export function buildGamePageMetadataTitle(channelName: string | null | undefined): string {
  const trimmedName = channelName?.trim();
  return trimmedName ? `DeskRPG - ${trimmedName}` : GAME_PAGE_FALLBACK_TITLE;
}

export function canExposeChannelNameForMetadata(args: {
  groupId: string | null;
  isPublic: boolean;
  hasActiveGroupMembership: boolean;
  isChannelMember: boolean;
}): boolean {
  return summarizeChannelDetailAccess(args).allowed;
}

export async function resolveGamePageMetadataTitle(channelId: string | null | undefined): Promise<string> {
  if (!channelId) {
    return GAME_PAGE_FALLBACK_TITLE;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    return GAME_PAGE_FALLBACK_TITLE;
  }

  const payload = await verifyJWT(token);
  const userId = payload?.userId;
  if (!userId) {
    return GAME_PAGE_FALLBACK_TITLE;
  }

  const [channel] = await db
    .select({
      id: channels.id,
      name: channels.name,
      ownerId: channels.ownerId,
      isPublic: channels.isPublic,
      groupId: channels.groupId,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) {
    return GAME_PAGE_FALLBACK_TITLE;
  }

  const isOwner = channel.ownerId === userId;

  const memberRows = isOwner
    ? [{ role: "owner" }]
    : await db
        .select({ role: channelMembers.role })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
        .limit(1);

  const groupMemberRows = channel.groupId
    ? await db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
        .limit(1)
    : [];

  const canExpose = canExposeChannelNameForMetadata({
    groupId: channel.groupId,
    isPublic: channel.isPublic ?? true,
    hasActiveGroupMembership: Boolean(groupMemberRows[0]?.role),
    isChannelMember: isOwner || Boolean(memberRows[0]?.role),
  });

  return canExpose ? buildGamePageMetadataTitle(channel.name) : GAME_PAGE_FALLBACK_TITLE;
}
