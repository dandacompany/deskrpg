import { NextRequest, NextResponse } from "next/server";

import { getMyCharacter } from "@/lib/my-character";

function getUserId(req: NextRequest): string | null {
  return req.headers.get("x-user-id");
}

/** My character — one per user. null if none (the screen shows the registration form). */
export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ character: await getMyCharacter(userId) });
}
