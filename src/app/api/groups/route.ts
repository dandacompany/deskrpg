import { db, groupMembers, groups } from "@/db";
import {
  getAuthenticatedUserId,
  getUserSystemRole,
  systemAdminRequiredResponse,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { GROUP_MEMBER_ROLES } from "@/lib/rbac/constants";
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

async function buildUniqueSlug(baseSlug: string) {
  let candidate = baseSlug;
  let suffix = 1;

  while (true) {
    const [existing] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.slug, candidate))
      .limit(1);

    if (!existing) {
      return candidate;
    }

    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
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

    return NextResponse.json({ groups: rows });
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

  return NextResponse.json({
    groups: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      isDefault: row.isDefault,
      createdBy: row.createdBy,
      role: row.role,
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

  const memberRole = typeof role === "string" ? role : "group_admin";
  if (!GROUP_MEMBER_ROLES.includes(memberRole)) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "invalid member role" },
      { status: 400 },
    );
  }

  const requestedSlug = typeof slug === "string" && slug.trim()
    ? slugifyGroupName(slug)
    : slugifyGroupName(name);
  const uniqueSlug = await buildUniqueSlug(requestedSlug);
  const now = new Date().toISOString();

  const created = await db.transaction(async (tx) => {
    const [group] = await tx
      .insert(groups)
      .values({
        name: name.trim(),
        slug: uniqueSlug,
        description: typeof description === "string" ? description.trim() : null,
        createdBy: userId,
      })
      .returning();

    const [membership] = await tx
      .insert(groupMembers)
      .values({
        groupId: group.id,
        userId,
        role: memberRole,
        approvedBy: userId,
        approvedAt: now,
      })
      .returning();

    return { group, membership };
  });

  return NextResponse.json(
    {
      group: created.group,
      membership: created.membership,
    },
    { status: 201 },
  );
}
