import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tasks, npcs } from "@/db";
import { eq, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });
  }

  const channelId = req.nextUrl.searchParams.get("channelId");
  const npcId = req.nextUrl.searchParams.get("npcId");

  if (!channelId) {
    return NextResponse.json({ errorCode: "channel_id_required", error: "channelId required" }, { status: 400 });
  }

  try {
    if (npcId) {
      const result = await db
        .select()
        .from(tasks)
        .where(eq(tasks.npcId, npcId))
        .orderBy(desc(tasks.createdAt));
      return NextResponse.json(result);
    }

    const result = await db
      .select({
        id: tasks.id,
        channelId: tasks.channelId,
        npcId: tasks.npcId,
        assignerId: tasks.assignerId,
        npcTaskId: tasks.npcTaskId,
        title: tasks.title,
        summary: tasks.summary,
        status: tasks.status,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        completedAt: tasks.completedAt,
        npcName: npcs.name,
      })
      .from(tasks)
      .leftJoin(npcs, eq(tasks.npcId, npcs.id))
      .where(eq(tasks.channelId, channelId))
      .orderBy(desc(tasks.createdAt));

    return NextResponse.json(result);
  } catch (err) {
    console.error("[Tasks API] Error:", err);
    return NextResponse.json({ errorCode: "internal_server_error", error: "Internal server error" }, { status: 500 });
  }
}
