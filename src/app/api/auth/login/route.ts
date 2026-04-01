import { db } from "@/db";
import { users } from "@/db";
import { verifyPassword } from "@/lib/password";
import { signJWT, isSecureCookie } from "@/lib/jwt";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { loginId, password } = body;

  if (!loginId || !password) {
    return NextResponse.json(
      { errorCode: "login_id_password_required", error: "loginId and password are required" },
      { status: 400 },
    );
  }

  const [user] = await db.select().from(users).where(eq(users.loginId, loginId)).limit(1);
  if (!user) {
    return NextResponse.json(
      { errorCode: "invalid_credentials", error: "invalid credentials" },
      { status: 401 },
    );
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json(
      { errorCode: "invalid_credentials", error: "invalid credentials" },
      { status: 401 },
    );
  }

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
