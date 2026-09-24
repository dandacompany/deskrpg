import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, channels, jsonForDb, meetingMinutes } from "@/db";
import { getUserId } from "@/lib/internal-rpc";
import { normalizeMeetingMinutesRecord } from "@/lib/meeting-minutes";
import { getMeetingHooks } from "@/lib/meeting-registry";
import { resummarizeMinutes } from "@/lib/meeting-summarize";

/** Rebuild the summary from the stored transcript. Meeting host and channel owner only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const result = await resummarizeMinutes(
      { minutesId: id, userId },
      {
        loadMinutes: async (minutesId) => {
          const [row] = await db
            .select()
            .from(meetingMinutes)
            .where(eq(meetingMinutes.id, minutesId))
            .limit(1);
          return row ? normalizeMeetingMinutesRecord(row) : null;
        },
        loadChannelOwner: async (channelId) => {
          const [channel] = await db
            .select({ ownerId: channels.ownerId })
            .from(channels)
            .where(eq(channels.id, channelId))
            .limit(1);
          return channel?.ownerId ?? null;
        },
        resummarize: getMeetingHooks()?.resummarize,
        saveSummary: async (minutesId, summary) => {
          await db
            .update(meetingMinutes)
            .set({
              keyTopics: jsonForDb(summary.keyTopics),
              conclusions: summary.conclusions,
              outcomeJson: summary.outcome ? jsonForDb(summary.outcome) : null,
              summaryStatus: summary.status,
            })
            .where(eq(meetingMinutes.id, minutesId));
        },
      },
    );

    if (!result.ok) {
      return NextResponse.json(
        { errorCode: result.errorCode, error: result.errorCode },
        { status: result.status },
      );
    }
    return NextResponse.json({
      summaryStatus: result.summary.status,
      keyTopics: result.summary.keyTopics,
      conclusions: result.summary.conclusions,
      outcome: result.summary.outcome,
    });
  } catch (err) {
    console.error("Failed to resummarize meeting:", err);
    return NextResponse.json(
      { errorCode: "failed_to_summarize", error: "Failed to summarize meeting" },
      { status: 500 },
    );
  }
}
