import { db, users } from "@/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { signJWT, isSecureCookie } from "@/lib/jwt";
import { isAccountPasswordValid } from "@/lib/security-policy";
import { getAuthenticatedUserId, unauthorizedResponse } from "@/lib/rbac/group-api";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

/** A user changes their own password. Only someone who knows the current password gets through. */
export async function POST(req: NextRequest) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return unauthorizedResponse();

  const body = await req.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      {
        errorCode: "current_new_password_required",
        error: "currentPassword and newPassword are required",
      },
      { status: 400 },
    );
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  // A session whose user has disappeared is closed as "not authorized" too.
  if (!user) return unauthorizedResponse();

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return NextResponse.json(
      { errorCode: "invalid_credentials", error: "invalid credentials" },
      { status: 401 },
    );
  }

  if (!isAccountPasswordValid(newPassword)) {
    return NextResponse.json(
      { errorCode: "password_length_invalid", error: "password must be at least 8 characters" },
      { status: 400 },
    );
  }

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { errorCode: "password_unchanged", error: "new password must differ from the current one" },
      { status: 400 },
    );
  }

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false })
    .where(eq(users.id, user.id));

  // Restart the cookie lifetime — so a session that came in with a temporary password does not keep its full 7 days.
  const token = await signJWT({ userId: user.id, nickname: user.nickname });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("token", token, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return response;
}
