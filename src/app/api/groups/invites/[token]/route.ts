import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db, groupInvites, groupMembers, groups, isPostgres, users } from "@/db";
import {
  getAuthenticatedUserId,
  resolveInviteAcceptance,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import type { GroupMemberRole } from "@/lib/rbac/constants";

function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { token } = await params;
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return NextResponse.json(
      { errorCode: "invalid_invite_code", error: "invalid invite code" },
      { status: 404 },
    );
  }

  const [invite] = await db
    .select({
      id: groupInvites.id,
      token: groupInvites.token,
      groupId: groupInvites.groupId,
      createdBy: groupInvites.createdBy,
      targetUserId: groupInvites.targetUserId,
      targetLoginId: groupInvites.targetLoginId,
      expiresAt: groupInvites.expiresAt,
      acceptedAt: groupInvites.acceptedAt,
      revokedAt: groupInvites.revokedAt,
      groupName: groups.name,
      groupSlug: groups.slug,
    })
    .from(groupInvites)
    .innerJoin(groups, eq(groupInvites.groupId, groups.id))
    .where(eq(groupInvites.token, normalizedToken))
    .limit(1);

  if (!invite) {
    return NextResponse.json(
      { errorCode: "invalid_invite_code", error: "invalid invite code" },
      { status: 404 },
    );
  }

  const [currentUser] = await db
    .select({ loginId: users.loginId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!currentUser) {
    return unauthorizedResponse();
  }

  const [membership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, invite.groupId), eq(groupMembers.userId, userId)))
    .limit(1);

  const now = new Date().toISOString();
  const decision = resolveInviteAcceptance({
    targetUserId: invite.targetUserId,
    targetLoginId: invite.targetLoginId,
    acceptedAt: normalizeTimestamp(invite.acceptedAt),
    revokedAt: normalizeTimestamp(invite.revokedAt),
    expiresAt: normalizeTimestamp(invite.expiresAt),
    currentUserId: userId,
    currentLoginId: currentUser.loginId,
    currentMembershipRole: (membership?.role as GroupMemberRole | undefined) ?? null,
    now,
  });

  if (!decision.ok) {
    return NextResponse.json(
      { errorCode: decision.errorCode, error: "group invite is not usable" },
      { status: decision.status },
    );
  }

  const [createdMembership] = await db
    .insert(groupMembers)
    .values({
      groupId: invite.groupId,
      userId,
      role: "member",
      approvedBy: invite.createdBy,
      approvedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
    })
    .onConflictDoNothing({
      target: [groupMembers.groupId, groupMembers.userId],
    })
    .returning();

  if (decision.shouldMarkAccepted) {
    await db
      .update(groupInvites)
      .set({
        acceptedBy: userId,
        acceptedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
      })
      .where(
        and(
          eq(groupInvites.id, invite.id),
          isNull(groupInvites.revokedAt),
          isNull(groupInvites.acceptedAt),
        ),
      );
  }

  return NextResponse.json({
    accepted: true,
    reusable: !decision.shouldMarkAccepted,
    group: {
      id: invite.groupId,
      name: invite.groupName,
      slug: invite.groupSlug,
    },
    membership: createdMembership ?? {
      groupId: invite.groupId,
      userId,
      role: "member",
      approvedBy: invite.createdBy,
      approvedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
    },
  });
}
