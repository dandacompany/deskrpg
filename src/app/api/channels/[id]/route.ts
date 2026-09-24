import {
  channelRowRevisionExpression,
  mapContentRevision,
  mapUpgradeCondition,
} from "@/lib/channel-map-revision";
import { resolveChannelMapUpgrade } from "@/lib/channel-map-upgrade";
import { backupChannelMap } from "@/lib/channel-map-backup";
import { requestMapRefresh } from "@/lib/channel-map-refresh";
import { normalizeNpcMotionConfig } from "@/lib/npc-motion-config";
import { db, isPostgres, jsonForDb } from "@/db";
import { channels, channelMembers, groupMembers, groups } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { getUserId } from "@/lib/internal-rpc";
import { parseDbJson } from "@/lib/db-json";
import { normalizeMeetingMap } from "@/game/meeting-map-normalization";
import { getChannelGatewayBinding } from "@/lib/gateway-resources";
import { getChannelBoard, syncBoardName } from "@/lib/kanban-boards";
import {
  summarizeChannelDetailAccess,
  summarizeChannelJoinAccess,
} from "@/lib/rbac/channel-access";
import { isChannelPasswordValid } from "@/lib/security-policy";
import { seatingMapFor } from "@/lib/seat-assignment";
import internalTransport from "@/lib/internal-transport.js";

const { buildInternalAuthHeaders, getInternalSocketBaseUrl } = internalTransport as {
  buildInternalAuthHeaders: () => Record<string, string>;
  getInternalSocketBaseUrl: () => string;
};

// GET /api/channels/:id — get channel details + map data
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const loadSelected = () =>
      db
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
          motionConfig: channels.motionConfig,
          createdAt: channels.createdAt,
          updatedAt: channels.updatedAt,
          rowRevision: channelRowRevisionExpression(channels.updatedAt, isPostgres),
        })
        .from(channels)
        .leftJoin(groups, eq(channels.groupId, groups.id))
        .where(eq(channels.id, id))
        .limit(1);
    const rows = await loadSelected();

    if (rows.length === 0) {
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    }

    let channel = rows[0];

    // Check membership
    const memberRows = await db
      .select({
        role: channelMembers.role,
        lastX: channelMembers.lastX,
        lastY: channelMembers.lastY,
      })
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
        return NextResponse.json(
          { errorCode: "password_required", error: "password_required" },
          { status: 403 },
        );
      }

      return NextResponse.json(
        { errorCode: "group_membership_required", error: "group membership required" },
        { status: 403 },
      );
    }

    const resolved = await resolveChannelMapUpgrade<typeof channel>(channel, {
      backup: backupChannelMap,
      begin: (channelId) => requestMapRefresh("begin", channelId),
      save: async (selected, mapData) => {
        const [saved] = await db
          .update(channels)
          .set({
            mapData: jsonForDb(mapData),
            updatedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
          })
          .where(mapUpgradeCondition(channels, selected, isPostgres))
          .returning({
            mapData: channels.mapData,
            updatedAt: channels.updatedAt,
            rowRevision: channelRowRevisionExpression(channels.updatedAt, isPostgres),
          });
        return saved ? { ...selected, ...saved } : null;
      },
      refetch: async () => (await loadSelected())[0] ?? null,
      finish: async (channelId, lease) => {
        await requestMapRefresh("finish", channelId, lease);
      },
    });
    if (!resolved)
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    // A concurrent owner/privacy/group change must pass authorization anew.
    if (
      resolved.ownerId !== channel.ownerId ||
      resolved.groupId !== channel.groupId ||
      resolved.isPublic !== channel.isPublic
    )
      return GET(req, { params: Promise.resolve({ id }) });
    channel = resolved;
    const mapRevision = mapContentRevision(channel.mapData);

    const parsedMapData = parseDbJson<Record<string, unknown>>(channel.mapData) ?? channel.mapData;
    const parsedMapConfig =
      parseDbJson<Record<string, unknown>>(channel.mapConfig) ?? channel.mapConfig;

    const gatewayBinding = await getChannelGatewayBinding(id);
    let effectiveMap;
    try {
      effectiveMap = normalizeMeetingMap(parsedMapData, parsedMapConfig);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "회의실 맵을 확인할 수 없습니다" },
        { status: 422 },
      );
    }
    const channelWithoutGateway = { ...channel } as Record<string, unknown>;
    delete channelWithoutGateway.gatewayConfig;
    delete channelWithoutGateway.rowRevision;
    return NextResponse.json({
      channel: {
        ...channelWithoutGateway,
        mapRevision,
        mapData: effectiveMap.mapData,
        meetingSpace: effectiveMap.meetingSpace,
        mapConfig: parsedMapConfig,
        // Default when empty — fold it here so the client does not interpret empty values separately.
        motionConfig: normalizeNpcMotionConfig(parseDbJson(channel.motionConfig)),
        isOwner,
        isMember,
        canView: true,
        canJoin: joinAccess.allowed,
        requiresGroupMembership: !joinAccess.allowed,
        joinAccessReason: joinAccess.reason,
        requiresPassword: detailAccess.requiresPassword,
        groupId: channel.groupId,
        groupName: channel.groupName,
        hasGateway: !!gatewayBinding?.resource.id,
        gatewayConfig: {
          gatewayId: gatewayBinding?.resource.id ?? null,
          displayName: gatewayBinding?.resource.displayName ?? null,
          url: gatewayBinding?.resource.baseUrl ?? null,
        },
        lastX,
        lastY,
      },
    });
  } catch (err) {
    console.error("Failed to fetch channel:", err);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_channel", error: "Failed to fetch channel" },
      { status: 500 },
    );
  }
}

