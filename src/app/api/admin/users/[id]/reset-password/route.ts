import { db, users } from "@/db";
import { hashPassword } from "@/lib/password";
import { generateTemporaryPassword } from "@/lib/temporary-password";
import {
  getAuthenticatedUserId,
  getUserSystemRole,
  systemAdminRequiredResponse,
  unauthorizedResponse,
} from "@/lib/rbac/group-api";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

/**
 * A system admin resets a user's password to a temporary value.
 * The plaintext appears only once in this response — it is left in neither the DB nor the logs.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actorId = getAuthenticatedUserId(req);
  if (!actorId) return unauthorizedResponse();

  const systemRole = await getUserSystemRole(actorId);
  if (systemRole !== "system_admin") return systemAdminRequiredResponse();

  const { id } = await context.params;
  const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!target) {
    return NextResponse.json(
      { errorCode: "user_not_found", error: "user not found" },
      { status: 404 },
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true })
    .where(eq(users.id, target.id));

  return NextResponse.json({
    temporaryPassword,
    user: { id: target.id, loginId: target.loginId, nickname: target.nickname },
  });
}
