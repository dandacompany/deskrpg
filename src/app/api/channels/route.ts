import { isManagedSshUrl } from "@/lib/hermes/setup/transport-id";
import { db, jsonForDb } from "@/db";
import { normalizeMeetingMap } from "@/game/meeting-map-normalization";
import {
  buildOfficeEnvironment,
  OFFICE_ENVIRONMENTS,
  type OfficeEnvironmentId,
} from "@/game/three/office-environments";
import {
  channels,
  channelMembers,
  characters,
  groupMembers,
  groupPermissions,
  groups,
  userPermissionOverrides,
  users,
} from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { getUserId } from "@/lib/internal-rpc";
import {
  bindGatewayToChannel,
  getAccessibleGatewayResource,
  upsertOwnedGatewayResource,
} from "@/lib/gateway-resources";
import { hireGatewayProfilesIntoChannel } from "@/lib/npc-roster";
import { ensureOfficeRoom } from "@/lib/chat-rooms";
import { effectiveMapSpawn } from "@/lib/effective-map-spawn";
import { parseDbJson } from "@/lib/db-json";
import {
  detectOfficeEnvironmentId,
  summarizeParticipants,
  type ParticipantRow,
} from "@/lib/channel-list-summary";
import { resolvePermission, type PermissionEffect } from "@/lib/rbac/permissions";
import type { GroupMemberRole, SystemRole } from "@/lib/rbac/constants";
import { isChannelPasswordValid } from "@/lib/security-policy";
import { generateChannelInviteCode } from "@/lib/invite-code";
import {
  summarizeChannelCreateAccess,
  summarizeChannelDetailAccess,
  summarizeChannelJoinAccess,
} from "@/lib/rbac/channel-access";

function isOfficeEnvironmentId(value: unknown): value is OfficeEnvironmentId {
  return (
    typeof value === "string" && OFFICE_ENVIRONMENTS.some((environment) => environment.id === value)
  );
}

async function canCreateChannel(userId: string, groupId: string) {
  const [user] = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { allowed: false, reason: "default_deny" as const };
  }

  const [membership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);

  const groupEffectRows = await db
    .select({ effect: groupPermissions.effect })
    .from(groupPermissions)
    .where(
      and(
        eq(groupPermissions.groupId, groupId),
        eq(groupPermissions.permissionKey, "create_channel"),
      ),
    );

  const userEffectRows = await db
    .select({ effect: userPermissionOverrides.effect })
    .from(userPermissionOverrides)
    .where(
      and(
        eq(userPermissionOverrides.groupId, groupId),
        eq(userPermissionOverrides.userId, userId),
        eq(userPermissionOverrides.permissionKey, "create_channel"),
      ),
    );

  const permissionDecision = resolvePermission({
    systemRole: user.systemRole as SystemRole,
    groupRole: (membership?.role as GroupMemberRole | undefined) ?? null,
    permissionKey: "create_channel",
    groupEffects: groupEffectRows.map((row) => row.effect as PermissionEffect),
    userEffects: userEffectRows.map((row) => row.effect as PermissionEffect),
  });

  return summarizeChannelCreateAccess({
    hasActiveGroupMembership: !!membership?.role,
    permissionAllowed: permissionDecision.allowed,
  });
}

// GET /api/channels — list all channels (public + private) with membership info
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

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
        createdAt: channels.createdAt,
        groupId: channels.groupId,
        mapData: channels.mapData,
        groupName: groups.name,
        ownerNickname: users.nickname,
        memberRole: channelMembers.role,
        groupMemberRole: groupMembers.role,
      })
      .from(channels)
      .leftJoin(users, eq(channels.ownerId, users.id))
      .leftJoin(groups, eq(channels.groupId, groups.id))
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)),
      )
      .leftJoin(
        groupMembers,
        and(eq(groupMembers.groupId, channels.groupId), eq(groupMembers.userId, userId)),
      )
      .orderBy(channels.createdAt);

    const result = rows
      .map((r) => {
        const isOwner = r.ownerId === userId;
        const isChannelMember = isOwner || !!r.memberRole;
        const hasActiveGroupMembership = !!r.groupMemberRole;
        const canView = r.isPublic || isChannelMember || hasActiveGroupMembership;
        const detailAccess = summarizeChannelDetailAccess({
          groupId: r.groupId,
          isPublic: r.isPublic ?? true,
          hasActiveGroupMembership,
          isChannelMember,
        });

        if (!canView || !detailAccess.allowed) return null;

        const joinAccess = summarizeChannelJoinAccess({
          groupId: r.groupId,
          isPublic: r.isPublic ?? true,
          hasActiveGroupMembership,
        });

        return {
          id: r.id,
          name: r.name,
          description: r.description,
          ownerId: r.ownerId,
          isPublic: r.isPublic,
          isLocked: !r.isPublic,
          inviteCode: r.inviteCode,
          maxPlayers: r.maxPlayers,
          createdAt: r.createdAt,
          ownerNickname: r.ownerNickname,
          isMember: isChannelMember,
          canView: true,
          canJoin: joinAccess.allowed,
          requiresGroupMembership: !joinAccess.allowed,
          joinAccessReason: joinAccess.reason,
          requiresPassword: detailAccess.requiresPassword,
          groupId: r.groupId,
          groupName: r.groupName,
          // For card thumbnails. Channels do not store an environment ID, so judge from the map (null if unknown).
          environmentId: detectOfficeEnvironmentId(r.mapData),
        };
      })
      .filter((channel): channel is NonNullable<typeof channel> => channel !== null);

    const participantsByChannel = await loadParticipants(
      result.map((channel) => ({ id: channel.id, ownerId: channel.ownerId })),
    );
    const withParticipants = result.map((channel) => {
      const summary = participantsByChannel.get(channel.id) ?? { count: 0, preview: [] };
      return { ...channel, memberCount: summary.count, participants: summary.preview };
    });

    return NextResponse.json({ channels: withParticipants, currentUserId: userId });
  } catch (err) {
    console.error("Failed to fetch channels:", err);
    return NextResponse.json(
      {
        errorCode: "failed_to_fetch_channels",
        error: "Failed to fetch channels",
      },
      { status: 500 },
    );
  }
}

