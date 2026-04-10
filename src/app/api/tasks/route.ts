import { NextRequest, NextResponse } from "next/server";
import { characters, db, npcs, tasks } from "@/db";
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

export async function POST(req: NextRequest) {
  const userId = req.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ errorCode: "invalid_json", error: "Invalid JSON body" }, { status: 400 });
  }

  const { channelId, title, summary } = body as {
    channelId?: string;
    title?: string;
    summary?: string;
  };

  if (!channelId || !title) {
    return NextResponse.json({ errorCode: "missing_required_field", error: "channelId and title are required" }, { status: 400 });
  }

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return NextResponse.json({ errorCode: "invalid_title", error: "title must not be empty" }, { status: 400 });
  }

  const normalizedTitle = trimmedTitle.slice(0, 200);

  const summaryValue =
    typeof summary === "string" ? (summary.trim() === "" ? null : summary.trim()) : null;

  try {
    const characterRows = await db
      .select()
      .from(characters)
      .where(eq(characters.userId, userId))
      .limit(1);

    const character = characterRows[0];

    if (!character) {
      return NextResponse.json({ errorCode: "character_not_found", error: "Character not found" }, { status: 404 });
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    const npcTaskId = `task-${date}-${rand}`;

    const createdTask = await db
      .insert(tasks)
      .values({
        channelId,
        npcId: null,
        assignerId: character.id,
        npcTaskId,
        title: normalizedTitle,
        summary: summaryValue,
        status: "backlog",
      })
      .returning();

    return NextResponse.json(createdTask[0], { status: 201 });
  } catch (err) {
    console.error("[Tasks API] Error:", err);
    return NextResponse.json({ errorCode: "internal_server_error", error: "Internal server error" }, { status: 500 });
  }
}
