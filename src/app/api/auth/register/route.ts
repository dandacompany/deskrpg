import { db, groupMembers, groups, users } from "@/db";
import { buildBootstrapActions, resolveBootstrapCompletion } from "@/lib/rbac/bootstrap";
import { hashPassword } from "@/lib/password";
import { signJWT } from "@/lib/jwt";
import { NextRequest, NextResponse } from "next/server";
import { count, eq, or } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { loginId, nickname, password } = body;

  if (!loginId || !nickname || !password) {
    return NextResponse.json({ error: "loginId, nickname and password are required" }, { status: 400 });
  }
  if (loginId.length < 2 || loginId.length > 50) {
    return NextResponse.json({ error: "loginId must be 2-50 characters" }, { status: 400 });
  }
  if (nickname.length < 2 || nickname.length > 50) {
    return NextResponse.json({ error: "nickname must be 2-50 characters" }, { status: 400 });
  }
  if (password.length < 4) {
    return NextResponse.json({ error: "password must be at least 4 characters" }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(users)
    .where(or(eq(users.loginId, loginId), eq(users.nickname, nickname)))
    .limit(2);

  if (existing.some((u) => u.loginId === loginId)) {
    return NextResponse.json({ error: "loginId already taken" }, { status: 409 });
  }
  if (existing.some((u) => u.nickname === nickname)) {
    return NextResponse.json({ error: "nickname already taken" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const user = await db.transaction(async (tx) => {
    const [{ value: userCount }] = await tx.select({ value: count() }).from(users);
    const [createdUser] = await tx.insert(users).values({
      loginId,
      nickname,
      passwordHash,
      systemRole: "user",
    }).returning();

    const bootstrap = buildBootstrapActions({
      existingUserCount: Number(userCount),
      userId: createdUser.id,
      loginId,
    });
    let defaultGroupCreated = false;
    let createdGroupId: string | null = null;

    if (bootstrap.createDefaultGroup && bootstrap.defaultGroup) {
      const insertedGroups = await tx.insert(groups).values({
        ...bootstrap.defaultGroup,
        createdBy: createdUser.id,
      }).onConflictDoNothing({
        target: groups.slug,
      }).returning();

      const createdGroup = insertedGroups[0];
      defaultGroupCreated = Boolean(createdGroup);
      createdGroupId = createdGroup?.id ?? null;
    }

    const completion = resolveBootstrapCompletion({
      bootstrap,
      defaultGroupCreated,
    });

    if (completion.systemRole === "system_admin") {
      await tx
        .update(users)
        .set({ systemRole: completion.systemRole })
        .where(eq(users.id, createdUser.id));
    }

    if (completion.createGroupMembership && createdGroupId && bootstrap.groupMembership) {
      await tx.insert(groupMembers).values({
        groupId: createdGroupId,
        userId: bootstrap.groupMembership.userId,
        role: bootstrap.groupMembership.role,
        approvedBy: createdUser.id,
        approvedAt: new Date().toISOString(),
      });
    }

    return {
      ...createdUser,
      systemRole: completion.systemRole,
    };
  });

  const token = await signJWT({ userId: user.id, nickname: user.nickname });

  const response = NextResponse.json({ user: { id: user.id, nickname: user.nickname } });
  response.cookies.set("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });

  return response;
}
