import { db, channelMembers } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id: channelId } = await params;
  const userId = getUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { x, y } = await req.json();
    if (typeof x !== "number" || typeof y !== "number") {
      return NextResponse.json({ error: "x and y are required" }, { status: 400 });
    }

    await db
      .update(channelMembers)
      .set({ lastX: Math.round(x), lastY: Math.round(y) })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save position:", err);
    return NextResponse.json({ error: "Failed to save position" }, { status: 500 });
  }
}
