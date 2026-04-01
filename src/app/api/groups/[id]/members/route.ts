import { db, groupJoinRequests, groupMembers, isPostgres, userPermissionOverrides, users } from "@/db";
import { GROUP_MEMBER_ROLES } from "@/lib/rbac/constants";
import type { GroupMemberRole } from "@/lib/rbac/constants";
import {
  canChangeGroupAdminStatus,
  getAuthenticatedUserId,
  getGroupActorContext,
  groupAdminRequiredResponse,
  groupNotFoundResponse,
  hasGroupPermission,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

async function listGroupAdminUserIds(groupId: string) {
  const adminRows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "group_admin")));

  return adminRows.map((row) => row.userId);
}

async function requireMembersManager(groupId: string, userId: string) {
  const context = await getGroupActorContext(groupId, userId);
  if (!context) {
    return { response: groupNotFoundResponse() };
  }

  const allowed = await hasGroupPermission(context, "manage_group_members");
  if (!allowed) {
    return { response: groupAdminRequiredResponse() };
  }

  return { context };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const context = await getGroupActorContext(groupId, userId);
  if (!context) return groupNotFoundResponse();

  if (context.systemRole !== "system_admin" && !context.groupRole) {
    return NextResponse.json(
      { errorCode: "group_membership_required", error: "group membership required" },
      { status: 403 },
    );
  }

  const rows = await db
    .select({
      userId: groupMembers.userId,
      role: groupMembers.role,
      approvedBy: groupMembers.approvedBy,
      approvedAt: groupMembers.approvedAt,
      joinedAt: groupMembers.joinedAt,
      loginId: users.loginId,
      nickname: users.nickname,
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(users.nickname);

  return NextResponse.json({ members: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requireMembersManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { targetUserId, targetLoginId, role } = body ?? {};

  const requestedRole = typeof role === "string" ? role : "member";
  if (!GROUP_MEMBER_ROLES.includes(requestedRole as GroupMemberRole)) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "invalid role" },
      { status: 400 },
    );
  }
  const memberRole = requestedRole as GroupMemberRole;

  const [targetUser] = await db
    .select({ id: users.id, loginId: users.loginId, nickname: users.nickname })
    .from(users)
    .where(
      typeof targetUserId === "string"
        ? eq(users.id, targetUserId)
        : eq(users.loginId, typeof targetLoginId === "string" ? targetLoginId : ""),
    )
    .limit(1);

  if (!targetUser) {
    return NextResponse.json(
      { errorCode: "member_not_found", error: "member not found" },
      { status: 404 },
    );
  }

  const [existingMembership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, targetUser.id),
      ),
    )
    .limit(1);

  const adminUserIds = await listGroupAdminUserIds(groupId);
  const roleChange = canChangeGroupAdminStatus({
    targetUserId: targetUser.id,
    targetCurrentRole: (existingMembership?.role as "group_admin" | "member" | null | undefined) ?? null,
    nextRole: memberRole,
    adminUserIds,
  });

  if (!roleChange.ok) {
    return NextResponse.json(
      { errorCode: roleChange.errorCode, error: "last group admin must remain" },
      { status: roleChange.status },
    );
  }

  const now = new Date().toISOString();
  const [membership] = await db
    .insert(groupMembers)
    .values({
      groupId,
      userId: targetUser.id,
      role: memberRole,
      approvedBy: userId,
      approvedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
    })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: {
        role: memberRole,
        approvedBy: userId,
        approvedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
      },
    })
    .returning();

  await db
    .delete(groupJoinRequests)
    .where(
      and(
        eq(groupJoinRequests.groupId, groupId),
        eq(groupJoinRequests.userId, targetUser.id),
      ),
    );

  return NextResponse.json(
    {
      member: {
        ...membership,
        loginId: targetUser.loginId,
        nickname: targetUser.nickname,
      },
    },
    { status: 201 },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requireMembersManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { targetUserId } = body ?? {};

  if (!targetUserId || typeof targetUserId !== "string") {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "targetUserId is required" },
      { status: 400 },
    );
  }

  const [existingMembership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetUserId)))
    .limit(1);

  if (!existingMembership) {
    return NextResponse.json(
      { errorCode: "member_not_found", error: "member not found" },
      { status: 404 },
    );
  }

  const adminUserIds = await listGroupAdminUserIds(groupId);
  const roleChange = canChangeGroupAdminStatus({
    targetUserId,
    targetCurrentRole: existingMembership.role as "group_admin" | "member",
    nextRole: null,
    adminUserIds,
  });

  if (!roleChange.ok) {
    return NextResponse.json(
      { errorCode: roleChange.errorCode, error: "last group admin must remain" },
      { status: roleChange.status },
    );
  }

  const deleted = await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, targetUserId)))
    .returning();

  if (deleted.length === 0) {
    return NextResponse.json(
      { errorCode: "member_not_found", error: "member not found" },
      { status: 404 },
    );
  }

  await db
    .delete(userPermissionOverrides)
    .where(
      and(
        eq(userPermissionOverrides.groupId, groupId),
        eq(userPermissionOverrides.userId, targetUserId),
      ),
    );

  return NextResponse.json({ success: true });
}
