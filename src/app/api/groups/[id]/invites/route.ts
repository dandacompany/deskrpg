import { randomUUID } from "node:crypto";

import { db, groupInvites, isPostgres, users } from "@/db";
import {
  deriveGroupInviteStatus,
  getAuthenticatedUserId,
  getGroupActorContext,
  groupAdminRequiredResponse,
  groupNotFoundResponse,
  hasGroupPermission,
  normalizeInviteCreationInput,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

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
  const now = new Date().toISOString();

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

  return NextResponse.json({
    invites: rows.map((row) => ({
      ...row,
      status: deriveGroupInviteStatus({
        acceptedAt: normalizeTimestamp(row.acceptedAt),
        revokedAt: normalizeTimestamp(row.revokedAt),
        expiresAt: normalizeTimestamp(row.expiresAt),
        now,
      }),
      isReusable: !row.targetUserId && !row.targetLoginId,
    })),
  });
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
  const normalized = normalizeInviteCreationInput({
    targetUserId,
    targetLoginId,
    expiresAt,
    now: new Date().toISOString(),
  });
  if (!normalized.ok) {
    return NextResponse.json(
      { errorCode: normalized.errorCode, error: "invite expiration is invalid" },
      { status: normalized.status },
    );
  }

  if (normalized.targetUserId) {
    const [targetUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, normalized.targetUserId))
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
      targetUserId: normalized.targetUserId,
      targetLoginId: normalized.targetLoginId,
      expiresAt: normalized.expiresAt
        ? ((isPostgres ? new Date(normalized.expiresAt) : normalized.expiresAt) as unknown as Date)
        : null,
    })
    .returning();

  return NextResponse.json({ invite }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requireInviteManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { inviteId } = body ?? {};
  if (typeof inviteId !== "string" || !inviteId) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "inviteId is required" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const revoked = await db
    .update(groupInvites)
    .set({ revokedAt: (isPostgres ? new Date(now) : now) as unknown as Date })
    .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, groupId)))
    .returning();

  if (revoked[0]) {
    return NextResponse.json({ invite: revoked[0], revoked: true });
  }

  const [existing] = await db
    .select({ id: groupInvites.id, revokedAt: groupInvites.revokedAt })
    .from(groupInvites)
    .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, groupId)))
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { errorCode: "not_found", error: "invite not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ invite: existing, revoked: true, alreadyRevoked: true });
}
