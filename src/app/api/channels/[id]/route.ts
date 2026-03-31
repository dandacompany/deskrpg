import { db } from "@/db";
import { channels, channelMembers, groupMembers, groups } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { getUserId } from "@/lib/internal-rpc";
import { summarizeChannelDetailAccess, summarizeChannelJoinAccess } from "@/lib/rbac/channel-access";

// GET /api/channels/:id — get channel details + map data
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const rows = await db
      .select({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        ownerId: channels.ownerId,
        isPublic: channels.isPublic,
        inviteCode: channels.inviteCode,
        maxPlayers: channels.maxPlayers,
        groupId: channels.groupId,
        groupName: groups.name,
        mapData: channels.mapData,
        mapConfig: channels.mapConfig,
        gatewayConfig: channels.gatewayConfig,
        createdAt: channels.createdAt,
        updatedAt: channels.updatedAt,
      })
      .from(channels)
      .leftJoin(groups, eq(channels.groupId, groups.id))
      .where(eq(channels.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const channel = rows[0];

    // Check membership
    const memberRows = await db
      .select({ role: channelMembers.role, lastX: channelMembers.lastX, lastY: channelMembers.lastY })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, userId)))
      .limit(1);
    const groupMemberRows = channel.groupId
      ? await db
        .select({ role: groupMembers.role })
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, channel.groupId), eq(groupMembers.userId, userId)))
        .limit(1)
      : [];

    const memberRole = memberRows[0]?.role ?? null;
    const lastX = memberRows[0]?.lastX ?? null;
    const lastY = memberRows[0]?.lastY ?? null;
    const isOwner = channel.ownerId === userId;
    const isMember = !!memberRole || isOwner;
    const hasActiveGroupMembership = !!groupMemberRows[0]?.role;
    const detailAccess = summarizeChannelDetailAccess({
      groupId: channel.groupId,
      isPublic: channel.isPublic ?? true,
      hasActiveGroupMembership,
      isChannelMember: isMember,
    });
    const joinAccess = summarizeChannelJoinAccess({
      groupId: channel.groupId,
      isPublic: channel.isPublic ?? true,
      hasActiveGroupMembership,
    });

    if (!detailAccess.allowed) {
      if (detailAccess.reason === "legacy_private_password_required") {
        return NextResponse.json({ error: "password_required" }, { status: 403 });
      }

      return NextResponse.json(
        { errorCode: "group_membership_required", error: "group membership required" },
        { status: 403 },
      );
    }

    const { gatewayConfig, ...channelWithoutGateway } = channel;
    return NextResponse.json({
      channel: {
        ...channelWithoutGateway,
        isOwner,
        isMember,
        canView: true,
        canJoin: joinAccess.allowed,
        requiresGroupMembership: !joinAccess.allowed,
        joinAccessReason: joinAccess.reason,
        requiresPassword: detailAccess.requiresPassword,
        groupId: channel.groupId,
        groupName: channel.groupName,
        hasGateway: !!(gatewayConfig as { url?: string } | null)?.url,
        lastX,
        lastY,
      },
    });
  } catch (err) {
    console.error("Failed to fetch channel:", err);
    return NextResponse.json({ error: "Failed to fetch channel" }, { status: 500 });
  }
}

// PUT /api/channels/:id — update channel (owner only)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    // Check ownership
    const rows = await db
      .select({ ownerId: channels.ownerId, isPublic: channels.isPublic })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    if (rows[0].ownerId !== userId) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const body = await req.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.maxPlayers !== undefined) updates.maxPlayers = body.maxPlayers;
    if (body.mapData !== undefined) updates.mapData = body.mapData;
    if (body.mapConfig !== undefined) updates.mapConfig = body.mapConfig;

    if (body.isPublic !== undefined) {
      updates.isPublic = body.isPublic;
      // When going public, clear password
      if (body.isPublic === true) {
        updates.password = null;
      }
    }

    // Handle password update
    if (body.password !== undefined) {
      if (typeof body.password !== "string" || body.password.length < 4) {
        return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
      }
      updates.password = await hashPassword(body.password);
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(channels)
      .set(updates)
      .where(eq(channels.id, id))
      .returning({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        ownerId: channels.ownerId,
        isPublic: channels.isPublic,
        inviteCode: channels.inviteCode,
        maxPlayers: channels.maxPlayers,
        mapData: channels.mapData,
        mapConfig: channels.mapConfig,
        createdAt: channels.createdAt,
        updatedAt: channels.updatedAt,
      });

    // Emit socket event to notify clients of channel update
    try {
      const socketPort = (parseInt(process.env.PORT ?? "3000") + 1).toString();
      await fetch(`http://localhost:${socketPort}/_internal/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "channel:updated",
          room: id,
          payload: { name: updated.name, isPublic: updated.isPublic },
        }),
      });
    } catch {
      // Non-critical: log but don't fail the request
      console.warn("Failed to emit channel:updated socket event");
    }

    return NextResponse.json({ channel: updated });
  } catch (err) {
    console.error("Failed to update channel:", err);
    return NextResponse.json({ error: "Failed to update channel" }, { status: 500 });
  }
}

// DELETE /api/channels/:id — delete channel (owner only)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const rows = await db
      .select({ ownerId: channels.ownerId })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    if (rows[0].ownerId !== userId) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    // Notify connected players before deletion
    try {
      const socketPort = (parseInt(process.env.PORT ?? "3000") + 1).toString();
      await fetch(`http://localhost:${socketPort}/_internal/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "channel:deleted",
          room: id,
          payload: { channelId: id },
        }),
      });
      // Brief delay to let clients receive the event before DB deletion
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // Non-critical
    }

    // CASCADE will delete channel_members, npcs, chat_messages
    await db.delete(channels).where(eq(channels.id, id));

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete channel:", err);
    return NextResponse.json({ error: "Failed to delete channel" }, { status: 500 });
  }
}