/**
 * Participants per channel (owner + channel_members, people only). The preview appearance is each user's latest character —
 * a user may have several characters and no per-channel choice is stored.
 */
async function loadParticipants(list: Array<{ id: string; ownerId: string | null }>) {
  const out = new Map<string, ReturnType<typeof summarizeParticipants>>();
  if (list.length === 0) return out;
  const channelIds = list.map((channel) => channel.id);
  const memberRows = await db
    .select({
      channelId: channelMembers.channelId,
      userId: channelMembers.userId,
      joinedAt: channelMembers.joinedAt,
    })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, channelIds));
  const userIds = [
    ...new Set([
      ...memberRows.map((row) => row.userId),
      ...list.flatMap((channel) => (channel.ownerId ? [channel.ownerId] : [])),
    ]),
  ];
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, nickname: users.nickname })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const characterRows = userIds.length
    ? await db
        .select({
          userId: characters.userId,
          appearance: characters.appearance,
          updatedAt: characters.updatedAt,
        })
        .from(characters)
        .where(inArray(characters.userId, userIds))
    : [];
  const nickname = new Map(userRows.map((row) => [row.id, row.nickname]));
  const latest = new Map<string, { appearance: unknown; at: number }>();
  for (const row of characterRows) {
    const at = row.updatedAt ? new Date(row.updatedAt as string | Date).getTime() : 0;
    const prev = latest.get(row.userId);
    if (!prev || at > prev.at) latest.set(row.userId, { appearance: row.appearance, at });
  }
  const participant = (userId: string, joinedAt: Date | string | null): ParticipantRow => ({
    userId,
    nickname: nickname.get(userId) ?? null,
    appearance: parseDbJson(latest.get(userId)?.appearance ?? null),
    joinedAt,
  });
  for (const channel of list) {
    const rows = memberRows
      .filter((row) => row.channelId === channel.id)
      .map((row) => participant(row.userId, row.joinedAt as Date | string | null));
    if (channel.ownerId) rows.push(participant(channel.ownerId, null));
    out.set(channel.id, summarizeParticipants(rows, channel.ownerId ?? ""));
  }
  return out;
}

