import { db } from "@/db";
import { meetingMinutes, channelMembers, channels } from "@/db";
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getUserId } from "@/lib/internal-rpc";
import { normalizeLocale, translateServer } from "@/lib/i18n/server";
import { resolveMeetingMinutesAccess } from "../../meeting-access";

function formatMinutesMarkdown(m: {
  topic: string;
  createdAt: Date;
  participants: unknown;
  totalTurns: number;
  durationSeconds: number | null;
  keyTopics: unknown;
  conclusions: string | null;
  transcript: string;
}, locale: string | null | undefined): string {
  const participants = (m.participants as { name: string }[]) || [];
  const keyTopics = (m.keyTopics as string[]) || [];
  const normalizedLocale = normalizeLocale(locale);
  const duration = m.durationSeconds == null
    ? translateServer(normalizedLocale, "minutes.notAvailable")
    : translateServer(normalizedLocale, "meeting.duration", {
      min: Math.floor(m.durationSeconds / 60),
      sec: m.durationSeconds % 60,
    });

  let md = `# ${translateServer(normalizedLocale, "minutes.exportTitle", { topic: m.topic })}\n\n`;
  md += `**${translateServer(normalizedLocale, "meeting.dateLabel")}:** ${new Date(m.createdAt).toLocaleString(normalizedLocale)}\n`;
  md += `**${translateServer(normalizedLocale, "meeting.participantsLabel")}:** ${participants.map((p) => p.name).join(", ")}\n`;
  md += `**${translateServer(normalizedLocale, "meeting.totalTurns")}:** ${m.totalTurns} | **${translateServer(normalizedLocale, "meeting.durationLabel")}:** ${duration}\n\n`;

  if (keyTopics.length > 0) {
    md += `## ${translateServer(normalizedLocale, "meeting.keyTopics")}\n`;
    keyTopics.forEach((topic) => { md += `- ${topic}\n`; });
    md += "\n";
  }

  if (m.conclusions) {
    md += `## ${translateServer(normalizedLocale, "meeting.conclusions")}\n${m.conclusions}\n\n`;
  }

  md += `## ${translateServer(normalizedLocale, "minutes.fullTranscript")}\n${m.transcript}\n`;
  return md;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = getUserId(req);
  if (!userId) {
    return NextResponse.json({ errorCode: "unauthorized", error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const format = req.nextUrl.searchParams.get("format") || "md";
  const locale = req.nextUrl.searchParams.get("locale");

  try {
    const [row] = await db.select().from(meetingMinutes).where(eq(meetingMinutes.id, id)).limit(1);
    if (!row) {
      return NextResponse.json({ errorCode: "not_found", error: "Not found" }, { status: 404 });
    }

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

    const markdown = formatMinutesMarkdown(row, locale);

    if (format === "clipboard") {
      return NextResponse.json({ text: markdown });
    }

    // Default: markdown download
    return new NextResponse(markdown, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="meeting-${id.slice(0, 8)}.md"`,
      },
    });
  } catch (err) {
    console.error("Failed to export meeting:", err);
    return NextResponse.json(
      { errorCode: "failed_to_export_meeting", error: "Failed to export meeting" },
      { status: 500 },
    );
  }
}
