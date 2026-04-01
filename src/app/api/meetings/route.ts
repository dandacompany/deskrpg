import { db } from "@/db";
import { meetingMinutes, channelMembers, channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { resolveMeetingMinutesAccess } from "./meeting-access";
import { normalizeMeetingMinutesRecord } from "@/lib/meeting-minutes";

export async function GET(req: NextRequest) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const channelId = req.nextUrl.searchParams.get("channelId");
  if (!channelId) {
    return NextResponse.json({ errorCode: "channel_id_required", error: "channelId required" }, { status: 400 });
  }

  const access = await resolveMeetingMinutesAccess({
    userId,
    channelId,
    deps: {
      loadChannelOwner: async (channelIdToLoad) => {
        const [channel] = await db.select({ ownerId: channels.ownerId }).from(channels).where(eq(channels.id, channelIdToLoad)).limit(1);
        return channel?.ownerId ?? null;
      },
      loadMembership: async (channelIdToLoad, userIdToLoad) => {
        const [member] = await db.select({ role: channelMembers.role }).from(channelMembers)
          .where(and(eq(channelMembers.channelId, channelIdToLoad), eq(channelMembers.userId, userIdToLoad))).limit(1);
        return Boolean(member);
      },
    },
  });

  if (!access.ok) {
    return NextResponse.json({ errorCode: access.errorCode, error: access.error }, { status: access.status });
  }

  try {
    const rows = await db.select({
      id: meetingMinutes.id,
      topic: meetingMinutes.topic,
      totalTurns: meetingMinutes.totalTurns,
      durationSeconds: meetingMinutes.durationSeconds,
      participants: meetingMinutes.participants,
      keyTopics: meetingMinutes.keyTopics,
      createdAt: meetingMinutes.createdAt,
    }).from(meetingMinutes)
      .where(eq(meetingMinutes.channelId, channelId))
      .orderBy(desc(meetingMinutes.createdAt))
      .limit(50);

    return NextResponse.json({ minutes: rows.map((row) => normalizeMeetingMinutesRecord(row)) });
  } catch (err) {
    console.error("Failed to fetch meetings:", err);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_meetings", error: "Failed to fetch meetings" },
      { status: 500 },
    );
  }
}
