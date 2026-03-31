import { randomUUID } from "node:crypto";

import { db, groupInvites, users } from "@/db";
import {
  getAuthenticatedUserId,
  getGroupActorContext,
  groupAdminRequiredResponse,
  groupNotFoundResponse,
  hasGroupPermission,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

async function requireInviteManager(groupId: string, userId: string) {
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
  const auth = await requireInviteManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const rows = await db
    .select({
      id: groupInvites.id,
      token: groupInvites.token,
      createdBy: groupInvites.createdBy,
      targetUserId: groupInvites.targetUserId,
      targetLoginId: groupInvites.targetLoginId,
      expiresAt: groupInvites.expiresAt,
      acceptedBy: groupInvites.acceptedBy,
      acceptedAt: groupInvites.acceptedAt,
      revokedAt: groupInvites.revokedAt,
      createdAt: groupInvites.createdAt,
      targetNickname: users.nickname,
    })
    .from(groupInvites)
    .leftJoin(users, eq(groupInvites.targetUserId, users.id))
    .where(eq(groupInvites.groupId, groupId))
    .orderBy(groupInvites.createdAt);

  return NextResponse.json({ invites: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requireInviteManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { targetUserId, targetLoginId, expiresAt } = body ?? {};

  if (
    (typeof targetUserId !== "string" || !targetUserId) &&
    (typeof targetLoginId !== "string" || !targetLoginId)
  ) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "invite target is required" },
      { status: 400 },
    );
  }

  if (typeof targetUserId === "string" && targetUserId) {
    const [targetUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      return NextResponse.json(
        { errorCode: "not_found", error: "user not found" },
        { status: 404 },
      );
    }
  }

  const [invite] = await db
    .insert(groupInvites)
    .values({
      groupId,
      token: randomUUID().replace(/-/g, ""),
      createdBy: userId,
      targetUserId: typeof targetUserId === "string" ? targetUserId : null,
      targetLoginId: typeof targetLoginId === "string" ? targetLoginId.trim() : null,
      expiresAt: typeof expiresAt === "string" ? expiresAt : null,
    })
    .returning();

  return NextResponse.json({ invite }, { status: 201 });
}