// PUT /api/channels/:id — update channel (owner only)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    // Check ownership
    const rows = await db
      .select({
        ownerId: channels.ownerId,
        isPublic: channels.isPublic,
        name: channels.name,
        mapConfig: channels.mapConfig,
      })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    }

    if (rows[0].ownerId !== userId) {
      return NextResponse.json(
        { errorCode: "forbidden", error: "Not authorized" },
        { status: 403 },
      );
    }

    const previousName = rows[0].name;
    const body = await req.json();
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.maxPlayers !== undefined) updates.maxPlayers = body.maxPlayers;
    if (body.mapData !== undefined) {
      try {
        const normalizedMap = normalizeMeetingMap(
          body.mapData,
          body.mapConfig ?? parseDbJson(rows[0].mapConfig),
        ).mapData;
        const seating = seatingMapFor({ mapData: normalizedMap, mapConfig: body.mapConfig });
        if (seating && seating.seats.length === 0) {
          return NextResponse.json(
            { errorCode: "map_has_no_desk_seats", error: "Map needs at least one desk chair" },
            { status: 400 },
          );
        }
        updates.mapData = jsonForDb(normalizedMap);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "회의실 맵을 확인할 수 없습니다" },
          { status: 422 },
        );
      }
    }
    if (body.mapConfig !== undefined) updates.mapConfig = jsonForDb(body.mapConfig);
    // NPC walking speed. Do not trust it; clamp before saving — a bad value must not freeze every NPC in the channel.
    const motionConfig =
      body.motionConfig !== undefined ? normalizeNpcMotionConfig(body.motionConfig) : undefined;
    if (motionConfig) updates.motionConfig = jsonForDb(motionConfig);

    if (body.isPublic !== undefined) {
      updates.isPublic = body.isPublic;
      // When going public, clear password
      if (body.isPublic === true) {
        updates.password = null;
      }
    }

    // Handle password update
    if (body.password !== undefined) {
      if (typeof body.password !== "string" || !isChannelPasswordValid(body.password)) {
        return NextResponse.json(
          {
            errorCode: "channel_password_length_invalid",
            error: "Password must be at least 8 characters",
          },
          { status: 400 },
        );
      }
      updates.password = await hashPassword(body.password);
    }

    updates.updatedAt = (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date;

    const [updated] = await db.update(channels).set(updates).where(eq(channels.id, id)).returning({
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

    // If the name actually changed and a board link row exists, match the board display name too (R2).
    // The rename already succeeded even if this fails — swallow and log; the next poll retries.
    if (body.name !== undefined && updated.name !== previousName) {
      try {
        if (await getChannelBoard(id)) {
          const synced = await syncBoardName(id, updated.name);
          if (!synced.ok) {
            console.warn(`[channels] board name not synced for ${id}: ${synced.code}`);
          }
        }
      } catch (err) {
        console.warn(`[channels] syncBoardName threw for ${id}:`, err);
      }
    }

    // Emit socket event to notify clients of channel update
    try {
      await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildInternalAuthHeaders(),
        },
        body: JSON.stringify({
          event: "channel:updated",
          room: id,
          // `motionConfig` is an optional field included only when changed — it does not create a new event.
          payload: {
            name: updated.name,
            isPublic: updated.isPublic,
            ...(motionConfig ? { motionConfig } : {}),
          },
        }),
      });
    } catch {
      // Non-critical: log but don't fail the request
      console.warn("Failed to emit channel:updated socket event");
    }

    return NextResponse.json({ channel: updated });
  } catch (err) {
    console.error("Failed to update channel:", err);
    return NextResponse.json(
      { errorCode: "failed_to_update_channel", error: "Failed to update channel" },
      { status: 500 },
    );
  }
}

// DELETE /api/channels/:id — delete channel (owner only)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId)
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const rows = await db
      .select({ ownerId: channels.ownerId })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { errorCode: "channel_not_found", error: "Channel not found" },
        { status: 404 },
      );
    }

    if (rows[0].ownerId !== userId) {
      return NextResponse.json(
        { errorCode: "forbidden", error: "Not authorized" },
        { status: 403 },
      );
    }

    // Notify connected players before deletion
    try {
      await fetch(`${getInternalSocketBaseUrl()}/_internal/emit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildInternalAuthHeaders(),
        },
        body: JSON.stringify({
          event: "channel:deleted",
          room: id,
          payload: { channelId: id },
        }),
      });
      // Brief delay to let clients receive the event before DB deletion
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Non-critical
    }

    // CASCADE will delete channel_members, npcs, chat_messages
    await db.delete(channels).where(eq(channels.id, id));

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Failed to delete channel:", err);
    return NextResponse.json(
      { errorCode: "failed_to_delete_channel", error: "Failed to delete channel" },
      { status: 500 },
    );
  }
}