// POST /api/channels — create new channel
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name, description, isPublic, environmentId, password, gatewayConfig, groupId } = body;
    if (
      !(typeof gatewayConfig?.gatewayId === "string" && gatewayConfig.gatewayId) &&
      isManagedSshUrl(gatewayConfig?.url)
    ) {
      return NextResponse.json(
        { errorCode: "setup_invalid_request", error: "setup_invalid_request" },
        { status: 400 },
      );
    }

    if (!name || typeof name !== "string" || name.length < 1 || name.length > 100) {
      return NextResponse.json(
        {
          errorCode: "channel_name_required",
          error: "name is required (1-100 chars)",
        },
        { status: 400 },
      );
    }

    // The map template table is gone. Requests on the old contract are rejected rather than silently ignored.
    if (body.mapTemplateId !== undefined) {
      return NextResponse.json(
        {
          errorCode: "map_template_removed",
          error: "mapTemplateId is no longer supported; send environmentId",
        },
        { status: 400 },
      );
    }

    if (environmentId === undefined || environmentId === null || environmentId === "") {
      return NextResponse.json(
        {
          errorCode: "environment_required",
          error: "environmentId is required",
        },
        { status: 400 },
      );
    }

    if (!isOfficeEnvironmentId(environmentId)) {
      return NextResponse.json(
        {
          errorCode: "environment_unknown",
          error: "Unknown office environment",
        },
        { status: 400 },
      );
    }

    if (!groupId || typeof groupId !== "string") {
      return NextResponse.json(
        { errorCode: "group_id_required", error: "groupId is required" },
        { status: 400 },
      );
    }

    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!group) {
      return NextResponse.json(
        {
          errorCode: "channel_creation_forbidden",
          error: "channel creation forbidden",
        },
        { status: 403 },
      );
    }

    const access = await canCreateChannel(userId, groupId);
    if (!access.allowed) {
      if (access.reason === "group_membership_required") {
        return NextResponse.json(
          {
            errorCode: "group_membership_required",
            error: "group membership required",
          },
          { status: 403 },
        );
      }

      return NextResponse.json(
        {
          errorCode: "channel_creation_forbidden",
          error: "channel creation forbidden",
        },
        { status: 403 },
      );
    }

    // Code builds the environment layout. The channel keeps a copy, and later environment version upgrades
    // are handled by the upgrade path in GET /api/channels/:id.
    const environmentMap = buildOfficeEnvironment(environmentId);
    const spawn = effectiveMapSpawn(environmentMap);
    if (!spawn) {
      return NextResponse.json(
        { errorCode: "environment_unknown", error: "Office environment has no spawn" },
        { status: 400 },
      );
    }
    const mapConfig = {
      cols: environmentMap.width,
      rows: environmentMap.height,
      spawnCol: spawn.col,
      spawnRow: spawn.row,
    };

    const channelIsPublic = isPublic !== false;

    // Private channels require a password
    let passwordHash: string | null = null;
    if (!channelIsPublic) {
      if (!password || typeof password !== "string") {
        return NextResponse.json(
          {
            errorCode: "private_channel_password_required",
            error: "Private channels require a password",
          },
          { status: 400 },
        );
      }
      if (!isChannelPasswordValid(password)) {
        return NextResponse.json(
          {
            errorCode: "channel_password_length_invalid",
            error: "Password must be at least 8 characters",
          },
          { status: 400 },
        );
      }
      passwordHash = await hashPassword(password);
    }

    const inviteCode = generateChannelInviteCode();
    let effectiveMap;
    try {
      effectiveMap = normalizeMeetingMap(environmentMap, {
        spawnCol: mapConfig.spawnCol,
        spawnRow: mapConfig.spawnRow,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "회의실 맵을 확인할 수 없습니다" },
        { status: 422 },
      );
    }

    const [channel] = await db
      .insert(channels)
      .values({
        name: name.trim(),
        description: description?.trim() || null,
        ownerId: userId,
        groupId,
        isPublic: channelIsPublic,
        inviteCode,
        maxPlayers: 50,
        mapData: jsonForDb(effectiveMap.mapData),
        mapConfig: jsonForDb(mapConfig),
        password: passwordHash,
      })
      .returning();

    await ensureOfficeRoom(channel.id, userId);

    if (gatewayConfig?.gatewayId || gatewayConfig?.url) {
      try {
        const resource =
          typeof gatewayConfig.gatewayId === "string" && gatewayConfig.gatewayId
            ? ((await getAccessibleGatewayResource(userId, gatewayConfig.gatewayId))?.resource ??
              null)
            : gatewayConfig?.url
              ? await upsertOwnedGatewayResource({
                  ownerUserId: userId,
                  baseUrl: gatewayConfig.url,
                  token: typeof gatewayConfig.token === "string" ? gatewayConfig.token : "",
                  displayName:
                    typeof gatewayConfig.displayName === "string"
                      ? gatewayConfig.displayName
                      : undefined,
                })
              : null;

        if (!resource) {
          return NextResponse.json(
            {
              errorCode: "gateway_access_denied",
              error: "Gateway access denied",
            },
            { status: 403 },
          );
        }

        await bindGatewayToChannel({
          channelId: channel.id,
          gatewayId: resource.id,
          boundByUserId: userId,
        });
        // Connecting = clocking in. This gateway's profiles decide the channel's NPC roster.
        await hireGatewayProfilesIntoChannel(channel.id, resource.id);
      } catch (gatewayErr) {
        console.error("Failed to bind gateway resource during channel creation:", gatewayErr);
      }
    }

    // Auto-insert owner as member with role=owner
    await db.insert(channelMembers).values({
      channelId: channel.id,
      userId,
      role: "owner",
    });

    // Return channel without password hash
    const { password: channelPassword, ...channelWithoutPassword } = channel;
    void channelPassword;

    return NextResponse.json({ channel: channelWithoutPassword }, { status: 201 });
  } catch (err) {
    console.error("Failed to create channel:", err);
    return NextResponse.json(
      {
        errorCode: "failed_to_create_channel",
        error: "Failed to create channel",
      },
      { status: 500 },
    );
  }
}
