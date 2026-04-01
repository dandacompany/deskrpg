import { db, groupMembers, groups, isPostgres, users } from "@/db";
import { buildBootstrapActions, resolveBootstrapCompletion } from "@/lib/rbac/bootstrap";
import { hashPassword } from "@/lib/password";
import { signJWT, isSecureCookie } from "@/lib/jwt";
import { isAccountPasswordValid } from "@/lib/security-policy";
import { createStarterProjectForUser } from "@/lib/builtin-projects";
import { seedBuiltinTemplates } from "@/lib/builtin-templates";
import { NextRequest, NextResponse } from "next/server";
import { count, eq, or } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { loginId, nickname, password } = body;

  if (!loginId || !nickname || !password) {
    return NextResponse.json(
      {
        errorCode: "login_id_nickname_password_required",
        error: "loginId, nickname and password are required",
      },
      { status: 400 },
    );
  }
  if (loginId.length < 2 || loginId.length > 50) {
    return NextResponse.json(
      { errorCode: "login_id_length_invalid", error: "loginId must be 2-50 characters" },
      { status: 400 },
    );
  }
  if (nickname.length < 2 || nickname.length > 50) {
    return NextResponse.json(
      { errorCode: "nickname_length_invalid", error: "nickname must be 2-50 characters" },
      { status: 400 },
    );
  }
  if (!isAccountPasswordValid(password)) {
    return NextResponse.json(
      { errorCode: "password_length_invalid", error: "password must be at least 8 characters" },
      { status: 400 },
    );
  }

  const existing = await db
    .select()
    .from(users)
    .where(or(eq(users.loginId, loginId), eq(users.nickname, nickname)))
    .limit(2);

  if (existing.some((u) => u.loginId === loginId)) {
    return NextResponse.json(
      { errorCode: "login_id_taken", error: "loginId already taken" },
      { status: 409 },
    );
  }
  if (existing.some((u) => u.nickname === nickname)) {
    return NextResponse.json(
      { errorCode: "nickname_taken", error: "nickname already taken" },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  const [createdUser] = await db.insert(users).values({
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
    const insertedGroups = await db.insert(groups).values({
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
    await db
      .update(users)
      .set({ systemRole: completion.systemRole })
      .where(eq(users.id, createdUser.id));
  }

  if (completion.createGroupMembership && createdGroupId && bootstrap.groupMembership) {
    await db.insert(groupMembers).values({
      groupId: createdGroupId,
      userId: bootstrap.groupMembership.userId,
      role: bootstrap.groupMembership.role,
      approvedBy: createdUser.id,
      approvedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
    });
  }

  // Auto-join default group as member for non-first users
  if (!completion.createGroupMembership) {
    const [defaultGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.isDefault, true))
      .limit(1);

    if (defaultGroup) {
      await db.insert(groupMembers).values({
        groupId: defaultGroup.id,
        userId: createdUser.id,
        role: "member",
        approvedBy: createdUser.id,
        approvedAt: (isPostgres ? new Date() : new Date().toISOString()) as unknown as Date,
      }).onConflictDoNothing();
    }
  }

  try {
    await seedBuiltinTemplates();
  } catch (error) {
    console.warn("Failed to seed builtin templates:", error);
  }

  try {
    await createStarterProjectForUser(createdUser.id);
  } catch (error) {
    console.warn("Failed to create starter project:", error);
  }

  const user = {
    ...createdUser,
    systemRole: completion.systemRole,
  };

  const token = await signJWT({ userId: user.id, nickname: user.nickname });

  const response = NextResponse.json({ user: { id: user.id, nickname: user.nickname } });
  response.cookies.set("token", token, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });

  return response;
}
