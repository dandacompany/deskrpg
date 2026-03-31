import { db, groupMembers, groupPermissions, groups, userPermissionOverrides, users } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import type { GroupMemberRole, PermissionKey, SystemRole } from "./constants";
import { resolvePermission, type PermissionEffect } from "./permissions";

type JoinRequestStatus = "pending" | "approved" | "rejected";
type JoinRequestAction = "approve" | "reject";

export type GroupActorContext = {
  userId: string;
  systemRole: SystemRole;
  group: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isDefault: boolean;
    createdBy: string | null;
  };
  groupRole: GroupMemberRole | null;
};

export type GroupManagementCapabilities = {
  canCreateChannel: boolean;
  canManageMembers: boolean;
  canManagePermissions: boolean;
  canApproveJoinRequests: boolean;
  canManageGroup: boolean;
};

export function canWriteGroupPermissionEffect(input: {
  permissionKey: PermissionKey;
  effect: PermissionEffect | null;
}) {
  return !(
    input.permissionKey === "manage_group_permissions" &&
    input.effect === "deny"
  );
}

export function sanitizeGroupPermissionEffects(input: {
  permissionKey: PermissionKey;
  effects: PermissionEffect[];
}) {
  if (input.permissionKey !== "manage_group_permissions") {
    return input.effects;
  }

  return input.effects.filter((effect) => effect !== "deny");
}

export function buildGroupSlugCandidates(baseSlug: string, attempts: number) {
  return Array.from({ length: attempts }, (_, index) =>
    index === 0 ? baseSlug : `${baseSlug}-${index + 1}`,
  );
}

export function summarizeGroupManagementCapabilities(input: Omit<GroupManagementCapabilities, "canManageGroup">): GroupManagementCapabilities {
  return {
    ...input,
    canManageGroup: input.canManageMembers || input.canManagePermissions || input.canApproveJoinRequests,
  };
}

export function canChangeGroupAdminStatus(input: {
  targetUserId: string;
  targetCurrentRole: GroupMemberRole | null;
  nextRole: GroupMemberRole | null;
  adminUserIds: string[];
}) {
  if (input.targetCurrentRole !== "group_admin") {
    return { ok: true as const };
  }

  if (input.nextRole === "group_admin") {
    return { ok: true as const };
  }

  const uniqueAdminUserIds = new Set(input.adminUserIds);
  if (uniqueAdminUserIds.size === 1 && uniqueAdminUserIds.has(input.targetUserId)) {
    return {
      ok: false as const,
      errorCode: "last_group_admin_required" as const,
      status: 409,
    };
  }

  return { ok: true as const };
}

export function resolveJoinRequestReview(input: {
  currentStatus: JoinRequestStatus;
  action: JoinRequestAction;
  existingMembershipRole: GroupMemberRole | null;
}) {
  if (input.currentStatus !== "pending") {
    return {
      ok: false as const,
      status: 409,
      errorCode: "forbidden" as const,
    };
  }

  if (input.action === "reject") {
    return {
      ok: true as const,
      nextStatus: "rejected" as const,
      shouldUpsertMembership: false,
      preservedMembershipRole: input.existingMembershipRole,
    };
  }

  if (input.existingMembershipRole) {
    return {
      ok: true as const,
      nextStatus: "approved" as const,
      shouldUpsertMembership: false,
      preservedMembershipRole: input.existingMembershipRole,
    };
  }

  return {
    ok: true as const,
    nextStatus: "approved" as const,
    shouldUpsertMembership: true,
    membershipRole: "member" as const,
    preservedMembershipRole: null,
  };
}

export function getAuthenticatedUserId(req: NextRequest): string | null {
  return getUserId(req);
}

export function unauthorizedResponse() {
  return NextResponse.json(
    { errorCode: "unauthorized", error: "unauthorized" },
    { status: 401 },
  );
}

export function systemAdminRequiredResponse() {
  return NextResponse.json(
    { errorCode: "system_admin_required", error: "system admin required" },
    { status: 403 },
  );
}

export function groupAdminRequiredResponse() {
  return NextResponse.json(
    { errorCode: "group_admin_required", error: "group admin required" },
    { status: 403 },
  );
}

export function groupNotFoundResponse() {
  return NextResponse.json(
    { errorCode: "group_not_found", error: "group not found" },
    { status: 404 },
  );
}

export async function getUserSystemRole(userId: string): Promise<SystemRole | null> {
  const [user] = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return (user?.systemRole as SystemRole | undefined) ?? null;
}

export async function getGroupActorContext(
  groupId: string,
  userId: string,
): Promise<GroupActorContext | null> {
  const [user] = await db
    .select({ systemRole: users.systemRole })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return null;
  }

  const [group] = await db
    .select({
      id: groups.id,
      name: groups.name,
      slug: groups.slug,
      description: groups.description,
      isDefault: groups.isDefault,
      createdBy: groups.createdBy,
    })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!group) {
    return null;
  }

  const [membership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);

  return {
    userId,
    systemRole: user.systemRole as SystemRole,
    group,
    groupRole: (membership?.role as GroupMemberRole | undefined) ?? null,
  };
}

export async function hasGroupPermission(
  context: GroupActorContext,
  permissionKey: PermissionKey,
): Promise<boolean> {
  if (context.systemRole !== "system_admin" && !context.groupRole) {
    return false;
  }

  const groupEffectRows = await db
    .select({ effect: groupPermissions.effect })
    .from(groupPermissions)
    .where(
      and(
        eq(groupPermissions.groupId, context.group.id),
        eq(groupPermissions.permissionKey, permissionKey),
      ),
    );

  const userEffectRows = await db
    .select({ effect: userPermissionOverrides.effect })
    .from(userPermissionOverrides)
    .where(
      and(
        eq(userPermissionOverrides.groupId, context.group.id),
        eq(userPermissionOverrides.userId, context.userId),
        eq(userPermissionOverrides.permissionKey, permissionKey),
      ),
    );

  const decision = resolvePermission({
    systemRole: context.systemRole,
    groupRole: context.groupRole,
    permissionKey,
    groupEffects: sanitizeGroupPermissionEffects({
      permissionKey,
      effects: groupEffectRows.map((row) => row.effect as PermissionEffect),
    }),
    userEffects: sanitizeGroupPermissionEffects({
      permissionKey,
      effects: userEffectRows.map((row) => row.effect as PermissionEffect),
    }),
  });

  return decision.allowed;
}
