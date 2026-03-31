import { db } from "@/db";
import { channels, channelMembers, groupMembers } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { summarizeChannelJoinAccess } from "@/lib/rbac/channel-access";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// GET /api/channels/join/:code — resolve invite code to channel
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { code } = await params;

  try {
    const rows = await db
      .select({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        isPublic: channels.isPublic,
        ownerId: channels.ownerId,
        groupId: channels.groupId,
      })
      .from(channels)
      .where(eq(channels.inviteCode, code))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { errorCode: "invalid_invite_code", error: "Invalid invite code" },
        { status: 404 },
      );
    }

    const channel = rows[0];

    const [existing] = await db
      .select({ channelId: channelMembers.channelId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, userId)))
      .limit(1);

    const groupMembership = channel.groupId
      ? await db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
        .limit(1)
      : [];

    const joinAccess = summarizeChannelJoinAccess({
      isPublic: channel.isPublic ?? true,
      hasActiveGroupMembership: !!groupMembership[0]?.role,
      isChannelMember: !!existing || channel.ownerId === userId,
    });

    if (!joinAccess.allowed) {
      const errorCode = joinAccess.reason === "groupless_public_browse_only"
        ? "public_channel_browse_only"
        : "group_membership_required";
      const error = joinAccess.reason === "groupless_public_browse_only"
        ? "public channel browse only"
        : "group membership required";

      return NextResponse.json({ errorCode, error }, { status: 403 });
    }

    // Public channels: auto-register as member
    // Private channels: only resolve — user must enter password via /api/channels/[id]/join
    if (channel.isPublic && !existing && channel.ownerId !== userId) {
      await db
        .insert(channelMembers)
        .values({ channelId: channel.id, userId, role: "member" })
        .onConflictDoNothing();
    }

    return NextResponse.json({ channel });
  } catch (err) {
    console.error("Failed to resolve invite code:", err);
    return NextResponse.json(
      { errorCode: "failed_to_resolve_invite_code", error: "Failed to resolve invite code" },
      { status: 500 },
    );
  }
}
