import { NextRequest, NextResponse } from "next/server";

import { validateHermesProfile } from "@/lib/hermes-profiles";
import { getUserId } from "@/lib/internal-rpc";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json(
      { errorCode: "unauthorized", error: "unauthorized" },
      { status: 401 },
    );
  }
  const { profileId } = await params;

  const result = await validateHermesProfile(userId, profileId);
  return NextResponse.json(result);
}
