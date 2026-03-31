import { db, groupJoinRequests, groupMembers, users } from "@/db";
import {
  getAuthenticatedUserId,
  getGroupActorContext,
  groupAdminRequiredResponse,
  groupNotFoundResponse,
  hasGroupPermission,
  resolveJoinRequestReview,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

async function requireJoinRequestManager(groupId: string, userId: string) {
  const context = await getGroupActorContext(groupId, userId);
  if (!context) {
    return { response: groupNotFoundResponse() };
  }

  const allowed = await hasGroupPermission(context, "approve_join_requests");
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
  const auth = await requireJoinRequestManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const rows = await db
    .select({
      id: groupJoinRequests.id,
      userId: groupJoinRequests.userId,
      status: groupJoinRequests.status,
      message: groupJoinRequests.message,
      reviewedBy: groupJoinRequests.reviewedBy,
      reviewedAt: groupJoinRequests.reviewedAt,
      createdAt: groupJoinRequests.createdAt,
      loginId: users.loginId,
      nickname: users.nickname,
    })
    .from(groupJoinRequests)
    .innerJoin(users, eq(groupJoinRequests.userId, users.id))
    .where(eq(groupJoinRequests.groupId, groupId))
    .orderBy(groupJoinRequests.createdAt);

  return NextResponse.json({ joinRequests: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const context = await getGroupActorContext(groupId, userId);
  if (!context) return groupNotFoundResponse();

  const [membership] = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);

  if (membership) {
    return NextResponse.json({ alreadyMember: true });
  }

  const body = await req.json();
  const now = new Date().toISOString();
  const [joinRequest] = await db
    .insert(groupJoinRequests)
    .values({
      groupId,
      userId,
      message: typeof body?.message === "string" ? body.message.trim() : null,
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [groupJoinRequests.groupId, groupJoinRequests.userId],
      set: {
        status: "pending",
        message: typeof body?.message === "string" ? body.message.trim() : null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: now,
      },
    })
    .returning();

  return NextResponse.json({ joinRequest, created: true }, { status: 201 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const { id: groupId } = await params;
  const auth = await requireJoinRequestManager(groupId, userId);
  if ("response" in auth) return auth.response;

  const body = await req.json();
  const { requestId, action } = body ?? {};

  if (
    typeof requestId !== "string" ||
    (action !== "approve" && action !== "reject")
  ) {
    return NextResponse.json(
      { errorCode: "missing_required_fields", error: "requestId and valid action are required" },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select({
      id: groupJoinRequests.id,
      userId: groupJoinRequests.userId,
      status: groupJoinRequests.status,
    })
    .from(groupJoinRequests)
    .where(
      and(
        eq(groupJoinRequests.id, requestId),
        eq(groupJoinRequests.groupId, groupId),
      ),
    )
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { errorCode: "not_found", error: "join request not found" },
      { status: 404 },
    );
  }

  const [membership] = await db
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, existing.userId),
      ),
    )
    .limit(1);

  const review = resolveJoinRequestReview({
    currentStatus: existing.status as "pending" | "approved" | "rejected",
    action,
    existingMembershipRole: (membership?.role as "group_admin" | "member" | null | undefined) ?? null,
  });

  if (!review.ok) {
    return NextResponse.json(
      { errorCode: review.errorCode, error: "join request is not pending" },
      { status: review.status },
    );
  }

  const now = new Date().toISOString();
  let result;
  try {
    result = await db.transaction(async (tx) => {
      const updatedRows = await tx
        .update(groupJoinRequests)
        .set({
          status: review.nextStatus,
          reviewedBy: userId,
          reviewedAt: now,
        })
        .where(
          and(
            eq(groupJoinRequests.id, requestId),
            eq(groupJoinRequests.groupId, groupId),
            eq(groupJoinRequests.status, "pending"),
          ),
        )
        .returning();

      const updatedRequest = updatedRows[0];
      if (!updatedRequest) {
        throw new Error("join_request_not_pending");
      }

      if (review.shouldUpsertMembership) {
        await tx
          .insert(groupMembers)
          .values({
            groupId,
            userId: existing.userId,
            role: review.membershipRole,
            approvedBy: userId,
            approvedAt: now,
          })
          .onConflictDoNothing({
            target: [groupMembers.groupId, groupMembers.userId],
          });
      }

      return updatedRequest;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "join_request_not_pending") {
      return NextResponse.json(
        { errorCode: "forbidden", error: "join request is not pending" },
        { status: 409 },
      );
    }
    throw error;
  }

  return NextResponse.json({ joinRequest: result });
}
