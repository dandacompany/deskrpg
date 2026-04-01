import { db, projects } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

export function resolveOwnedProjectAccess({
  requestUserId,
  ownerUserId,
}: {
  requestUserId: string | null;
  ownerUserId: string | null;
}):
  | { ok: true }
  | { ok: false; status: 401 | 404; errorCode: "unauthorized" | "not_found" } {
  if (!requestUserId) {
    return { ok: false, status: 401, errorCode: "unauthorized" };
  }
  if (!ownerUserId || ownerUserId !== requestUserId) {
    return { ok: false, status: 404, errorCode: "not_found" };
  }
  return { ok: true };
}

export async function requireOwnedProject(req: NextRequest, projectId: string) {
  const userId = getUserId(req);
  if (!userId) {
    return {
      error: NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 }),
    };
  }

  const [project] = await db.select().from(projects).where(
    and(eq(projects.id, projectId), eq(projects.createdBy, userId)),
  );

  if (!project) {
    return {
      error: NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 }),
    };
  }

  return { project, userId };
}
