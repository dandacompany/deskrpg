import { db, groupMembers, userPermissionOverrides, users } from "@/db";
import { PERMISSION_KEYS } from "@/lib/rbac/constants";
import {
  getAuthenticatedUserId,
  getGroupActorContext,
  groupAdminRequiredResponse,
  groupNotFoundResponse,
  hasGroupPermission,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

async function requirePermissionManager(groupId: string, userId: string) {
  const context = await getGroupActorContext(groupId, userId);
  if (!context) {
    return { response: groupNotFoundResponse() };
  }

  const allowed = await hasGroupPermission(context, "manage_group_permissions");
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
  const auth = await requirePermissionManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const rows = await db
    .select({
      id: userPermissionOverrides.id,
      userId: userPermissionOverrides.userId,
      permissionKey: userPermissionOverrides.permissionKey,
      effect: userPermissionOverrides.effect,
      createdBy: userPermissionOverrides.createdBy,
      createdAt: userPermissionOverrides.createdAt,
      loginId: users.loginId,
      nickname: users.nickname,
    })
    .from(userPermissionOverrides)
    .innerJoin(users, eq(userPermissionOverrides.userId, users.id))
    .where(eq(userPermissionOverrides.groupId, groupId))
    .orderBy(users.nickname, userPermissionOverrides.permissionKey);

  return NextResponse.json({ overrides: rows });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requirePermissionManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { targetUserId, permissionKey, effect } = body ?? {};

  if (
    typeof targetUserId !== "string" ||
    typeof permissionKey !== "string" ||
    !PERMISSION_KEYS.includes(permissionKey as (typeof PERMISSION_KEYS)[number])
  ) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "targetUserId and valid permissionKey are required" },
      { status: 400 },
    );
  }

  if (effect !== "allow" && effect !== "deny" && effect !== null) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "effect must be allow, deny, or null" },
      { status: 400 },
    );
  }

  const [member] = await db
    .select({
      userId: groupMembers.userId,
      loginId: users.loginId,
      nickname: users.nickname,
    })
    .from(groupMembers)
    .innerJoin(users, eq(groupMembers.userId, users.id))
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, targetUserId),
      ),
    )
    .limit(1);

  if (!member) {
    return NextResponse.json(
      { errorCode: "member_not_found", error: "member not found" },
      { status: 404 },
    );
  }

  if (effect === null) {
    await db
      .delete(userPermissionOverrides)
      .where(
        and(
          eq(userPermissionOverrides.groupId, groupId),
          eq(userPermissionOverrides.userId, targetUserId),
          eq(userPermissionOverrides.permissionKey, permissionKey),
        ),
      );

    return NextResponse.json({ success: true, removed: true });
  }

  const now = new Date().toISOString();
  const [override] = await db
    .insert(userPermissionOverrides)
    .values({
      groupId,
      userId: targetUserId,
      permissionKey,
      effect,
      createdBy: userId,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        userPermissionOverrides.groupId,
        userPermissionOverrides.userId,
        userPermissionOverrides.permissionKey,
      ],
      set: {
        effect,
        createdBy: userId,
        createdAt: now,
      },
    })
    .returning();

  return NextResponse.json({
    override: {
      ...override,
      loginId: member.loginId,
      nickname: member.nickname,
    },
  });
}
