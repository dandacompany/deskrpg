import { db, groupPermissions } from "@/db";
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
      id: groupPermissions.id,
      permissionKey: groupPermissions.permissionKey,
      effect: groupPermissions.effect,
      createdBy: groupPermissions.createdBy,
      createdAt: groupPermissions.createdAt,
    })
    .from(groupPermissions)
    .where(eq(groupPermissions.groupId, groupId))
    .orderBy(groupPermissions.permissionKey);

  return NextResponse.json({ permissions: rows });
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
  const { permissionKey, effect } = body ?? {};

  if (
    typeof permissionKey !== "string" ||
    !PERMISSION_KEYS.includes(permissionKey as (typeof PERMISSION_KEYS)[number])
  ) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "valid permissionKey is required" },
      { status: 400 },
    );
  }

  if (effect !== "allow" && effect !== "deny" && effect !== null) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "effect must be allow, deny, or null" },
      { status: 400 },
    );
  }

  if (effect === null) {
    await db
      .delete(groupPermissions)
      .where(
        and(
          eq(groupPermissions.groupId, groupId),
          eq(groupPermissions.permissionKey, permissionKey),
        ),
      );

    return NextResponse.json({ success: true, removed: true });
  }

  const now = new Date().toISOString();
  const [permission] = await db
    .insert(groupPermissions)
    .values({
      groupId,
      permissionKey,
      effect,
      createdBy: userId,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [groupPermissions.groupId, groupPermissions.permissionKey],
      set: {
        effect,
        createdBy: userId,
        createdAt: now,
      },
    })
    .returning();

  return NextResponse.json({ permission });
}
