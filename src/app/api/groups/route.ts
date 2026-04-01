import { randomUUID } from "node:crypto";

import { db, groupMembers, groups, isPostgres } from "@/db";
import {
  buildGroupSlugCandidates,
  getAuthenticatedUserId,
  type GroupActorContext,
  hasGroupPermission,
  getUserSystemRole,
  summarizeGroupManagementCapabilities,
  systemAdminRequiredResponse,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { GROUP_MEMBER_ROLES } from "@/lib/rbac/constants";
import type { GroupMemberRole } from "@/lib/rbac/constants";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

function slugifyGroupName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "group";
}

export async function GET(req: NextRequest) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const systemRole = await getUserSystemRole(userId);
  if (!systemRole) return unauthorizedResponse();

  if (systemRole === "system_admin") {
    const rows = await db
      .select({
        id: groups.id,
        name: groups.name,
        slug: groups.slug,
        description: groups.description,
        isDefault: groups.isDefault,
        createdBy: groups.createdBy,
      })
      .from(groups)
      .orderBy(groups.name);

    return NextResponse.json({
      groups: rows.map((row) => ({
        ...row,
        ...summarizeGroupManagementCapabilities({
          canCreateChannel: true,
          canManageMembers: true,
          canManagePermissions: true,
          canApproveJoinRequests: true,
        }),
      })),
    });
  }

  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      slug: groups.slug,
      description: groups.description,
      isDefault: groups.isDefault,
      createdBy: groups.createdBy,
      role: groupMembers.role,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(eq(groupMembers.userId, userId))
    .orderBy(groups.name);

  const groupsWithCapabilities = await Promise.all(rows.map(async (row) => {
    const context: GroupActorContext = {
      userId,
      systemRole,
      group: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        isDefault: row.isDefault,
        createdBy: row.createdBy,
      },
      groupRole: (row.role as GroupMemberRole | undefined) ?? null,
    };

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      isDefault: row.isDefault,
      createdBy: row.createdBy,
      role: row.role,
      ...summarizeGroupManagementCapabilities({
        canCreateChannel: await hasGroupPermission(context, "create_channel"),
        canManageMembers: await hasGroupPermission(context, "manage_group_members"),
        canManagePermissions: await hasGroupPermission(context, "manage_group_permissions"),
        canApproveJoinRequests: await hasGroupPermission(context, "approve_join_requests"),
      }),
    };
  }));

  return NextResponse.json({
    groups: groupsWithCapabilities.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      isDefault: row.isDefault,
      createdBy: row.createdBy,
      role: row.role,
      canCreateChannel: row.canCreateChannel,
      canManageMembers: row.canManageMembers,
      canManagePermissions: row.canManagePermissions,
      canApproveJoinRequests: row.canApproveJoinRequests,
      canManageGroup: row.canManageGroup,
    })),
  });
}

export async function POST(req: NextRequest) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const systemRole = await getUserSystemRole(userId);
  if (systemRole !== "system_admin") {
    return systemAdminRequiredResponse();
  }

  const body = await req.json();
  const { name, description, slug, role } = body ?? {};

  if (!name || typeof name !== "string") {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "name is required" },
      { status: 400 },
    );
  }

  const requestedRole = typeof role === "string" ? role : "group_admin";
  if (!GROUP_MEMBER_ROLES.includes(requestedRole as GroupMemberRole)) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "invalid member role" },
      { status: 400 },
    );
  }
  const memberRole = requestedRole as GroupMemberRole;

  const requestedSlug = typeof slug === "string" && slug.trim()
    ? slugifyGroupName(slug)
    : slugifyGroupName(name);
  const now = new Date().toISOString();

  const slugCandidates = [
    ...buildGroupSlugCandidates(requestedSlug, 8),
    `${requestedSlug}-${randomUUID().slice(0, 8)}`,
  ];

  let group: typeof groups.$inferSelect | null = null;
  for (const candidate of slugCandidates) {
    const inserted = await db
      .insert(groups)
      .values({
        name: name.trim(),
        slug: candidate,
        description: typeof description === "string" ? description.trim() : null,
        createdBy: userId,
      })
      .onConflictDoNothing({
        target: groups.slug,
      })
      .returning();

    if (inserted[0]) {
      group = inserted[0];
      break;
    }
  }

  if (!group) {
    throw new Error("failed_to_allocate_group_slug");
  }

  const [membership] = await db
    .insert(groupMembers)
    .values({
      groupId: group.id,
      userId,
      role: memberRole,
      approvedBy: userId,
      approvedAt: (isPostgres ? new Date(now) : now) as unknown as Date,
    })
    .returning();

  return NextResponse.json(
    {
      group,
      membership,
    },
    { status: 201 },
  );
}
