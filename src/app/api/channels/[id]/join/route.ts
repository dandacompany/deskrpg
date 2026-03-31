import { db } from "@/db";
import { channels, channelMembers, groupMembers } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { verifyPassword } from "@/lib/password";
import { summarizeChannelJoinAccess } from "@/lib/rbac/channel-access";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

// POST /api/channels/:id/join
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    // Check if channel exists
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (!channel) {
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    }

    // Check if already a member
    const [existing] = await db
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, userId)))
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

    if (existing) {
      return NextResponse.json({
        channel: { id: channel.id, name: channel.name, description: channel.description },
      });
    }

    // Private channel: require password
    if (!channel.isPublic) {
      const body = await req.json().catch(() => ({}));
      const { password } = body;

      if (!password || typeof password !== "string") {
        return NextResponse.json(
          { errorCode: "password_required", error: "password_required" },
          { status: 401 },
        );
      }

      if (!channel.password) {
        return NextResponse.json(
          { errorCode: "channel_misconfigured", error: "Channel misconfigured" },
          { status: 500 },
        );
      }

      const valid = await verifyPassword(password, channel.password);
      if (!valid) {
        return NextResponse.json(
          { errorCode: "wrong_password", error: "wrong_password" },
          { status: 401 },
        );
      }
    }

    // Register as member
    await db
      .insert(channelMembers)
      .values({
        channelId: id,
        userId,
        role: "member",
      })
      .onConflictDoNothing();

    return NextResponse.json({
      channel: { id: channel.id, name: channel.name, description: channel.description },
    });
  } catch (err) {
    console.error("Failed to join channel:", err);
    return NextResponse.json(
      { errorCode: "failed_to_join_channel", error: "Failed to join channel" },
      { status: 500 },
    );
  }
}
