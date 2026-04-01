import { db } from "@/db";
import { meetingMinutes, channelMembers, channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { resolveMeetingMinutesAccess, resolveMeetingMinutesOwnerAccess } from "../meeting-access";
import { normalizeMeetingMinutesRecord } from "@/lib/meeting-minutes";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const [row] = await db.select().from(meetingMinutes).where(eq(meetingMinutes.id, id)).limit(1);
    if (!row) return NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 });

    const access = await resolveMeetingMinutesAccess({
      userId,
      channelId: row.channelId,
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

    return NextResponse.json({ minutes: normalizeMeetingMinutesRecord(row) });
  } catch (err) {
    console.error("Failed to fetch meeting:", err);
    return NextResponse.json(
      { errorCode: "failed_to_fetch_meeting", error: "Failed to fetch meeting" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const [row] = await db.select().from(meetingMinutes).where(eq(meetingMinutes.id, id)).limit(1);
    if (!row) return NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 });

    const access = await resolveMeetingMinutesOwnerAccess({
      userId,
      channelId: row.channelId,
      deps: {
        loadChannelOwner: async (channelIdToLoad) => {
          const [channel] = await db.select({ ownerId: channels.ownerId }).from(channels).where(eq(channels.id, channelIdToLoad)).limit(1);
          return channel?.ownerId ?? null;
        },
        loadMembership: async () => false,
      },
    });

    if (!access.ok) {
      return NextResponse.json({ errorCode: access.errorCode, error: access.error }, { status: access.status });
    }

    await db.delete(meetingMinutes).where(eq(meetingMinutes.id, id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete meeting:", err);
    return NextResponse.json(
      { errorCode: "failed_to_delete_meeting", error: "Failed to delete meeting" },
      { status: 500 },
    );
  }
}
