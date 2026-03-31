import { db, jsonForDb } from "@/db";
import {
  channels,
  channelMembers,
  groupMembers,
  groupPermissions,
  groups,
  mapTemplates,
  npcs,
  userPermissionOverrides,
  users,
} from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { internalRpc, getUserId } from "@/lib/internal-rpc";
import { resolvePermission, type PermissionEffect } from "@/lib/rbac/permissions";
import { summarizeChannelJoinAccess } from "@/lib/rbac/channel-access";

function generateInviteCode(): string {
  return Math.random().toString(36).substring(2, 10);
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

  return resolvePermission({
    systemRole: user.systemRole,
    groupRole: membership?.role ?? null,
    permissionKey: "create_channel",
    groupEffects: groupEffectRows.map((row) => row.effect as PermissionEffect),
    userEffects: userEffectRows.map((row) => row.effect as PermissionEffect),
  });
}

// GET /api/channels — list all channels (public + private) with membership info
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

        if (!canView) return null;

        const joinAccess = summarizeChannelJoinAccess({
          isPublic: r.isPublic ?? true,
          hasActiveGroupMembership,
          isChannelMember,
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
          requiresPassword: !r.isPublic && !isChannelMember,
          groupId: r.groupId,
          groupName: r.groupName,
          playerCount: 0,
        };
      })
      .filter((channel): channel is NonNullable<typeof channel> => channel !== null);

    return NextResponse.json({ channels: result, currentUserId: userId });
  } catch (err) {
    console.error("Failed to fetch channels:", err);
    return NextResponse.json({ error: "Failed to fetch channels" }, { status: 500 });
  }
}

// POST /api/channels — create new channel
export async function POST(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { name, description, isPublic, mapTemplateId, password, gatewayConfig, defaultNpc, groupId } = body;

    if (!name || typeof name !== "string" || name.length < 1 || name.length > 100) {
      return NextResponse.json({ error: "name is required (1-100 chars)" }, { status: 400 });
    }

    if (!mapTemplateId) {
      return NextResponse.json({ error: "mapTemplateId is required" }, { status: 400 });
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
        { errorCode: "channel_creation_forbidden", error: "channel creation forbidden" },
        { status: 403 },
      );
    }

    const access = await canCreateChannel(userId, groupId);
    if (!access.allowed) {
      return NextResponse.json(
        { errorCode: "channel_creation_forbidden", error: "channel creation forbidden" },
        { status: 403 },
      );
    }

    const [template] = await db
      .select()
      .from(mapTemplates)
      .where(eq(mapTemplates.id, mapTemplateId))
      .limit(1);

    if (!template) {
      return NextResponse.json({ error: "Map template not found" }, { status: 404 });
    }

    // Parse layers/objects if stored as JSON string (SQLite)
    const templateLayers = typeof template.layers === "string" ? JSON.parse(template.layers) : template.layers;
    const templateObjects = typeof template.objects === "string" ? JSON.parse(template.objects) : template.objects;

    // If template has tiledJson, store it directly as channel mapData
    const templateTiledJson = template.tiledJson
      ? (typeof template.tiledJson === "string" ? JSON.parse(template.tiledJson) : template.tiledJson)
      : null;

    const channelIsPublic = isPublic !== false;

    // Private channels require a password
    let passwordHash: string | null = null;
    if (!channelIsPublic) {
      if (!password || typeof password !== "string" || password.length < 4) {
        return NextResponse.json({ error: "Private channels require a password (min 4 chars)" }, { status: 400 });
      }
      passwordHash = await hashPassword(password);
    }

    const inviteCode = generateInviteCode();

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
        mapData: jsonForDb(templateTiledJson || { layers: templateLayers, objects: templateObjects }),
        mapConfig: jsonForDb({ cols: template.cols, rows: template.rows, spawnCol: template.spawnCol, spawnRow: template.spawnRow }),
        password: passwordHash,
        gatewayConfig: jsonForDb(gatewayConfig || null),
      })
      .returning();

    // Auto-insert owner as member with role=owner
    await db.insert(channelMembers).values({
      channelId: channel.id,
      userId,
      role: "owner",
    });

    // --- Default NPC creation ---
    if (defaultNpc && gatewayConfig) {
      try {
        const agentId = defaultNpc.agentId || "main";
        const isMainAgent = agentId === "main";

        // Setup agent on gateway via RPC (non-blocking on failure)
        try {
          if (!isMainAgent) {
            await internalRpc(channel.id, "agents.create", { name: agentId, workspace: `/workspace/${agentId}` });
            console.log(`[channel] Created new agent: ${agentId}`);
          }

          // Write persona files
          if (defaultNpc.identity) {
            await internalRpc(channel.id, "agents.files.set", {
              agentId,
              name: "IDENTITY.md",
              content: defaultNpc.identity,
            });
          }
          if (defaultNpc.soul) {
            await internalRpc(channel.id, "agents.files.set", {
              agentId,
              name: "SOUL.md",
              content: defaultNpc.soul,
            });
          }
          if (defaultNpc.meetingProtocol) {
            await internalRpc(channel.id, "agents.files.set", {
              agentId,
              name: "AGENTS.md",
              content: defaultNpc.meetingProtocol,
            });
          }
          await internalRpc(channel.id, "agents.files.set", {
            agentId,
            name: "USER.md",
            content: `# User\n- Name: Channel Owner\n`,
          });

          console.log(`[channel] Initialized agent ${agentId} with persona files`);
        } catch (agentErr) {
          console.warn("Agent setup failed (NPC will still be created):", agentErr instanceof Error ? agentErr.message : agentErr);
        }

        // Insert NPC into database (always, even if agent setup failed)
        const npcPositionX = template.spawnCol + 2;
        const npcPositionY = template.spawnRow;

        await db.insert(npcs).values({
          channelId: channel.id,
          name: defaultNpc.name || "AI Assistant",
          positionX: npcPositionX,
          positionY: npcPositionY,
          direction: "down",
          appearance: jsonForDb(defaultNpc.appearance || {
            bodyType: "female",
            layers: {
              body: { itemKey: "body", variant: "light" },
              eyes: { itemKey: "eye_color", variant: "blue" },
              hair: { itemKey: "hair_pixie", variant: "blonde" },
              torso: { itemKey: "torso_clothes_longsleeve2_buttoned", variant: "white" },
              legs: { itemKey: "legs_formal", variant: "teal" },
              feet: { itemKey: "feet_shoes_basic", variant: "brown" },
            },
          }),
          openclawConfig: jsonForDb({
            agentId,
            sessionKeyPrefix: `ot-${channel.id.slice(0, 8)}-${agentId}`,
            personaConfig: {
              identity: defaultNpc.identity || "",
              soul: defaultNpc.soul || "",
            },
          }),
        });
      } catch (npcErr) {
        console.error("Failed to create default NPC:", npcErr);
      }
    }

    // Return channel without password hash
    const { password: _pw, ...channelWithoutPassword } = channel;

    return NextResponse.json({ channel: channelWithoutPassword }, { status: 201 });
  } catch (err) {
    console.error("Failed to create channel:", err);
    return NextResponse.json({ error: "Failed to create channel" }, { status: 500 });
  }
}
